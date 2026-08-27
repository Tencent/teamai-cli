/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. Most tools take
 * a verbatim `.md` copy, but Cursor only reads `.cursor/rules/*.mdc` — a plain
 * `.md` placed there is silently ignored — so its copies carry the `.mdc`
 * extension and machine-derived frontmatter (see `./cursor-mdc.ts`).
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, or deletes files in a tool's rules directory must go through it, so a
 * new per-tool extension never has to be re-discovered call site by call site.
 */

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): '.md' | '.mdc' {
  return tool === 'cursor' ? '.mdc' : '.md';
}

/** True when the tool stores rules in Cursor's `.mdc` format. */
export function usesCursorMdcRules(tool: string): boolean {
  return tool === 'cursor';
}

/**
 * Every extension a rule file may carry on disk, newest layout first.
 *
 * Writers use `ruleFileExtensionForTool`; scanners and deleters use this list so
 * they also see copies left by an older teamai layout (e.g. `.cursor/rules/*.md`
 * written before Cursor rules moved to `.mdc`).
 */
export const RULE_FILE_EXTENSIONS = ['.mdc', '.md'] as const;

/**
 * Extract a rule name stem from a filename, accepting either extension.
 * Returns null for files that are not rule files.
 */
export function ruleStemFromFilename(filename: string): string | null {
  if (filename.endsWith('.mdc')) return filename.slice(0, -'.mdc'.length);
  if (filename.endsWith('.md')) return filename.slice(0, -'.md'.length);
  return null;
}

/**
 * True when `filename` is a copy left in a Cursor rules directory by an older
 * teamai layout: Cursor never reads `.md` there, so such a file is inert
 * leftover rather than an active rule.
 */
export function isLegacyCursorRuleFile(tool: string, filename: string): boolean {
  return usesCursorMdcRules(tool) && filename.endsWith('.md');
}
