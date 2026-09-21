/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. Most tools take
 * a verbatim `.md` copy. Cursor and JoyCode use `.mdc` rules, while GitHub
 * Copilot CLI uses `.instructions.md`; those copies carry native frontmatter.
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, or deletes files in a tool's rules directory must go through it, so a
 * new per-tool extension never has to be re-discovered call site by call site.
 */

const CURSOR_MDC_RULE_TOOLS = new Set(['cursor', 'joycode']);
const COPILOT_INSTRUCTIONS_RULE_TOOLS = new Set(['copilot']);

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): '.md' | '.mdc' | '.instructions.md' {
  if (usesCursorMdcRules(tool)) return '.mdc';
  return usesCopilotInstructions(tool) ? '.instructions.md' : '.md';
}

/** True when the tool stores rules in Cursor-compatible `.mdc` format. */
export function usesCursorMdcRules(tool: string): boolean {
  return CURSOR_MDC_RULE_TOOLS.has(tool);
}

/** True when the tool stores rules as GitHub Copilot instruction files. */
export function usesCopilotInstructions(tool: string): boolean {
  return COPILOT_INSTRUCTIONS_RULE_TOOLS.has(tool);
}

/**
 * Every extension a rule file may carry on disk, newest layout first.
 *
 * Writers use `ruleFileExtensionForTool`; scanners and deleters use this list so
 * they also see copies left by an older teamai layout (e.g. `.cursor/rules/*.md`
 * written before Cursor rules moved to `.mdc`).
 */
export const RULE_FILE_EXTENSIONS = ['.instructions.md', '.mdc', '.md'] as const;

/**
 * Extract a rule name stem from a filename, accepting any supported extension.
 * Returns null for files that are not rule files.
 */
export function ruleStemFromFilename(filename: string): string | null {
  if (filename.endsWith('.instructions.md')) return filename.slice(0, -'.instructions.md'.length);
  if (filename.endsWith('.mdc')) return filename.slice(0, -'.mdc'.length);
  if (filename.endsWith('.md')) return filename.slice(0, -'.md'.length);
  return null;
}

/**
 * True when `filename` is a copy left in an `.mdc` rules directory by an older
 * teamai layout: the target tool never reads `.md` there, so such a file is inert
 * leftover rather than an active rule.
 */
export function isLegacyCursorRuleFile(tool: string, filename: string): boolean {
  return usesCursorMdcRules(tool) && filename.endsWith('.md');
}
