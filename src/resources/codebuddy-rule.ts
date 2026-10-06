import type { RuleFormat } from './rule-format.js';
import { mergeRuleBodyIntoTeamMd, ruleBodyEqualsTeamMd, rulePaths, teamRuleBody, teamRuleData, verbatimRule } from './team-rule.js';

/**
 * CodeBuddy rule files (`.codebuddy/rules/*.md`, `~/.codebuddy/rules/*.md`),
 * which WorkBuddy reads too, in the same engine
 * (https://www.codebuddy.ai/docs/cli/memory):
 *
 *   - team `paths: [glob, ...]` → `alwaysApply: false` + `paths:` as a block list
 *   - no `paths`                → `alwaysApply: true`
 *
 * CodeBuddy's frontmatter parser reads lines, not YAML: an inline
 * `paths: ["a", "b"]` becomes globs with the brackets and quotes in them, so
 * the render always writes a block list, one quoted glob per item (the parser
 * strips the quotes). An item is never split on its commas, so a brace glob
 * stays whole.
 */
export function teamRuleToCodebuddyRule(rawTeamRule: string): string {
  const paths = rulePaths(teamRuleData(rawTeamRule));
  const frontmatter = paths.length > 0
    ? ['alwaysApply: false', 'paths:', ...paths.map((glob) => `  - ${JSON.stringify(glob)}`)]
    : ['alwaysApply: true'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** CodeBuddy's rules format, which WorkBuddy shares. */
export const CODEBUDDY_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToCodebuddyRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['alwaysApply', 'paths'],
  // An older teamai copied the team rule verbatim.
  previousRenders: [verbatimRule],
};
