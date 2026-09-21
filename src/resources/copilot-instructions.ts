import { splitFrontmatter, stringifyFrontmatter } from '../utils/frontmatter.js';

const ALL_FILES_GLOB = '**';

function normalizeBody(body: string): string {
  return body.replace(/^\s+/, '').replace(/\s+$/, '');
}

function rulePaths(data: Record<string, unknown>): string[] {
  const value = data.paths;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

/** Convert a tool-neutral team rule into Copilot's native instructions format. */
export function teamRuleToCopilotInstructions(rawTeamRule: string): string {
  const { data, body } = splitFrontmatter(rawTeamRule);
  const paths = rulePaths(data);
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
