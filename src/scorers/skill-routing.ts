/**
 * The routing questions a finished session's skills evidence lets a team ask (#1469): one generated scorer per team
 * skill the session's checkout held as delivered, named `teamai:routing:<skill>` for a root skill and
 * `teamai:routing:<namespace>:<skill>` for one a skills namespace delivered. The names are reserved — a scorer file's
 * name cannot contain `:`. The rubric is teamai's default scorer `scorers/teamai-routing.md`, which a team replaces with
 * a file of that name (`src/default-scorers.ts`).
 *
 * A question's `rubric.sourceHash` covers the rubric with the skill filled in but not its description, so a
 * rewritten description stays in the same measurement; a release or a team file that changes the rubric changes the
 * hash, as a team editing a scorer does. A skill whose namespace the delivery record cannot tell (`namespaceUnknown`) gets no
 * question: its name cannot be told from a same-named skill's, so judging it could judge the other.
 */
import { DefaultScorers } from '../default-scorers.js';
import type { LocalConfig } from '../types.js';
import { defaultScorerRubric, scorerSourceHash } from './cache.js';
import type { GeneratedQuestion, QuestionFamily } from './generated-questions.js';
import { availableTeamSkills, type AvailableSkill } from './skill-evidence.js';

export const ROUTING_PREFIX = 'teamai:routing:';

/** Whether `value` names a routing question, rather than a scorer file, a cached scorer or anything else. */
export function isRoutingScorer(value: string): boolean {
  return value.startsWith(ROUTING_PREFIX);
}

/** The routing question's name of `skill`: `teamai:routing:<skill>`, with `<namespace>:` before the skill's name for a namespaced one. */
export function routingScorerName({ name, namespace }: AvailableSkill): string {
  return namespace === undefined ? `${ROUTING_PREFIX}${name}` : `${ROUTING_PREFIX}${namespace}:${name}`;
}

/** What `value` names, or undefined when it is not a well-formed routing name: `<skill>` or `<namespace>:<skill>`, each a token. */
export function parseRoutingScorer(value: string): { skill: string; namespace?: string } | undefined {
  if (!isRoutingScorer(value)) return undefined;
  const parts = value.slice(ROUTING_PREFIX.length).split(':');

  if (parts.length > 2 || parts.some((part) => part === '')) return undefined;
  const [namespace, skill] = parts.length === 2 ? parts : [undefined, parts[0]];

  return namespace === undefined ? { skill } : { namespace, skill };
}

/** The skill in `available` the parsed name names, or undefined: matched by name and, when the name says one, namespace.
 * A skill whose namespace the delivery record cannot tell is never named: judging it could judge another skill of the
 * same name, so it has no routing question on any path. */
export function routingSkillOf(name: { skill: string; namespace?: string }, available: readonly AvailableSkill[]): AvailableSkill | undefined {
  return available.find((skill) => !skill.namespaceUnknown && skill.name === name.skill && (name.namespace === undefined ? skill.namespace === undefined : skill.namespace === name.namespace));
}

/**
 * The routing question of `skill`, `rubric` filled in with its name: the text of teamai's default
 * `scorers/teamai-routing.md`, or the team's file of that name. The rubric names the skill and says
 * where to read it; the description the judge judges against stays in `skills.available` in evidence.json.
 */
export function routingScorer(rubric: string, skill: AvailableSkill): GeneratedQuestion {
  const scorer = routingScorerName(skill);
  const { content, definition } = DefaultScorers.fillIn('teamai-routing', { file: `scorers/${scorer.replaceAll(':', '-')}.md`, content: rubric }, { 'skill.name': skill.name });

  return { scorer, pin: { sourceHash: scorerSourceHash(content), content }, definition: { ...definition, name: scorer } };
}

/** Every routing question of `skills`, in `skills.available` order: one per skill whose namespace the record can tell. */
export async function routingScorers(config: LocalConfig, skills: readonly AvailableSkill[]): Promise<GeneratedQuestion[]> {
  const asked = skills.filter((skill) => !skill.namespaceUnknown);

  if (asked.length === 0) return [];
  const { content: rubric } = await defaultScorerRubric(config, 'teamai-routing');

  return asked.map((skill) => routingScorer(rubric, skill));
}

/** Why the parsed routing name `parsed` names no question among `available`, as `routingQuestionOf` says it. */
function unroutedWhy(parsed: { skill: string } | undefined, available: readonly AvailableSkill[] | undefined): string {
  if (available === undefined) return 'The session\'s captures record no delivered team skills, so no routing question can name one.';

  if (available.length === 0) return 'The session\'s checkout held no team skills.';

  if (parsed && available.some(({ name, namespaceUnknown }) => namespaceUnknown && name === parsed.skill)) {
    return `Its delivery record cannot tell the namespace of team skill ${parsed.skill}, so judging it could judge another skill of the same name: it has no routing question.`;
  }

  return `It names no team skill in this session's skills.available: ${available.filter(({ namespaceUnknown }) => !namespaceUnknown).map(routingScorerName).join(', ')}.`;
}

/**
 * The routing question `value` names among `available`, the team skills a session's captures delivered (undefined
 * when they record none), or why it names none of them. It resolves whatever `skill_routing` says.
 */
export async function routingQuestionOf(config: LocalConfig, value: string, available: readonly AvailableSkill[] | undefined): Promise<{ ok: true; question: GeneratedQuestion } | { ok: false; why: string }> {
  const parsed = parseRoutingScorer(value);
  const skill = parsed && available !== undefined ? routingSkillOf(parsed, available) : undefined;

  if (skill === undefined) return { ok: false, why: unroutedWhy(parsed, available) };
  const question = routingScorer((await defaultScorerRubric(config, 'teamai-routing')).content, skill);

  return question.scorer === value ? { ok: true, question } : { ok: false, why: `It names ${question.scorer}.` };
}

/** The routing family of generated questions: one per team skill a session's captures delivered, while `skill_routing` is on. */
export const routingQuestions: QuestionFamily = {
  prefix: ROUTING_PREFIX,
  noun: 'routing question',
  switch: 'skillRouting',
  questions: async (config, { captures }) => routingScorers(config, availableTeamSkills(captures) ?? []),
  questionOf: async (config, name, session) => routingQuestionOf(config, name, session === undefined ? undefined : availableTeamSkills(session.captures)),
};
