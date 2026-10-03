import { teamRuleToCursorMdc } from './cursor-mdc.js';
import type { RuleFormat } from './rule-format.js';
import {
  expandBraces,
  mergeRuleBodyIntoTeamMd,
  ruleBodyEqualsTeamMd,
  rulePaths,
  teamRuleBody,
  teamRuleData,
} from './team-rule.js';

/**
 * JoyCode project rules (`.joycode/rules/*.mdc`). Its `.mdc` looks like
 * Cursor's, but JoyCode reads it by lines, not YAML (`parseMdcRule` in
 * JoyCoder.joycoder-fe 3.8.71): the `globs:` value is taken as it stands,
 * quotes included, and split on every comma before matching.
 *
 *   - team `paths: [glob, ...]` → `globs: a, b` unquoted + `alwaysApply: false`
 *   - no `paths`                → `alwaysApply: true`
 *
 * So the globs are written unquoted, and a `{a,b}` alternation is expanded
 * into separate globs.
 */
export function teamRuleToJoycodeRule(rawTeamRule: string): string {
  const globs = [...new Set(rulePaths(teamRuleData(rawTeamRule)).flatMap(expandBraces))];
  const frontmatter = globs.length > 0
    ? [`globs: ${globs.join(', ')}`, 'alwaysApply: false']
    : ['alwaysApply: true'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/**
 * The warning for a copy pull kept because the member edited it, while its
 * `globs` are still quoted as Cursor's render wrote them: JoyCode matches the
 * quotes too, so the rule applies to no file. Null for any other copy.
 */
export function joycodeQuotedGlobsWarning(file: string, rawCopy: string): string | null {
  const frontmatter = /^---\s*[\r\n]+([\s\S]*?)\r?\n---/.exec(rawCopy)?.[1] ?? '';
  if (!/^\s*globs:\s*["']/m.test(frontmatter)) return null;
  return `${file} keeps the quoted \`globs\` an older teamai wrote, which JoyCode never matches, so the rule applies to no file. `
    + 'Remove the quotes and write each `{a,b}` alternative as a glob of its own, or delete the file and run `teamai pull --force` to take the team version.';
}

/** JoyCode's rules format. */
export const JOYCODE_RULE_FORMAT: RuleFormat = {
  extension: '.mdc',
  render: teamRuleToJoycodeRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['globs', 'alwaysApply'],
  // An older teamai gave JoyCode Cursor's render.
  previousRenders: [teamRuleToCursorMdc],
};
