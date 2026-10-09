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
 * Trae rules (`.trae/rules/*.md` in a project, `~/.trae/user_rules/*.md` for
 * the user; `~/.trae-cn` on the CN build). Trae's bundled parser reads the
 * frontmatter by lines, not YAML: `globs` is taken as it stands and split on
 * every comma (quotes included, so the globs are written unquoted), and
 * `alwaysApply` compares the lowercased line to "true".
 *
 *   - team `paths: [glob, ...]` → `globs: a, b` unquoted + `alwaysApply: false`
 *   - no `paths`                → `alwaysApply: true`
 *
 * A `{a,b}` alternation is expanded into separate globs, as for JoyCode.
 */
export function teamRuleToTraeRule(rawTeamRule: string): string {
  const globs = [...new Set(rulePaths(teamRuleData(rawTeamRule)).flatMap(expandBraces))];
  const frontmatter = globs.length > 0
    ? [`globs: ${globs.join(', ')}`, 'alwaysApply: false']
    : ['alwaysApply: true'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** Trae's rules format, shared by the international and CN builds. */
export const TRAE_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToTraeRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['globs', 'alwaysApply'],
  // A team that had configured `trae` in toolPaths before this format existed
  // got the team `.md` verbatim.
  previousRenders: [verbatimRule],
};
