/**
 * Resolve the project working directory from an AI-tool hook payload.
 *
 * Claude Code (and most other hosts) send `cwd`. Cursor SessionStart does not:
 * it sends `workspace_roots: ["<project>"]` instead, and runs the hook process
 * with cwd set to the hooks.json directory (e.g. ~/.cursor). Empty-string `cwd`
 * (seen on some Cursor tool events) is treated as missing.
 */
export function resolveHookCwd(data: Record<string, unknown>): string | undefined {
  if (typeof data.cwd === 'string') {
    const trimmed = data.cwd.trim();
    if (trimmed) return trimmed;
  }
  const roots = data.workspace_roots;
  if (!Array.isArray(roots)) return undefined;
  for (const root of roots) {
    if (typeof root === 'string') {
      const trimmed = root.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}
