import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';
import { CODEX_TOOL_IDS, isCodexTool } from './utils/tool-names.js';
import type { HookDef, ToolId } from './types.js';
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
 * Tools whose hook commands need a shell to execute at all: their hook runner
 * hands the rendered `command` string to a shell instead of an argv vector.
 * Which shell that is depends on the tool (and platform) — see
 * bundled-runtime.ts. Injection is skipped for a tool when no shell resolves,
 * because its hook commands could never run.
 */
export const SHELL_DEPENDENT_TOOLS = new Set<string>(['workbuddy', 'codebuddy'] satisfies ToolId[]);

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

/**
 * Write the `teamai` wrapper into `~/.teamai/bin`: the POSIX `teamai` sh
 * script, plus a `teamai.cmd` on Windows (cmd.exe resolves commands through
 * PATHEXT, so it can never execute the extensionless sh script). Both invoke
 * the real entry script with the best available Node binary. Idempotent —
 * overwrites on every init/pull so the paths stay current after upgrades.
 *
 * Returns the bin directory path, or null if the wrapper could not be created.
 */
export function ensureTeamaiWrapper(): string | null {
  const entryScript = resolveTeamaiEntryScript();
  if (!entryScript) return null;

  const nodeBin = resolveWorkbuddyNode() ?? resolveCodebuddyNode() ?? process.argv[0];
  const home = getUserHome();
  const binDir = path.join(home, TEAMAI_BIN_DIR);
  const wrapperPath = path.join(binDir, WRAPPER_NAME);

  const script = [
    '#!/bin/sh',
    `# Auto-generated by teamai — do not edit.`,
    `# Wrapper that invokes teamai CLI with a known Node binary so hooks`,
    `# work in environments without PATH (e.g. WorkBuddy GUI subprocess).`,
    `exec "${nodeBin}" "${entryScript}" "$@"`,
    '',
  ].join('\n');

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
    fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, `${WRAPPER_NAME}.cmd`), cmdScript);
      fs.writeFileSync(path.join(binDir, CODEBUDDY_HOOK_WRAPPER), [
        '#!/bin/sh',
        `"${nodeBin}" "${entryScript}" "$@" 2>/dev/null || true`,
        '',
      ].join('\n'), { mode: 0o755 });
    }
    return binDir;
  } catch {
    return null;
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
    if (!SHELL_DEPENDENT_TOOLS.has(tool)) continue;
    if (hasShellFor(tool)) {
      withShell = true;
    } else {
      skipped.add(tool);
    }
  }
  // Non-login POSIX dispatch must not rely on a project git hook creating this.
  const nonLoginWrapper = process.platform !== 'win32'
    && tools.some(tool => tool === 'zcode' || tool === 'dsh') && hasShell();
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
  return process.platform === 'win32' && WINDOWS_PWSH_TOOLS.has(tool);
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
 * The `commandWindows` of a team-hook dispatcher entry: the bare dispatch,
 * without the POSIX form's bash wrapper. Codex runs hook commands through
 * `%COMSPEC% /C` on Windows — cmd.exe, not PowerShell (#1215) — which cannot
 * resolve `bash`, so the wrapper has to go. Nothing else is added: cmd /C
 * propagates the child's exit code and stderr natively, so the dispatcher's
 * block contract (exit 2 blocks the run, stderr reaches the user) passes
 * through the same way the bash form passes it on POSIX (#1209).
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
  if (tool === 'codebuddy' && process.platform === 'win32') {
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

const BUILTIN_HOOK_SPECS: BuiltinHookSpec[] = [
  { key: 'Hook dispatch session-start', event: 'SessionStart', dispatchEvent: 'session-start', matcher: '*', timeoutSec: 15 },
  { key: 'Hook dispatch stop', event: 'Stop', dispatchEvent: 'stop', matcher: '*', timeoutSec: 15 },
  { key: 'Hook dispatch post-tool-use wildcard', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: '*', timeoutSec: 10 },
  { key: 'Hook dispatch post-tool-use TodoWrite', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: 'TodoWrite', timeoutSec: 3 },
  { key: 'Hook dispatch prompt-submit', event: 'UserPromptSubmit', dispatchEvent: 'prompt-submit', matcher: '*', timeoutSec: 10 },
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
 * Tools that fire SubagentStop with the parent's session id, so the recall
 * reducer can credit a read a subagent made after the session's last Stop
 * (#884): Claude Code, Codex, CodeBuddy and Qoder document it, and their
 * internal builds share the format. The installed Codex 0.159 knows
 * `SubagentStop`, and Codex main's `HookEventsToml` (codex-rs/config/src/
 * hook_config.rs) has no `deny_unknown_fields`, so it skips an event key it
 * does not know; how older hook-capable builds treat one is unverified (a
 * hooks.json Codex cannot parse is dropped whole). Not WorkBuddy, whose shipped engine version is unverified; not Cursor
 * or Copilot, whose subagents run in sessions of their own that no hook links
 * to the parent; not ZCode, which has no such event and rejects the whole
 * hooks block on an unknown key.
 */
const SUBAGENT_STOP_TOOLS = new Set<string>([
  'claude', 'claude-internal', 'tclaude', ...CODEX_TOOL_IDS, 'codebuddy', 'qoder', 'qoder-cn',
] satisfies ToolId[]);

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
const WRAPPER_TOOLS = SHELL_DEPENDENT_TOOLS;


export function builtinHookDefs(tool: string): HookDef[] {
  // ZCode renders per-event timeouts from the ZCODE_TIMEOUT_MS table in its own
  // writer (toZcodeEntry), so def.timeout stays unset for it.
  const withTimeout = tool === 'cursor' || tool === 'copilot' || tool === 'workbuddy' || tool === 'codebuddy' || isCodexTool(tool);
  const buildCommand = tool === 'zcode'
    ? getRawDispatchCommand
    : toolUsesPwshShell(tool)
      ? getPwshDispatchCommand
      : WRAPPER_TOOLS.has(tool) || tool === 'dsh'
        ? getWrapperDispatchCommand
        : getDispatchCommand;
  const specs = [
    ...BUILTIN_HOOK_SPECS,
    ...(tool === 'copilot' ? [COPILOT_SESSION_END_SPEC] : []),
    ...(SUBAGENT_STOP_TOOLS.has(tool) ? [SUBAGENT_STOP_SPEC] : []),
    ...(isCodexTool(tool) ? [SUBAGENT_START_SPEC] : []),
  ];
  return specs.map((spec) => ({
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: (tool === 'zcode' && process.platform !== 'win32' ? `PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" ` : '')
      + buildCommand(spec.dispatchEvent, tool, spec.matcher),
    timeout: withTimeout ? spec.timeoutSec : undefined,
    // The team rules reach the Codex family through its start hooks (#938);
    // Codex would otherwise keep only the start and end of a large rule set.
    ...(isCodexTool(tool) && (spec.event === 'SessionStart' || spec.event === 'SubagentStart') ? { additionalContextLimit: 0 } : {}),
    description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key}`,
  }));
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
 * A tool in neither place is not listed: JoyCode has no hook surface at all.
 */
const ADAPTER_BUILTIN_HOOKS: Record<string, { keys: string[]; suffix?: string }> = {
  kiro: { keys: ['Hook dispatch session-start'] },
  // hermes-hooks.ts registers one on_session_start script whose single line is
  // the dispatch command with errors swallowed (buildReportScript).
  hermes: { keys: ['Hook dispatch session-start'], suffix: ' >/dev/null 2>&1 || true' },
  // omp-hooks.ts subscribes to four OMP extension events and spawns the
  // dispatcher with argv; `tool_result` carries no matcher, so the TodoWrite
  // pass does not exist there.
  omp: {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      'Hook dispatch post-tool-use wildcard',
      'Hook dispatch prompt-submit',
    ],
  },
  // opencode-hooks.ts maps the same four events as OMP.
  opencode: {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      'Hook dispatch post-tool-use wildcard',
      'Hook dispatch prompt-submit',
    ],
  },
  // pi-hooks.ts maps the same four lifecycle events as OMP (session_start,
  // agent_settled, tool_execution_end, before_agent_start); Pi has no
  // TodoWrite matcher concept, so post-tool-use is wildcard-only there
  // too. tool_execution_start only caches the tool input for the later
  // post-tool-use dispatch — it never calls hook-dispatch itself.
  pi: {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      'Hook dispatch post-tool-use wildcard',
      'Hook dispatch prompt-submit',
    ],
  },
  // openclaw-hooks.ts EVENT_MAP maps OpenClaw's events onto session-start and
  // prompt-submit only, and its generated handler spawns the dispatcher with
  // argv. Only `openclaw`:
  // the other claw variants share its workspace resolver, so reconciliation
  // does not route them (see reconcileHooksToAllTools).
  openclaw: { keys: ['Hook dispatch session-start', 'Hook dispatch prompt-submit'] },
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
  const adapter = ADAPTER_BUILTIN_HOOKS[tool];
  if (!adapter) return [];
  return BUILTIN_HOOK_SPECS.filter((spec) => adapter.keys.includes(spec.key)).map((spec) => ({
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: getRawDispatchCommand(spec.dispatchEvent, tool, spec.matcher) + (adapter.suffix ?? ''),
    description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} ${spec.key}`,
  }));
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
  return defs
    .filter((d) => !disabled.has(d.key))
    .map((d) => {
      const o = override.overrides?.[d.key];
      return o && o.timeout !== undefined ? { ...d, timeout: o.timeout } : d;
    });
}
