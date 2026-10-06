import type { RuleFormat } from './rule-format.js';
import { mergeRuleBodyIntoTeamMd, ruleBodyEqualsTeamMd, rulePaths, teamRuleBody, teamRuleData, verbatimRule } from './team-rule.js';

/**
 * Kiro steering files (`.kiro/steering/*.md`, `~/.kiro/steering/*.md`) choose
 * when they load from their own frontmatter, which must open the file
 * (https://kiro.dev/docs/steering/):
 *
 *   - team `paths: [glob, ...]` → `inclusion: fileMatch` + `fileMatchPattern: ["glob", ...]`
 *   - no `paths`                → `inclusion: always`
 *
 * Kiro ignores `paths:`, so a verbatim copy of a scoped rule was always on.
 * The pattern is always a list, Kiro's documented form for several globs, so
 * a brace glob stays one entry.
 *
 * Kiro reads only the top level of its steering directory
 * (https://github.com/kirodotdev/Kiro/issues/10448), so a namespaced rule is
 * written flat (`flat`): `rules/fe/style.md` becomes `fe.style.md`.
 */
export function teamRuleToKiroSteering(rawTeamRule: string): string {
  const paths = rulePaths(teamRuleData(rawTeamRule));
  const frontmatter = paths.length > 0
    ? ['inclusion: fileMatch', `fileMatchPattern: [${paths.map((glob) => JSON.stringify(glob)).join(', ')}]`]
    : ['inclusion: always'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** Kiro's steering format. */
export const KIRO_STEERING_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToKiroSteering,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['inclusion', 'fileMatchPattern'],
  // An older teamai copied the team rule verbatim.
  previousRenders: [verbatimRule],
  // Kiro does not read steering subdirectories (kirodotdev/Kiro#10448).
  flat: true,
};
