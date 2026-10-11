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

// Shell guards run outside the CLI, so validate native global hook files with Node.
const ACTIVE_GLOBAL_COPILOT_CHECK = [
  'const fs = require("node:fs"), path = require("node:path");',
  'try { process.exit(fs.readdirSync(process.argv[1]).some(name => {',
  'if (!name.endsWith(".json")) return false;',
  'try { const data = JSON.parse(fs.readFileSync(path.join(process.argv[1], name), "utf8"));',
  'return data?.version === 1 && !data.disableAllHooks && Object.values(data.hooks ?? {}).some(entries =>',
  'Array.isArray(entries) && entries.some(entry => entry?.type === "command" &&',
  '[entry.bash, entry.powershell, entry.command].some(command => typeof command === "string" && command.includes("--tool copilot"))));',
  '} catch { return false; } }) ? 0 : 1); } catch { process.exit(1); }',
].join(' ');

const CURSOR_HOOK_SKIP =
  'if [ -n "$CURSOR_VERSION" ] && { home="${HOME:-$USERPROFILE}"; [ -n "$home" ] && { grep -q -- \'--tool cursor\' "$home/.cursor/hooks.json" 2>/dev/null || { [ -n "$CURSOR_PROJECT_DIR" ] && grep -q -- \'--tool cursor\' "$CURSOR_PROJECT_DIR/.cursor/hooks.json" 2>/dev/null; }; }; }; then exit 0; fi; ';

/** Exact prefix emitted before Copilot built-ins moved to user scope. */
export const LEGACY_CLAUDE_HOOK_OTHER_HOST_SKIP = CURSOR_HOOK_SKIP
  + 'if [ -n "$COPILOT_PROJECT_DIR" ] && grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR/.github/hooks/teamai.json" 2>/dev/null; then exit 0; fi; ';

export function claudeHookOtherHostSkip(includeGlobalCopilot = true): string {
  const global = includeGlobalCopilot
    ? 'copilot_home="${COPILOT_HOME:-${HOME:-$USERPROFILE}/.copilot}"; node -e \'' + ACTIVE_GLOBAL_COPILOT_CHECK + '\' "$copilot_home/hooks" 2>/dev/null || '
    : '';
  return CURSOR_HOOK_SKIP + 'if [ -n "$COPILOT_PROJECT_DIR" ] && { ' + global
    + 'grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR"/.github/hooks/*.json 2>/dev/null; }; then exit 0; fi; ';
}

export const CLAUDE_HOOK_OTHER_HOST_SKIP = claudeHookOtherHostSkip();

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

/** Copilot loads every JSON hook file in these directories, including configured filenames. */
function copilotHooksInstalled(dir: string, activeOnly = false): boolean {
  try {
    return fs.readdirSync(dir).some(name => {
      if (!name.endsWith('.json')) return false;
      const file = path.join(dir, name);
      if (!activeOnly) return fileHasMarker(file, COPILOT_MARKER);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data?.version === 1 && !data.disableAllHooks && Object.values(data.hooks ?? {}).some(entries =>
          Array.isArray(entries) && entries.some(entry => entry?.type === 'command' &&
            [entry.bash, entry.powershell, entry.command].some(command => typeof command === 'string' && command.includes(COPILOT_MARKER))));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function copilotCopyInstalled(env: NodeJS.ProcessEnv, includeGlobal: boolean): boolean {
  const project = env.COPILOT_PROJECT_DIR?.trim();
  if (!project) return false;
  const home = homeDir(env);
  const copilotHome = env.COPILOT_HOME?.trim() || (home ? path.join(home, '.copilot') : undefined);
  return (includeGlobal && copilotHome !== undefined && copilotHooksInstalled(path.join(copilotHome, 'hooks'), true))
    || copilotHooksInstalled(path.join(project, '.github', 'hooks'));
}

export function claudeHookRunsInAnotherHost(tool: string, env: NodeJS.ProcessEnv = process.env, includeGlobalCopilot = true): boolean {
  if (tool !== 'claude') return false;
  if (env.CURSOR_VERSION && cursorCopyInstalled(env)) return true;
  if (env.COPILOT_PROJECT_DIR && copilotCopyInstalled(env, includeGlobalCopilot)) return true;
  return false;
}
