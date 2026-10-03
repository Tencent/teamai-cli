import { splitFrontmatter, stringifyFrontmatter } from '../utils/frontmatter.js';
import type { RuleFormat } from './rule-format.js';
import { rulePaths, teamRuleData } from './team-rule.js';

const ALL_FILES_GLOB = '**';

function normalizeBody(body: string): string {
  return body.replace(/^\s+/, '').replace(/\s+$/, '');
}

/** Convert a tool-neutral team rule into Copilot's native instructions format. */
export function teamRuleToCopilotInstructions(rawTeamRule: string): string {
  const { body } = splitFrontmatter(rawTeamRule);
  // `paths:` is read the one way every render reads it (team-rule.ts).
  const paths = rulePaths(teamRuleData(rawTeamRule));
  return stringifyFrontmatter(
    { applyTo: paths.length > 0 ? paths.join(', ') : ALL_FILES_GLOB },
    `\n${normalizeBody(body)}\n`,
  );
}

/**
 * Push only the editable Markdown body back to the team rule. Copilot's
 * `applyTo` field is derived from the team-owned `paths` field and must never
 * replace it.
 */
export function mergeCopilotBodyIntoTeamMd(
  rawCopilotInstructions: string,
  existingTeamMd: string | null,
): string {
  const body = normalizeBody(splitFrontmatter(rawCopilotInstructions).body);
  if (existingTeamMd === null) return `${body}\n`;

  const existing = splitFrontmatter(existingTeamMd);
  if (normalizeBody(existing.body) === body) return existingTeamMd;
  if (!existing.raw) return `${body}\n`;
  return `${existing.raw.endsWith('\n') ? existing.raw : `${existing.raw}\n`}\n${body}\n`;
}

/** Compare Copilot and team rule bodies while ignoring derived frontmatter. */
export function copilotInstructionsBodyEqualsTeamMd(
  rawCopilotInstructions: string,
  rawTeamRule: string,
): boolean {
  return normalizeBody(splitFrontmatter(rawCopilotInstructions).body)
    === normalizeBody(splitFrontmatter(rawTeamRule).body);
}

/** GitHub Copilot's instructions format. */
export const COPILOT_INSTRUCTIONS_FORMAT: RuleFormat = {
  extension: '.instructions.md',
  render: teamRuleToCopilotInstructions,
  bodyEquals: copilotInstructionsBodyEqualsTeamMd,
  mergeBodyIntoTeam: mergeCopilotBodyIntoTeamMd,
  scopeFields: ['applyTo'],
};
