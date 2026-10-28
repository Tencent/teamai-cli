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
 * Antigravity CLI rules (`<root>/.agents/rules`, `~/.gemini/config/rules`).
 * agy 1.4.8 skips a rule with no `trigger`, and its CLI never shows the model
 * a `trigger: glob` rule. It lists a `model_decision` rule by its description,
 * and the model reads it for a file the description names:
 *
 *   - team `paths: [glob, ...]` → `trigger: model_decision` + a description naming the globs
 *   - no `paths`                → `trigger: always_on`
 */
export function teamRuleToAgyRule(rawTeamRule: string): string {
  const globs = [...new Set(rulePaths(teamRuleData(rawTeamRule)).flatMap(expandBraces))];
  const frontmatter = globs.length > 0
    ? ['trigger: model_decision', `description: ${JSON.stringify(`Applies when reading or editing files matching ${globs.join(', ')}`)}`]
    : ['trigger: always_on'];
  return `---\n${frontmatter.join('\n')}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** Antigravity CLI's rules format. */
export const AGY_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToAgyRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['trigger', 'description'],
  // A team with a custom `toolPaths.agy` got the team `.md` verbatim.
  previousRenders: [verbatimRule],
};
