import { HookPayloadSchema, type HookPayload } from '../types.js';

/**
 * Resolve the project working directory from an AI-tool hook payload.
 *
 * Claude Code (and most other hosts) send `cwd`. Cursor SessionStart does not:
 * it sends `workspace_roots: ["<project>"]` instead, and runs the hook process
 * with cwd set to the hooks.json directory (e.g. ~/.cursor). Empty-string `cwd`
 * (seen on some Cursor tool events) is treated as missing. The Cursor IDE sends
 * each root as its URI path, so on Windows it arrives as `/c:/...`, which no
 * path API resolves: the leading slash goes.
 */
export function resolveHookCwd(data: HookPayload): string | undefined {
  // Parsed again: a caller may hand over a payload read without the schema.
  const { cwd, workspace_roots: roots } = HookPayloadSchema.parse(data);

  if (cwd !== undefined) {
    const trimmed = cwd.trim();

    if (trimmed) return fromUriPath(trimmed);
  }

  if (roots === undefined) return undefined;

  for (const root of roots) {
    if (root !== null) {
      const trimmed = root.trim();

      if (trimmed) return fromUriPath(trimmed);
    }
  }

  return undefined;
}

function fromUriPath(dir: string): string {
  return /^\/[A-Za-z]:\//.test(dir) ? dir.slice(1) : dir;
}
