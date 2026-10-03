import type { RuleFormat } from './rule-format.js';
import { mergeRuleBodyIntoTeamMd, ruleBodyEqualsTeamMd, rulePaths, teamRuleBody, teamRuleData, verbatimRule } from './team-rule.js';

/**
 * Oh My Pi rules (`.omp/rules/*.md`, `~/.omp/agent/rules/*.md`), in the
 * frontmatter OMP 18.2.1 buckets rules by (`bucketRules`):
 *
 *   - no `paths`                → `alwaysApply: true`: the text is in every prompt
 *   - team `paths: [glob, ...]` → `globs` + `description`: listed in the
 *     prompt's rulebook as `name (globs): description`, read on demand
 *
 * OMP drops a rule with neither `alwaysApply` nor a `description`, which is
 * what every verbatim copy was, so a description is generated
 * (`ruleDescription`). The globs are a list, so a brace glob stays one entry.
 *
 * OMP lists `*.md` at the top of its rules directory only, so a namespaced
 * rule is written flat (`flat`): `rules/fe/style.md` becomes `fe.style.md`.
 * It reads `.omp/rules` only in the directory the session starts in.
 */
export function teamRuleToOmpRule(rawTeamRule: string): string {
  const paths = rulePaths(teamRuleData(rawTeamRule));
  const body = teamRuleBody(rawTeamRule);
  const frontmatter = paths.length > 0
    ? [
      `description: ${JSON.stringify(ruleDescription(body, paths))}`,
      `globs: [${paths.map((glob) => JSON.stringify(glob)).join(', ')}]`,
    ]
    : ['alwaysApply: true'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`;
}

/**
 * What the rulebook names a scoped rule by: its first Markdown heading, or a
 * neutral line naming its globs. Not its first line of text, which is often
 * the instruction itself and would then sit in every prompt.
 */
function ruleDescription(body: string, paths: readonly string[]): string {
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) return heading[1];
  }
  return `Team rule for files matching ${paths.join(', ')}`;
}

/** Oh My Pi's rules format. */
export const OMP_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToOmpRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['alwaysApply', 'globs', 'description'],
  // An older teamai copied the team rule verbatim.
  previousRenders: [verbatimRule],
  flat: true,
};
