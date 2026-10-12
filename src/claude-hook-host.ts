/**
 * Claude settings are also loaded by Cursor and, in self mode, by Copilot CLI.
 * Skip that copy only when the other host's own teamai hooks are on disk.
 * A claude-only setup has no replacement, so those hooks must still run.
 *
 * The shell prefix guards team commands; claudeHookRunsInAnotherHost guards
 * built-ins, which Copilot also runs from its user hook files.
 * COPILOT_CLI is not a signal: Copilot sets it on every subprocess.
 * An empty value does not count.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { shellQuoteValue } from './utils/shell-profile.js';

const CURSOR_MARKER = '--tool cursor';
const COPILOT_MARKER = '--tool copilot';

/**
 * The [event, matcher, command] entries Copilot runs from a parsed hook file.
 * Copilot loads only version 1 files and runs none of a file's hooks under
 * `disableAllHooks`, so any other file yields nothing. Every check of what
 * Copilot runs goes through this one predicate. It stays self-contained:
 * PROJECT_COPILOT_COPY_CHECK embeds its source in the shell guard.
 */
export function copilotRunsEntries(data: unknown): Array<[string, string | undefined, string]> {
  const file = data as { version?: unknown; disableAllHooks?: unknown; hooks?: unknown } | null;
  if (file?.version !== 1 || file.disableAllHooks || !file.hooks || typeof file.hooks !== 'object') return [];
  return Object.entries(file.hooks).flatMap(([event, entries]) => !Array.isArray(entries) ? [] : entries
    .filter(entry => entry?.type === 'command')
    .flatMap(entry => [entry.bash, entry.powershell, entry.command]
      .filter(command => typeof command === 'string')
      .map((command): [string, string | undefined, string] => [event, entry.matcher, command])));
}

// Shell guards run outside the CLI, so read Copilot's project hook files with Node.
// argv[2] is copilotCopyKey of the team hook; a file Copilot runs must hold it.
const PROJECT_COPILOT_COPY_CHECK = [
  'const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");',
  `const runs = ${copilotRunsEntries.toString()};`,
  'const key = (event, matcher, command) => crypto.createHash("sha256")',
  '.update(JSON.stringify([event, matcher && matcher !== "*" ? matcher : "", command])).digest("hex");',
  'try { process.exit(fs.readdirSync(process.argv[1]).some(name => {',
  'if (!name.endsWith(".json")) return false;',
  'try { return runs(JSON.parse(fs.readFileSync(path.join(process.argv[1], name), "utf8")))',
  '.some(([event, matcher, command]) => key(event, matcher, command) === process.argv[2]);',
  '} catch { return false; } }) ? 0 : 1); } catch { process.exit(1); }',
].join(' ');

/** The key PROJECT_COPILOT_COPY_CHECK computes for each entry of a Copilot hook file. */
function copilotCopyKey(event: string, matcher: string | undefined, command: string): string {
  return createHash('sha256').update(JSON.stringify([event, matcher && matcher !== '*' ? matcher : '', command])).digest('hex');
}

const CURSOR_HOOK_SKIP =
  'if [ -n "$CURSOR_VERSION" ] && { home="${HOME:-$USERPROFILE}"; [ -n "$home" ] && { grep -q -- \'--tool cursor\' "$home/.cursor/hooks.json" 2>/dev/null || { [ -n "$CURSOR_PROJECT_DIR" ] && grep -q -- \'--tool cursor\' "$CURSOR_PROJECT_DIR/.cursor/hooks.json" 2>/dev/null; }; }; }; then exit 0; fi; ';

/** Exact prefix emitted before Copilot built-ins moved to user scope. */
export const LEGACY_CLAUDE_HOOK_OTHER_HOST_SKIP = CURSOR_HOOK_SKIP
  + 'if [ -n "$COPILOT_PROJECT_DIR" ] && grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR/.github/hooks/teamai.json" 2>/dev/null; then exit 0; fi; ';

/**
 * Prefix for a Claude team command. Under Copilot it exits only when the
 * event's project delivers the same command to Copilot for the same event and
 * matcher, which then runs it. `copilotEvent` and `copilotMatcher` are the
 * Copilot renderer's for this hook; an event Copilot lacks has no replacement.
 */
export function claudeHookOtherHostSkip(copilotEvent: string | undefined, copilotMatcher: string | undefined, command: string): string {
  if (!copilotEvent) return CURSOR_HOOK_SKIP;
  return CURSOR_HOOK_SKIP + 'if [ -n "$COPILOT_PROJECT_DIR" ] && node -e ' + shellQuoteValue(PROJECT_COPILOT_COPY_CHECK) + ' '
    + `"$COPILOT_PROJECT_DIR/.github/hooks" ${copilotCopyKey(copilotEvent, copilotMatcher, command)} 2>/dev/null; then exit 0; fi; `;
}

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
function copilotHooksInstalled(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(name => {
      if (!name.endsWith('.json')) return false;
      try {
        return copilotRunsEntries(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
          .some(([, , command]) => command.includes(COPILOT_MARKER));
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
  return (includeGlobal && copilotHome !== undefined && copilotHooksInstalled(path.join(copilotHome, 'hooks')))
    || copilotHooksInstalled(path.join(project, '.github', 'hooks'));
}

export function claudeHookRunsInAnotherHost(tool: string, env: NodeJS.ProcessEnv = process.env, includeGlobalCopilot = true): boolean {
  if (tool !== 'claude') return false;
  if (env.CURSOR_VERSION && cursorCopyInstalled(env)) return true;
  if (env.COPILOT_PROJECT_DIR && copilotCopyInstalled(env, includeGlobalCopilot)) return true;
  return false;
}
