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
import { findGitBashWindows } from './bundled-runtime.js';

const CURSOR_MARKER = '--tool cursor';
const COPILOT_MARKER = '--tool copilot';

/**
 * The [event, matcher, command] entries Copilot runs from a parsed hook file.
 * Copilot loads only version 1 files and runs none of a file's hooks under
 * `disableAllHooks`, so any other file yields nothing. Every check of what
 * Copilot runs goes through this one predicate. The shell guard runs the same
 * logic from COPILOT_RUNS_ENTRIES_SOURCE; claude-hook-host.test.ts runs both.
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

// copilotRunsEntries as plain JavaScript, for the shell guard. A fixed string,
// not copilotRunsEntries.toString(): the bundler may rename the function's
// locals, which would change every Claude team hook command and its hash.
// The text is what earlier releases emitted, so existing hooks stay unchanged.
export const COPILOT_RUNS_ENTRIES_SOURCE = [
  'function copilotRunsEntries(data) {',
  '  const file = data;',
  '  if (file?.version !== 1 || file.disableAllHooks || !file.hooks || typeof file.hooks !== "object") return [];',
  '  return Object.entries(file.hooks).flatMap(([event, entries]) => !Array.isArray(entries) ? [] : entries.filter((entry) => entry?.type === "command").flatMap((entry) => [entry.bash, entry.powershell, entry.command].filter((command) => typeof command === "string").map((command) => [event, entry.matcher, command])));',
  '}',
].join('\n');

// Shell guards run outside the CLI, so read Copilot's project hook files with Node.
// argv[2] is copilotCopyKey of the team hook; a file Copilot runs must hold it.
const PROJECT_COPILOT_COPY_CHECK = [
  'const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");',
  `const runs = ${COPILOT_RUNS_ENTRIES_SOURCE};`,
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

/** Quote a value for a PowerShell single-quoted string. */
function powershellQuoteValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** PowerShell equivalent of the Cursor/Copilot guard for native Windows hooks. */
const POWERSHELL_CURSOR_HOOK_SKIP =
  'if ($env:CURSOR_VERSION) { $teamaiHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }; $files = @(); if ($teamaiHome) { $files += Join-Path (Join-Path $teamaiHome ".cursor") "hooks.json" }; if ($env:CURSOR_PROJECT_DIR) { $files += Join-Path (Join-Path $env:CURSOR_PROJECT_DIR ".cursor") "hooks.json" }; foreach ($file in $files) { if (Select-String -LiteralPath $file -SimpleMatch "--tool cursor" -Quiet -ErrorAction SilentlyContinue) { exit 0 } } }; ';

function powershellProjectCopilotCopyCheck(event: string, matcher: string | undefined, command: string): string {
  const expectedMatcher = matcher && matcher !== '*' ? matcher : '';
  return [
    '$teamaiHooks = Join-Path (Join-Path $env:COPILOT_PROJECT_DIR ".github") "hooks";',
    'Get-ChildItem -LiteralPath $teamaiHooks -Filter "*.json" -File -ErrorAction SilentlyContinue | ForEach-Object {',
    'try { $teamaiFile = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return };',
    '$teamaiVersion = $teamaiFile.version;',
    'if ($null -eq $teamaiVersion -or $teamaiVersion -is [string] -or $teamaiVersion -is [bool] -or $teamaiVersion -ne 1 -or $teamaiFile.disableAllHooks -or $null -eq $teamaiFile.hooks -or $teamaiFile.hooks -is [array] -or $teamaiFile.hooks -is [string]) { return };',
    `$teamaiEntries = @($teamaiFile.hooks.PSObject.Properties | Where-Object { $_.Name -ceq ${powershellQuoteValue(event)} } | ForEach-Object { if ($_.Value -is [array]) { $_.Value } });`,
    'foreach ($teamaiEntry in $teamaiEntries) {',
    '$teamaiMatcher = if ($null -eq $teamaiEntry.matcher -or $teamaiEntry.matcher -ceq "*") { "" } else { [string]$teamaiEntry.matcher };',
    `$teamaiCommands = @($teamaiEntry.bash, $teamaiEntry.powershell, $teamaiEntry.command); if ($teamaiEntry.type -ceq "command" -and $teamaiMatcher -ceq ${powershellQuoteValue(expectedMatcher)} -and $teamaiCommands -ccontains ${powershellQuoteValue(command)}) { exit 0 }`,
    '}',
    '}; ',
  ].join(' ');
}

/**
 * A native Windows Claude entry declares PowerShell explicitly, so it stays
 * runnable regardless of which shell invokes `teamai` or later reads a shared
 * settings file. Git Bash entries keep the POSIX command and need no override.
 */
export function claudeHookUsesPowerShell(
  platform: NodeJS.Platform = process.platform,
  gitBashPath: string | null | undefined = platform === 'win32' ? findGitBashWindows() : null,
): boolean {
  return platform === 'win32' && !gitBashPath;
}

const CURSOR_HOOK_SKIP =
  'if [ -n "$CURSOR_VERSION" ] && { home="${HOME:-$USERPROFILE}"; [ -n "$home" ] && { grep -q -- \'--tool cursor\' "$home/.cursor/hooks.json" 2>/dev/null || { [ -n "$CURSOR_PROJECT_DIR" ] && grep -q -- \'--tool cursor\' "$CURSOR_PROJECT_DIR/.cursor/hooks.json" 2>/dev/null; }; }; }; then exit 0; fi; ';

/** Exact prefix emitted before Copilot built-ins moved to user scope. */
const LEGACY_POSIX_CLAUDE_HOOK_OTHER_HOST_SKIP = CURSOR_HOOK_SKIP
  + 'if [ -n "$COPILOT_PROJECT_DIR" ] && grep -q -- \'--tool copilot\' "$COPILOT_PROJECT_DIR/.github/hooks/teamai.json" 2>/dev/null; then exit 0; fi; ';

/**
 * The legacy form is intentionally always POSIX: releases before #1498 wrote
 * only this command, including on Windows. Keeping it recognisable lets a
 * current pull replace the old teamai entry rather than leaving a duplicate.
 */
export const LEGACY_CLAUDE_HOOK_OTHER_HOST_SKIP = LEGACY_POSIX_CLAUDE_HOOK_OTHER_HOST_SKIP;

/**
 * Prefix for a Claude team command. The generated command must use the shell
 * that Claude invokes on the member's machine: PowerShell on native Windows,
 * POSIX shell elsewhere (including Git Bash on Windows).
 */
export function claudeHookOtherHostSkip(
  copilotEvent: string | undefined,
  copilotMatcher: string | undefined,
  command: string,
  platform: NodeJS.Platform = process.platform,
  gitBashPath: string | null | undefined = platform === 'win32' ? findGitBashWindows() : null,
): string {
  if (!claudeHookUsesPowerShell(platform, gitBashPath)) {
    if (!copilotEvent) return CURSOR_HOOK_SKIP;
    return CURSOR_HOOK_SKIP + 'if [ -n "$COPILOT_PROJECT_DIR" ] && node -e ' + shellQuoteValue(PROJECT_COPILOT_COPY_CHECK) + ' '
      + `"$COPILOT_PROJECT_DIR/.github/hooks" ${copilotCopyKey(copilotEvent, copilotMatcher, command)} 2>/dev/null; then exit 0; fi; `;
  }

  if (!copilotEvent) return POWERSHELL_CURSOR_HOOK_SKIP;
  return POWERSHELL_CURSOR_HOOK_SKIP + 'if ($env:COPILOT_PROJECT_DIR) { '
    + powershellProjectCopilotCopyCheck(copilotEvent, copilotMatcher, command)
    + '}; ';
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
