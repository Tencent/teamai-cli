import type { RuleFormat } from './rule-format.js';
import {
  expandBraces,
  mergeRuleBodyIntoTeamMd,
  ruleBodyEqualsTeamMd,
  rulePaths,
  teamRuleBody,
  teamRuleData,
  verbatimRule,
} from './team-rule.js';

/**
 * Qoder rules (`.qoder/rules`, `~/.qoder/rules`, `~/.qoder-cn/rules`) in the
 * form Qoder Desktop writes them, which Qoder CLI reads too. Qoder publishes no
 * schema; the form comes from the rule files in `alibaba/tron-one-agent`:
 *
 *   - team `paths: [glob, ...]` → `trigger: glob` + `glob: a, b` on one line
 *   - no `paths`                → `trigger: always_on`
 *
 * The glob line is split on every comma, so a `{a,b}` alternation is expanded
 * into separate globs. It is written unquoted, as Desktop writes it.
 */
export function teamRuleToQoderRule(rawTeamRule: string): string {
  const globs = [...new Set(rulePaths(teamRuleData(rawTeamRule)).flatMap(expandBraces))];
  const frontmatter = globs.length > 0
    ? ['trigger: glob', `glob: ${globs.join(', ')}`]
    : ['trigger: always_on'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** Qoder's rules format, Qoder CN's too. */
export const QODER_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToQoderRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['trigger', 'glob'],
  // An older teamai copied the team rule verbatim.
  previousRenders: [verbatimRule],
};
