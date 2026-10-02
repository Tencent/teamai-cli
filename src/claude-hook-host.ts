/**
 * Claude settings are also loaded by Cursor and, in self mode, by Copilot CLI.
 * Skip that copy only when the other host's own teamai hooks are on disk.
 * A claude-only setup has no replacement, so those hooks must still run.
 *
 * The shell prefix and claudeHookRunsInAnotherHost check the same paths.
 * COPILOT_CLI is not a signal: Copilot sets it on every subprocess.
 * An empty value does not count.
 */
import fs from 'node:fs';
import path from 'node:path';

const CURSOR_MARKER = '--tool cursor';
const COPILOT_MARKER = '--tool copilot';

export const CLAUDE_HOOK_OTHER_HOST_SKIP =
  'if [ -n "$CURSOR_VERSION" ] && { home="${HOME:-$USERPROFILE}"; [ -n "$home" ] && { grep -q -- \'--tool cursor\' "$home/.cursor/hooks.json" 2>/dev/null || { [ -n "$CURSOR_PROJECT_DIR" ] && grep -q -- \'--tool cursor\' "$CURSOR_PROJECT_DIR/.cursor/hooks.json" 2>/dev/null; }; }; }; then exit 0; fi; ' +
  'if [ -n "$COPILOT_PROJECT_DIR" ] && grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR/.github/hooks/teamai.json" 2>/dev/null; then exit 0; fi; ';

function homeDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home || undefined;
}

function fileHasMarker(file: string, marker: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function cursorCopyInstalled(env: NodeJS.ProcessEnv): boolean {
  const home = homeDir(env);
  if (home && fileHasMarker(path.join(home, '.cursor', 'hooks.json'), CURSOR_MARKER)) return true;
  const project = env.CURSOR_PROJECT_DIR?.trim();
  if (project && fileHasMarker(path.join(project, '.cursor', 'hooks.json'), CURSOR_MARKER)) return true;
  return false;
}

function copilotCopyInstalled(env: NodeJS.ProcessEnv): boolean {
  const project = env.COPILOT_PROJECT_DIR?.trim();
  if (!project) return false;
  return fileHasMarker(path.join(project, '.github', 'hooks', 'teamai.json'), COPILOT_MARKER);
}

export function claudeHookRunsInAnotherHost(tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (tool !== 'claude') return false;
  if (env.CURSOR_VERSION && cursorCopyInstalled(env)) return true;
  if (env.COPILOT_PROJECT_DIR && copilotCopyInstalled(env)) return true;
  return false;
}
