import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';
import { isCodexTool } from './utils/tool-names.js';
import type { HookDef } from './types.js';
import { type HookAdapterId, type HooksChannels } from '@teamai/tool-core/definition';
import { baseToolOf, channelsOf, hookFormatOf } from './tool-registry.js';
import { LOGIN_DEFERRED_ENV } from './hook-fast-path.js';
import { getUserHome } from './utils/home.js';
import { log } from './utils/logger.js';
import { bundledShellFor, findGitBashWindows, resetBundledRuntimeCache, resolveCodebuddyNode, resolveWorkbuddyNode } from './bundled-runtime.js';

// ─── Built-in (A) operational hooks as data ─────────────────
//
//  The CLI ships a fixed set of operational hooks (the unified
//  `teamai hook-dispatch <event>` entries). Historically these lived as
//  hardcoded objects in hooks.ts; issue #19 lowers them to `HookDef[]` data so
//  the same reconcile engine drives both built-in and team hooks.
//
//  COMPATIBILITY ANCHOR: the rendered on-disk output of these defs must stay
//  byte-for-byte identical to the previous hardcoded version, so that machines
//  upgrading the CLI see a zero-diff reconcile. Pinned by hooks-golden.test.ts.

// ─── GUI tool PATH wrapper ─────────────────────────────────
//
//  WorkBuddy and CodeBuddy use bundled Node runtimes and their hook
//  subprocesses may lack the user's PATH, so `teamai` is not found.
//  We write a thin wrapper at `~/.teamai/bin/teamai` — plus a `teamai.cmd`
//  next to it on Windows, so a cmd.exe host can still launch the CLI — that
//  invokes the real entry script with the best available Node, then prepend
//  `~/.teamai/bin` to PATH in hook commands for WorkBuddy and CodeBuddy.
//  The PATH is expressed as `$HOME/.teamai/bin` (a shell literal) so that the
//  golden fixture output stays stable across machines.
//  Other tools keep the plain `bash -lc "teamai ..."` form.

export const TEAMAI_BIN_DIR = '.teamai/bin';
const WRAPPER_NAME = 'teamai';
const CODEBUDDY_HOOK_WRAPPER = 'teamai-codebuddy-hook';

/**
 * Whether `tool`'s hook commands need a shell of its own to execute at all
 * (`hooks.shell: 'bundled'`): its hook runner hands the rendered `command`
 * string to a shell instead of an argv vector. Which shell that is depends on
 * the tool (and platform) — see bundled-runtime.ts. Injection is skipped for a
 * tool when no shell resolves, because its hook commands could never run.
 */
export function isShellDependentTool(tool: string): boolean {
  return channelsOf(tool).hooks.shell === 'bundled';
}

/**
 * Check whether /bin/sh exists.  Remote containers (e.g. CloudStudio AI
 * inference nodes) may lack it, causing a POSIX hook runner's
 * `spawn('/bin/sh', ['-c', command])` to fail with ENOENT on every hook
 * invocation.  Shell-dependent tools are exempt — each is covered by its own
 * bundledShellFor entry instead, because the POSIX shell it runs hooks through
 * is not reachable from this process's namespace (WorkBuddy's bundled MSYS sh,
 * CodeBuddy's Git Bash, both on Windows).  Exported so the injection
 * entry points can skip hook installation and warn the user.
 */
let _hasShellCache: boolean | undefined;

export function hasShell(): boolean {
  if (_hasShellCache === undefined) {
    try {
      _hasShellCache = fs.existsSync('/bin/sh');
    } catch {
      _hasShellCache = false;
    }
  }

  return _hasShellCache;
}

/** Reset the cached shell results. Test-only. */
export function _resetShellCache(): void {
  _hasShellCache = undefined;
  _winBashLauncherCache = undefined;
  resetBundledRuntimeCache();
}

/**
 * Resolve the teamai CLI entry script (dist/index.js) by walking up from
 * this module's location. Returns null when resolution fails.
 */
export function resolveTeamaiEntryScript(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const distDir = path.dirname(thisFile);
    const candidate = path.join(distDir, 'index.js');

    if (fs.existsSync(candidate)) return candidate;
  } catch { /* fallback */ }

  return null;
}

/**
 * Resolve the entry to re-spawn the CLI itself with: the one this process is
 * running, else the bundle's own dist/index.js. Some sandboxed hook launchers
 * leave `argv[1]` empty, and a spawn with an empty script path fails silently —
 * so "re-run our own subcommand" resolves through here, everywhere.
 */
export function resolveCliEntry(): string | null {
  return process.argv[1] || resolveTeamaiEntryScript();
}

/** Where `ensureTeamaiWrapper` writes the POSIX `teamai` wrapper. */
export function teamaiWrapperPath(): string {
  return path.join(getUserHome(), TEAMAI_BIN_DIR, WRAPPER_NAME);
}

/** The POSIX wrapper `ensureTeamaiWrapper` writes: it runs `entry` with `node`. */
export function teamaiWrapperSource({ node, entry }: { node: string; entry: string }): string {
  return [
    '#!/bin/sh',
    `# Auto-generated by teamai — do not edit.`,
    `# Wrapper that invokes teamai CLI with a known Node binary so hooks`,
    `# work in environments without PATH (e.g. WorkBuddy GUI subprocess).`,
    '# A hook that deferred its login shell (TEAMAI_HOOK_LOGIN) still runs when the paths below are gone, after',
    '# a Node or teamai reinstall: as a login shell finds teamai, without this directory, and at most once.',
    `if [ "$TEAMAI_HOOK_LOGIN" = deferred ] && { [ ! -x "${node}" ] || [ ! -f "${entry}" ]; }; then`,
    '  [ -z "$TEAMAI_WRAPPER_FALLBACK" ] || exit 127',
    '  TEAMAI_WRAPPER_FALLBACK=1',
    '  export TEAMAI_WRAPPER_FALLBACK',
    '  unset TEAMAI_HOOK_LOGIN',
    '  self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    '  rest=',
    '  old_ifs=$IFS',
    '  IFS=:',
    '  for dir in $PATH; do',
    '    if [ "$dir" = "$self" ]; then continue; fi',
    '    if [ -z "$rest" ]; then rest=$dir; else rest=$rest:$dir; fi',
    '  done',
    '  IFS=$old_ifs',
    '  PATH=$rest',
    '  export PATH',
    `  exec bash -lc 'exec teamai "$@"' teamai "$@"`,
    'fi',
    `exec "${node}" "${entry}" "$@"`,
    '',
  ].join('\n');
}

/**
 * Write the `teamai` wrapper into `~/.teamai/bin`: the POSIX `teamai` sh
 * script, plus a `teamai.cmd` on Windows (cmd.exe resolves commands through
 * PATHEXT, so it can never execute the extensionless sh script). Both invoke
 * the real entry script with the best available Node binary. Idempotent —
 * an init or pull rewrites the one that differs, so the paths stay current after upgrades.
 *
 * Returns the bin directory path, or null if the wrapper could not be created.
 */
export function ensureTeamaiWrapper(): string | null {
  const entryScript = resolveTeamaiEntryScript();

  if (!entryScript) return null;

  const nodeBin = resolveWorkbuddyNode() ?? resolveCodebuddyNode() ?? process.argv[0];
  const wrapperPath = teamaiWrapperPath();
  const binDir = path.dirname(wrapperPath);
  const script = teamaiWrapperSource({ node: nodeBin, entry: entryScript });

  const cmdScript = [
    '@echo off',
    'rem Auto-generated by teamai — do not edit.',
    'rem Wrapper that invokes teamai CLI with a known Node binary so hooks',
    'rem work in environments without PATH (e.g. CodeBuddy IDE hook subprocess).',
    `"${nodeBin}" "${entryScript}" %*`,
    '',
  ].join('\r\n');

  try {
    fs.mkdirSync(binDir, { recursive: true });

    // macOS takes longer over the first run of a new executable file, so a wrapper that already says this stays.
    if (!isWrapperCurrent(wrapperPath, script)) {
      // A hook may run the wrapper at any moment, so it never sees a half-written one.
      const partial = `${wrapperPath}.${process.pid}.tmp`;
      fs.writeFileSync(partial, script, { mode: 0o755 });
      fs.renameSync(partial, wrapperPath);
    }

    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, `${WRAPPER_NAME}.cmd`), cmdScript);
      fs.writeFileSync(path.join(binDir, CODEBUDDY_HOOK_WRAPPER), [
        '#!/bin/sh',
        `"${nodeBin}" "${entryScript}" "$@"`,
        '',
      ].join('\n'), { mode: 0o755 });
    }

    return binDir;
  } catch {
    return null;
  }
}

function isWrapperCurrent(file: string, script: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o111) !== 0 && fs.readFileSync(file, 'utf8') === script;
  } catch {
    return false;
  }
}

/**
 * Per-tool variant of hasShell(). A tool that provides a shell for its hook
 * commands (see bundled-runtime.ts) can execute them even where /bin/sh is
 * absent; everything else keeps the conservative /bin/sh check.
 */
function hasShellFor(tool: string): boolean {
  if (bundledShellFor(tool)) return true;

  return hasShell();
}

/**
 * Gate shell-dependent tools on an executable shell: create the PATH wrapper
 * when any of them has one, warn about the rest, and return the tools that
 * must be skipped (their hook commands could never execute). Non-dependent
 * tools are never included.
 */
export function skipToolsWithoutShell(tools: string[]): Set<string> {
  const skipped = new Set<string>();
  let withShell = false;

  for (const tool of tools) {
    if (!isShellDependentTool(tool)) continue;

    if (hasShellFor(tool)) {
      withShell = true;
    } else {
      skipped.add(tool);
    }
  }

  // Non-login POSIX dispatch must not rely on a project git hook creating this; a login-deferred entry runs it too.
  const nonLoginWrapper = process.platform !== 'win32'
    && tools.some(tool => baseToolOf(tool) === 'zcode' || baseToolOf(tool) === 'dsh' || channelsOf(tool).hooks.loginDeferrable === true) && hasShell();

  if (withShell || nonLoginWrapper) ensureTeamaiWrapper();

  if (skipped.size > 0) {
    log.warn(
      `Skipping hook injection for ${[...skipped].join(', ')}: no shell is available in this environment to execute hooks. ` +
      'Other tools (Claude Code, Cursor) are not affected.',
    );
  }

  return skipped;
}

let _winBashLauncherCache: string | undefined;

/**
 * The shell word to emit in a rendered hook command. POSIX keeps the bare
 * `bash`; Windows substitutes the resolved Git Bash path (quoted, forward
 * slashes so it stays JSON-safe — the default install location contains a
 * space) so the command never reaches the WSL launcher. Falls back to
 * plain `bash` only when Git is absent — there the old form was already
 * dead anyway.
 */
function getHookShellCommand(): string {
  if (process.platform !== 'win32') return 'bash';

  if (_winBashLauncherCache === undefined) {
    const found = findGitBashWindows();

    if (found) {
      _winBashLauncherCache = `"${found.split(path.sep).join('/')}"`;
    } else {
      _winBashLauncherCache = 'bash';
      log.debug('teamai hooks: Git Bash not found on this Windows machine; hook commands keep bare `bash` and may resolve to the WSL launcher.');
    }
  }

  return _winBashLauncherCache;
}

/**
 * Generate the hook-dispatch command for a given event, tool, and optional matcher.
 * A Codex tool keeps bare `bash` on Windows too: Codex runs its Windows form from
 * the entry's `commandWindows` (toCodexEntry in hooks.ts), and a machine-specific
 * Git Bash path here would change the project `hooks.json` a repository commits on
 * every Windows pull.
 */
export function getDispatchCommand(event: string, tool: string, matcher?: string, binPath?: string): string {
  const bin = binPath ?? 'teamai';
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  const shell = isCodexTool(tool) ? 'bash' : getHookShellCommand();

  return `${shell} -lc "${bin} hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null" || true`;
}

/**
 * `getDispatchCommand` with the login shell deferred: through the wrapper when it is there (hook-fast-path.ts
 * `runLoginDeferredHook` runs the login shell where nothing waits for it), else today's command, byte for byte.
 */
function getLoginDeferredDispatchCommand(event: string, tool: string): string {
  const wrapper = `"$HOME/${TEAMAI_BIN_DIR}/${WRAPPER_NAME}"`;
  const today = getDispatchCommand(event, tool).replace(/ \|\| true$/, '');

  return `if [ -x ${wrapper} ]; then ${LOGIN_DEFERRED_ENV}=deferred ${wrapper} hook-dispatch ${event} --tool ${tool} 2>/dev/null; else ${today}; fi || true`;
}

/**
 * Tools whose hook runner on Windows is PowerShell itself, so the rendered
 * command must be PowerShell syntax there rather than the POSIX `bash -lc "…"`
 * form. Two such hosts so far:
 *
 * - DSH: its Claude-compatible bridge hands each command to its own shell,
 *   which on Windows is `@deepseek-ai/dsh-pwsh-local` — a PowerShell runner
 *   that prepends an encoding preamble to the command and parses the result
 *   (issue #1005).
 * Codex also runs command hooks with PowerShell on Windows (issue #1074), but
 * its entries have a Windows-only `commandWindows`, which toCodexEntry in
 * hooks.ts fills with the PowerShell form; its `command` stays the POSIX form
 * on every platform, so a project `.codex/hooks.json` a repository commits does
 * not change with the platform of the member who pulled last.
 */
const WINDOWS_PWSH_TOOLS = new Set(['dsh']);

/**
 * True when this tool's hook runner is PowerShell on this platform, so the
 * rendered command must be PowerShell syntax (getPwshDispatchCommand). Kept
 * platform-gated: POSIX hosts use their shell and TeamAI's PATH wrapper.
 */
export function toolUsesPwshShell(tool: string): boolean {
  return process.platform === 'win32' && WINDOWS_PWSH_TOOLS.has(baseToolOf(tool));
}

/**
 * The command of a team-hook dispatcher entry (#915): it runs the team hooks of
 * the project the hook's cwd belongs to. Unlike the built-ins it keeps stderr
 * and the exit status, which carry a team hook's blocking decision (exit 2).
 * A Codex tool keeps bare `bash` on Windows too: Codex runs its Windows form
 * from the entry's `commandWindows` (getTeamHookDispatchCommandWindows), and a
 * machine-specific Git Bash path here would rewrite a committed hooks.json.
 */
export function getTeamHookDispatchCommand(event: string, tool: string): string {
  const shell = isCodexTool(tool) ? 'bash' : getHookShellCommand();

  return `${shell} -lc "teamai hook-dispatch ${event} --tool ${tool} --team-hooks"`;
}

/**
 * CodeBuddy's project hooks share one settings entry between two Windows
 * runners: the IDE starts it with cmd.exe, while the CLI starts it with Git
 * Bash. Launch the Git-Bash wrapper explicitly, then let hook-dispatch apply
 * the project gate and preserve the team hook's exit status. The arguments are
 * base64url strings emitted by codebuddy-team-hooks.ts, so cmd.exe and Bash can
 * both pass them through without interpreting a project path or shell command.
 */
export function getCodebuddyTeamHookDispatchCommand(
  event: string,
  id: string,
  encodedGate: string,
  encodedCommand: string,
  timeout?: number,
): string {
  const wrapper = path.join(getUserHome(), TEAMAI_BIN_DIR, CODEBUDDY_HOOK_WRAPPER).split(path.sep).join('/');
  const timeoutArg = timeout === undefined ? '' : ` --team-hook-timeout ${timeout}`;

  return `${getHookShellCommand()} "${wrapper}" hook-dispatch ${event} --tool codebuddy --team-hooks`
    + ` --team-hook-id ${id} --team-hook-gate ${encodedGate} --team-hook-command ${encodedCommand}${timeoutArg}`;
}

/**
 * The `commandWindows` of a team-hook dispatcher entry: the bare dispatch,
 * without the POSIX form's bash wrapper. Unlike the built-in fail-open command,
 * this form contains no shell metacharacters, so it is safe for both Codex's
 * cmd.exe fallback and an explicitly configured PowerShell shell. Keeping it
 * bare also preserves the dispatcher's block contract: exit 2 and stderr must
 * reach the host instead of being swallowed (#1209, #1215).
 */
export function getTeamHookDispatchCommandWindows(event: string, tool: string): string {
  return `teamai hook-dispatch ${event} --tool ${tool} --team-hooks`;
}

/**
 * Raw dispatch command without a shell wrapper. Used by ZCode, whose hook
 * entries are `process`-typed (an executable plus an argv vector): the writer
 * puts `bash -c <raw>` into `args` itself, so the wrapper must not be baked
 * into the command string.
 */
export function getRawDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';

  return `teamai hook-dispatch ${event} --tool ${tool}${matcherArg}`;
}

/**
 * Build a hook command that prepends `$HOME/.teamai/bin` to PATH so the
 * wrapper script is found even without the user's login shell PATH.
 * Used by GUI tools (WorkBuddy, CodeBuddy) and POSIX DSH that spawn hook subprocesses
 * with a limited environment. The PATH value uses the `$HOME` shell literal
 * so that golden fixture output stays stable across machines. On Windows,
 * CodeBuddy IDE runs commands in cmd.exe while CodeBuddy CLI uses Git Bash;
 * both can invoke the same explicitly named Git Bash and script.
 */
function getWrapperDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';

  if (baseToolOf(tool) === 'codebuddy' && process.platform === 'win32') {
    const wrapper = path.join(getUserHome(), TEAMAI_BIN_DIR, CODEBUDDY_HOOK_WRAPPER).split(path.sep).join('/');

    return `${getHookShellCommand()} "${wrapper}" hook-dispatch ${event} --tool ${tool}${matcherArg} || exit 0`;
  }

  return `PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null || true`;
}

/**
 * PowerShell counterpart of getDispatchCommand, for tools whose Windows hook
 * runner is PowerShell itself (see WINDOWS_PWSH_TOOLS).
 *
 * Two details carry the POSIX form's contract into PowerShell: `2>$null` is
 * the `/dev/null` redirect, and `; exit 0` is the `|| true` fail-open so a
 * hook that fails never reads as `allowed:false` to the host. The command is
 * emitted bare rather than wrapped in `pwsh -Command "…"` because the host's
 * own shell is already PowerShell — spawning a second one would only add a
 * dependency on `pwsh` being installed. Only the dispatcher tail differs from
 * the bash form, so the dispatching tool and matcher stay byte-identical.
 *
 * Deliberately not used for the GUI tools: WorkBuddy and CodeBuddy reach hook
 * subprocesses with a limited PATH, so they keep the `$HOME/.teamai/bin`
 * wrapper (getWrapperDispatchCommand) their hosts can parse.
 */
function getPwshDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';

  return `teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>$null; exit 0`;
}

/** Canonical, ordered description of each built-in hook. Order is load-bearing
 *  for byte-compat (it fixes array order within each event). */
interface BuiltinHookSpec {
  /** description keyword (stable identity / HookDef.key). */
  key: string;
  /** Claude PascalCase event. */
  event: string;
  /** hook-dispatch sub-event passed to the command. */
  dispatchEvent: string;
  /** matcher ("*" = wildcard, no --matcher arg, omitted in Cursor output). */
  matcher: string;
  /** Per-hook timeout in seconds (rendered for Cursor and WorkBuddy). */
  timeoutSec: number;
}

/** The PostToolUse entry every tool call runs; since #1788 it also carries the TodoWrite hint. */
export const POST_TOOL_USE_WILDCARD_KEY = 'Hook dispatch post-tool-use wildcard';

/** The unwaited PostToolUse entry's matcher: every tool but TodoWrite, whose entry stays waited. */
const UNWAITED_POST_TOOL_USE_MATCHER = '^(?!TodoWrite$).*$';

/**
 * The PostToolUse entry the TodoWrite hint had of its own until #1788. A team
 * that lists it under `builtin.disabled` still turns the hint off.
 */
export const RETIRED_TODOWRITE_HOOK_KEY = 'Hook dispatch post-tool-use TodoWrite';

const BUILTIN_HOOK_SPECS: BuiltinHookSpec[] = [
  { key: 'Hook dispatch session-start', event: 'SessionStart', dispatchEvent: 'session-start', matcher: '*', timeoutSec: 15 },
  { key: 'Hook dispatch stop', event: 'Stop', dispatchEvent: 'stop', matcher: '*', timeoutSec: 15 },
  { key: POST_TOOL_USE_WILDCARD_KEY, event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: '*', timeoutSec: 10 },
  { key: 'Hook dispatch prompt-submit', event: 'UserPromptSubmit', dispatchEvent: 'prompt-submit', matcher: '*', timeoutSec: 10 },
];

/**
 * Built-ins teamai no longer installs, kept so the exact-match cleanup of a
 * project's team-only file still recognises the copies an earlier release
 * wrote there. Entries in user settings go by their `[teamai] ` description.
 * Drop each one release after it retired.
 */
const RETIRED_BUILTIN_HOOK_SPECS: BuiltinHookSpec[] = [
  { key: RETIRED_TODOWRITE_HOOK_KEY, event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: 'TodoWrite', timeoutSec: 3 },
];

const COPILOT_SESSION_END_SPEC: BuiltinHookSpec = {
  key: 'Hook dispatch session-end',
  event: 'SessionEnd',
  dispatchEvent: 'session-end',
  matcher: '*',
  timeoutSec: 15,
};

const SUBAGENT_STOP_SPEC: BuiltinHookSpec = {
  key: 'Hook dispatch subagent-stop',
  event: 'SubagentStop',
  dispatchEvent: 'subagent-stop',
  matcher: '*',
  timeoutSec: 15,
};

/**
 * A subagent Codex spawns fires SubagentStart, not SessionStart (codex-rs
 * core/src/hook_runtime.rs), so a fresh one gets the team rules only through
 * this entry (#938). Codex alone: the team rules reach no other tool this way.
 */
const SUBAGENT_START_SPEC: BuiltinHookSpec = {
  key: 'Hook dispatch subagent-start',
  event: 'SubagentStart',
  dispatchEvent: 'subagent-start',
  matcher: '*',
  timeoutSec: 15,
};

/**
 * Build the built-in hook definitions for a tool.
 *
 * Tool-specific by design: Cursor, WorkBuddy, CodeBuddy and the Codex family
 * entries carry per-hook timeouts so a slow dispatch cannot hang the host (or,
 * for Codex, get killed by its own shorter default instead — #1070); only
 * Claude entries carry no timeout. The reconcile engine renders the same
 * HookDef into each tool's on-disk shape.
 *
 * GUI tools (WorkBuddy, CodeBuddy) use the wrapper dispatch command so their
 * hook subprocesses can find `teamai` even without the user's full PATH.
 * WorkBuddy runs through its bundled MSYS shell. On Windows CodeBuddy's CLI
 * uses Git Bash but its IDE uses cmd.exe, so its built-ins launch Git Bash
 * explicitly through a script that keeps the fail-open contract.
 */
export function builtinHookDefs(tool: string, form: BuiltinHookForm = WAITED_LOGIN_FORM): HookDef[] {
  return renderBuiltinDefs(tool, [
    ...BUILTIN_HOOK_SPECS,
    ...(baseToolOf(tool) === 'copilot' ? [COPILOT_SESSION_END_SPEC] : []),
    ...(channelsOf(tool).hooks.subagentStop ? [SUBAGENT_STOP_SPEC] : []),
    ...(isCodexTool(tool) ? [SUBAGENT_START_SPEC] : []),
  ], form);
}

/** The retired built-ins (RETIRED_BUILTIN_HOOK_SPECS) as an earlier release rendered them for `tool`. */
export function retiredBuiltinHookDefs(tool: string): HookDef[] {
  return renderBuiltinDefs(tool, RETIRED_BUILTIN_HOOK_SPECS, WAITED_LOGIN_FORM);
}

/**
 * How teamai writes its built-in hooks into one hook file. `unwaited`: the tool starts the PostToolUse entry and
 * does not wait for it. `loginDeferred`: a hook starts teamai without a login shell. Both false is the waited
 * login-shell form, which every hook file had before and a project file a repository may commit keeps.
 */
export type BuiltinHookForm = { readonly unwaited: boolean; readonly loginDeferred: boolean };

/** The waited login-shell form: the form of every hook file no tool fact changes. */
export const WAITED_LOGIN_FORM: BuiltinHookForm = { unwaited: false, loginDeferred: false };

/** Every form a hook file's built-ins may have. */
export const BUILTIN_HOOK_FORMS: readonly BuiltinHookForm[] = [false, true]
  .flatMap((unwaited) => [false, true].map((loginDeferred) => ({ unwaited, loginDeferred })));

/**
 * The form of `tool`'s built-ins in its hook file at `destination`: the member's own (`user`), or a project file a
 * repository may commit (`project`), which members with other tool versions and homes share, so it keeps the waited
 * login-shell form. `unwaited` needs the version `unwaitedVersionOf` names at or above the tool's `unwaitedSince`: a
 * version that cannot be read keeps the hook waited. `loginDeferred` needs the tool's `loginDeferrable`. On Windows
 * neither applies, and no tool is started.
 */
export async function builtinHookForm(tool: string, destination: 'user' | 'project'): Promise<BuiltinHookForm> {
  if (destination === 'project' || process.platform === 'win32') return WAITED_LOGIN_FORM;
  const { unwaitedSince, unwaitedVersionOf, loginDeferrable } = channelsOf(tool).hooks;
  const loginDeferred = loginDeferrable === true;

  if (unwaitedSince === undefined) return { unwaited: false, loginDeferred };
  const version = await unwaitedFloorVersion(tool, unwaitedVersionOf);

  return { unwaited: version !== null && semver.gte(version, unwaitedSince), loginDeferred };
}

async function unwaitedFloorVersion(tool: string, source: HooksChannels['unwaitedVersionOf']): Promise<string | null> {
  switch (source) {
    case undefined: {
      const { getAgentVersion } = await import('./agent-version.js');

      return semver.valid(await getAgentVersion(tool));
    }

    case 'codex-builds': {
      const { oldestCodexBuildVersion } = await import('./codex-trust.js');

      return oldestCodexBuildVersion();
    }

    default: {
      const unhandled: never = source;

      return unhandled;
    }
  }
}

/**
 * The built-ins of every form teamai may have written for `tool`, and the retired ones: what a check that an entry
 * on disk is teamai's own compares with, so a form a newer or an older teamai wrote is still recognised.
 */
export function recognisedBuiltinHookDefs(tool: string): HookDef[] {
  return [...BUILTIN_HOOK_FORMS.flatMap((form) => builtinHookDefs(tool, form)), ...retiredBuiltinHookDefs(tool)];
}

function renderBuiltinDefs(tool: string, specs: BuiltinHookSpec[], form: BuiltinHookForm): HookDef[] {
  // An instance's entries take the form of the tool it extends; their command names the instance.
  const base = baseToolOf(tool);
  // ZCode renders per-event timeouts from the ZCODE_TIMEOUT_MS table in its own
  // writer (toZcodeEntry), so def.timeout stays unset for it.
  const withTimeout = base === 'cursor' || base === 'copilot' || base === 'workbuddy' || base === 'codebuddy' || base === 'joycode' || isCodexTool(tool);

  const buildCommand = base === 'zcode'
    ? getRawDispatchCommand
    : toolUsesPwshShell(tool)
      ? getPwshDispatchCommand
      : isShellDependentTool(tool) || base === 'dsh'
        ? getWrapperDispatchCommand
        : getDispatchCommand;

  return specs.flatMap((spec): HookDef[] => {
    const def = {
      source: 'builtin' as const,
      key: spec.key,
      event: spec.event,
      matcher: spec.matcher,
      command: (base === 'zcode' && process.platform !== 'win32' ? `PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" ` : '')
        + buildCommand(spec.dispatchEvent, tool, spec.matcher),
      timeout: withTimeout ? spec.timeoutSec : undefined,
    };

    const description = `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key}`;

    // The team rules reach the Codex family through its start hooks (#938);
    // Codex would otherwise keep only the start and end of a large rule set.
    if (isCodexTool(tool) && (spec.event === 'SessionStart' || spec.event === 'SubagentStart')) return [{ ...def, additionalContextLimit: 0, description }];

    const loginDeferred = form.loginDeferred && buildCommand === getDispatchCommand
      ? { ...def, command: getLoginDeferredDispatchCommand(spec.dispatchEvent, tool), description }
      : { ...def, description };

    if (spec.event === 'UserPromptSubmit') return [loginDeferred];

    if (spec.key !== POST_TOOL_USE_WILDCARD_KEY) return [{ ...def, description }];

    // An unwaited entry is not waited for at all, so it keeps today's command.
    if (!form.unwaited) return [loginDeferred];

    if (hookFormatOf(tool) !== 'claude') return [{ ...def, async: true, description }];

    // An async hook's output reaches the model only at the next turn, and the TodoWrite hint belongs to this one.
    // Both entries keep the wildcard's key, so a team that disables or times it still covers every tool call.
    return [
      { ...def, matcher: UNWAITED_POST_TOOL_USE_MATCHER, async: true, description },
      { ...def, matcher: 'TodoWrite', description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key} for TodoWrite` },
    ];
  });
}

/** The built-in hooks one adapter installs, and what its artifact appends to each dispatch command. */
interface AdapterBuiltinHooks {
  keys: string[];
  suffix?: string;
}

/**
 * Built-in hooks each non-settings tool really receives from the hook
 * reconciliation pipeline, and how the installed artifact runs them.
 *
 * Tools driven by a settings/hooks file get the full `builtinHookDefs(tool)`
 * set through `reconcileHooks`. The adapters below own their own format, each
 * cover a narrower slice, and spawn the dispatcher directly — so the shell
 * wrapper the settings tools carry would misreport what is on disk.
 *
 * Keyed by the tool's hook adapter. A tool with neither a settings file nor an
 * adapter here has no hook surface teamai writes.
 */
const ADAPTER_BUILTIN_HOOKS: Record<HookAdapterId, AdapterBuiltinHooks | null> = {
  'kiro-hooks': { keys: ['Hook dispatch session-start'] },
  // agy-hooks.ts maps the same four events as OMP into agy's hooks.json
  // (SessionStart, PreInvocation, PostToolUse, Stop).
  'agy-hooks': {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      POST_TOOL_USE_WILDCARD_KEY,
      'Hook dispatch prompt-submit',
    ],
  },
  // hermes-hooks.ts registers one on_session_start script whose single line is
  // the dispatch command with errors swallowed (buildReportScript).
  'hermes-plugin': { keys: ['Hook dispatch session-start'], suffix: ' >/dev/null 2>&1 || true' },
  // omp-hooks.ts subscribes to four OMP extension events and spawns the
  // dispatcher with argv; `tool_result` carries no matcher, so the TodoWrite
  // pass does not exist there.
  'omp-extension': {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      POST_TOOL_USE_WILDCARD_KEY,
      'Hook dispatch prompt-submit',
    ],
  },
  // opencode-hooks.ts maps the same four events as OMP.
  'opencode-plugin': {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      POST_TOOL_USE_WILDCARD_KEY,
      'Hook dispatch prompt-submit',
    ],
  },
  // pi-hooks.ts maps the same four lifecycle events as OMP (session_start,
  // agent_settled, tool_execution_end, before_agent_start); Pi has no
  // TodoWrite matcher concept, so post-tool-use is wildcard-only there
  // too. tool_execution_start only caches the tool input for the later
  // post-tool-use dispatch — it never calls hook-dispatch itself.
  'pi-extension': {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      POST_TOOL_USE_WILDCARD_KEY,
      'Hook dispatch prompt-submit',
    ],
  },
  // openclaw-hooks.ts EVENT_MAP maps OpenClaw's events onto session-start and
  // prompt-submit only, and its generated handler spawns the dispatcher with
  // argv. Only `openclaw`:
  // the other claw variants share its workspace resolver, so reconciliation
  // does not route them (see reconcileHooksToAllTools).
  'openclaw-hook': { keys: ['Hook dispatch session-start', 'Hook dispatch prompt-submit'] },
  // dsh's hooks file is reconciled like a settings file, so dsh takes the full `builtinHookDefs`.
  'dsh-hooks': null,
};

/**
 * Built-in hook definitions a tool actually receives, for reporting
 * (`teamai hooks list`).
 *
 * `settingsDriven` tools go through the settings-file reconcile path and get
 * the full set; the others are limited to what their own adapter installs, and
 * a tool the pipeline never installs a built-in hook for gets an empty list so
 * callers can omit it instead of advertising hooks it never receives (#717).
 */
export function installedBuiltinHookDefs(tool: string, settingsDriven: boolean): HookDef[] {
  if (settingsDriven) return builtinHookDefs(tool);
  const adapter = adapterBuiltinHooks(tool);

  if (!adapter) return [];

  return BUILTIN_HOOK_SPECS.flatMap((spec) => (adapter.keys.includes(spec.key) ? [{
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: getRawDispatchCommand(spec.dispatchEvent, tool, spec.matcher) + (adapter.suffix ?? ''),
    description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key}`,
  }] : []));
}

/** The slice of the built-ins `tool`'s own adapter installs, or null when it takes the full `builtinHookDefs` set or has no adapter. */
function adapterBuiltinHooks(tool: string): AdapterBuiltinHooks | null {
  const channel = channelsOf(tool).hooks.user;

  return channel !== 'none' && channel !== 'unknown' && channel.channel === 'adapter' ? ADAPTER_BUILTIN_HOOKS[channel.adapter] : null;
}

/**
 * False when `tool`'s adapter installs only a slice of the built-ins
 * (ADAPTER_BUILTIN_HOOKS); any other tool that runs a teamai hook was
 * installed the full `builtinHookDefs` set. Those are the tools that had the
 * retired TodoWrite entry, so the only ones its hint runs for (#1788).
 */
export function takesAllBuiltins(tool: string): boolean {
  return adapterBuiltinHooks(tool) === null;
}

/** §4.8 team override of built-in hooks. Only whitelisted fields are honored. */
export interface BuiltinHookOverride {
  /** Built-in hook keys to disable (drop entirely). */
  disabled?: string[];
  /** Per-key field overrides (timeout only — never command, for safety). */
  overrides?: Record<string, { timeout?: number }>;
}

/**
 * Apply a team `builtin:` override to the built-in defs: drop disabled keys and
 * apply whitelisted field overrides. An empty/absent override is a no-op, so
 * default behavior stays byte-identical.
 */
export function applyBuiltinOverride(defs: HookDef[], override?: BuiltinHookOverride): HookDef[] {
  if (!override) return defs;
  const disabled = new Set(override.disabled ?? []);

  return defs.flatMap((d) => {
    if (disabled.has(d.key)) return [];
    const o = override.overrides?.[d.key];

    return [o && o.timeout !== undefined ? { ...d, timeout: o.timeout } : d];
  });
}
