import type { RuleFormat } from './rule-format.js';
import {
  mergeRuleBodyIntoTeamMd,
  ruleBodyEqualsTeamMd,
  teamRuleBody,
  teamRuleData,
  verbatimRule,
} from './team-rule.js';

/**
 * Antigravity rules (`<root>/rules/*.md`; `.agents/rules` in a project,
 * `~/.gemini/config/rules` for the user).
 *
 * The CLI parses a rule's frontmatter and requires a `trigger`: a rule file
 * without one is rejected outright — the CLI logs `Invalid rule trigger:
 * CORTEX_MEMORY_TRIGGER_UNSPECIFIED` and the rule never reaches the model.
 * Verified against agy 1.3.4 with the same file twice: verbatim it was dropped
 * (and logged), with `trigger: always_on` it was applied (the model followed
 * it). Team rules are shared and meant to apply in every session, so a team
 * rule that does not declare a trigger of its own is rendered as
 * `always_on`; a rule that does declare one keeps it.
 */
export function teamRuleToAntigravityRule(rawTeamRule: string): string {
  const declared = teamRuleData(rawTeamRule).trigger;
  const trigger = typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : 'always_on';
  return `---\ntrigger: ${trigger}\n---\n\n${teamRuleBody(rawTeamRule)}\n`;
}

/** Antigravity's rules format. */
export const ANTIGRAVITY_RULE_FORMAT: RuleFormat = {
  extension: '.md',
  render: teamRuleToAntigravityRule,
  bodyEquals: ruleBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeRuleBodyIntoTeamMd,
  scopeFields: ['trigger'],
  // A team that had configured `antigravity` in toolPaths before this format
  // existed got the team `.md` verbatim.
  previousRenders: [verbatimRule],
};
