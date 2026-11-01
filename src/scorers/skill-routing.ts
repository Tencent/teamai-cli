/**
 * The routing questions a finished session's skills evidence lets a team ask (#1469): one generated scorer per team
 * skill the session's checkout held as delivered, named `teamai:routing:<skill>` for a root skill and
 * `teamai:routing:<namespace>:<skill>` for one a skills namespace delivered. The names are reserved — a scorer file's
 * name cannot contain `:` — and the rubric ships with teamai, so no team writes it.
 *
 * A question's `rubric.sourceHash` covers the rubric with the skill's name filled in but not its description, so a
 * rewritten description stays in the same measurement; a teamai release that changes the rubric changes the hash, as a
 * team editing a scorer does. A skill whose namespace the delivery record cannot tell (`namespaceUnknown`) gets no
 * question: its name cannot be told from a same-named skill's, so judging it could judge the other.
 */
import { scorerSourceHash } from './cache.js';
import { parseScorer, type ScorerDefinition } from './definition.js';
import type { PinnedScorer } from './pin.js';
import type { AvailableSkill } from './skill-evidence.js';

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

/** The skill in `available` the parsed name names, or undefined: matched by name and, when the name says one, namespace. */
export function routingSkillOf(name: { skill: string; namespace?: string }, available: readonly AvailableSkill[]): AvailableSkill | undefined {
  return available.find((skill) => skill.name === name.skill && (name.namespace === undefined ? skill.namespace === undefined : skill.namespace === name.namespace));
}

/** The rubric of `skill`'s routing question. It names the skill and says where to read it; the description the judge
 * judges against stays in `skills.available` in evidence.json, so the rubric never quotes it. */
function rubricOf(skill: AvailableSkill): string {
  const name = skill.name;
  const from = skill.namespace === undefined ? '' : ` It comes from the \`${skill.namespace}\` skills namespace.`;
  return [
    '---',
    'labels:',
    `  - { value: fit, score: 1, description: ${JSON.stringify(`${name} is in skills.used, and the session needed what its description says.`)} }`,
    `  - { value: idle, score: 1, description: ${JSON.stringify(`${name} is not in skills.used, and the session did not need what its description says, or another skill or the agent's own steps did it.`)} }`,
    `  - { value: extra, score: 0, description: ${JSON.stringify(`${name} is in skills.used, and the session did not need what its description says.`)} }`,
    `  - { value: missed, score: 0, description: ${JSON.stringify(`The session needed what the description of ${name} says, ${name} is not in skills.used, and nothing else did it.`)} }`,
    'passingScore: 1',
    'sessions: true',
    '---',
    '',
    `Judge only the team skill \`${name}\`, against its entry in \`skills.available\` in evidence.json.${from}`,
    '',
  ].join('\n');
}

/** The routing question of `skill`: its scorer name, its pinned rubric, and the definition the rubric parses to. */
export function routingScorer(skill: AvailableSkill): { scorer: string; pin: PinnedScorer; definition: ScorerDefinition } {
  const scorer = routingScorerName(skill);
  const content = rubricOf(skill);
  const sourceHash = scorerSourceHash(content);
  const parsed = parseScorer(`scorers/${scorer.replaceAll(':', '-')}.md`, content);
  if (!parsed.ok) throw new Error(`the routing rubric of ${scorer} does not parse: ${parsed.diagnostics.map(({ message }) => message).join('; ')}`);
  return { scorer, pin: { sourceHash, content }, definition: { ...parsed.definition, name: scorer } };
}

/** Every routing question of `skills`, in `skills.available` order: one per skill whose namespace the record can tell. */
export function routingScorers(skills: readonly AvailableSkill[]): Array<{ scorer: string; pin: PinnedScorer; definition: ScorerDefinition }> {
  return skills.filter(({ namespaceUnknown }) => !namespaceUnknown).map(routingScorer);
}
