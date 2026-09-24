import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';
import type { HookDef } from './types.js';
import { getUserHome } from './utils/home.js';
import { log } from './utils/logger.js';
import { bundledShellFor, resetBundledRuntimeCache, resolveCodebuddyNode, resolveWorkbuddyNode } from './bundled-runtime.js';

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
//  next to it on Windows, because cmd.exe cannot execute the extensionless sh
//  script — that invokes the real entry script with the best available Node,
//  then prepend `~/.teamai/bin` to PATH in hook commands for WorkBuddy and
//  CodeBuddy. The POSIX PATH is expressed as `$HOME/.teamai/bin` (shell
//  literal) so that the golden fixture output is stable across machines; the
//  cmd.exe variant embeds the same bin dir resolved through getUserHome(), the
//  resolver the wrapper writer uses, so write and lookup cannot diverge.
//  Other tools keep the plain `bash -lc "teamai ..."` form.

const TEAMAI_BIN_DIR = '.teamai/bin';
const WRAPPER_NAME = 'teamai';

/**
 * Tools whose hook commands need a shell to execute at all: their hook runner
 * hands the rendered `command` string to a shell instead of an argv vector.
 * Which shell that is depends on the tool (and platform) — see
 * bundled-runtime.ts. Injection is skipped for a tool when no shell resolves,
 * because its hook commands could never run.
 */
export const SHELL_DEPENDENT_TOOLS = new Set(['workbuddy', 'codebuddy']);

/**
 * Shell-dependent tools whose Windows hook runner is cmd.exe rather than a
 * POSIX shell, so their rendered command must be cmd syntax. WorkBuddy is NOT
 * here: its Windows hook runner is the MSYS shell from its bundled
 * PortableGit, which executes the POSIX wrapper form.
 */
const WINDOWS_CMD_TOOLS = new Set(['codebuddy']);

/**
 * True when the tool's hook runner on this platform is cmd.exe, so every
 * command rendered for it — built-in dispatch and team-hook project gate alike
 * — must be cmd syntax.
 */
export function toolUsesCmdShell(tool: string): boolean {
  return process.platform === 'win32' && WINDOWS_CMD_TOOLS.has(tool);
}

/**
 * Check whether /bin/sh exists.  Remote containers (e.g. CloudStudio AI
 * inference nodes) may lack it, causing a POSIX hook runner's
 * `spawn('/bin/sh', ['-c', command])` to fail with ENOENT on every hook
 * invocation.  Tools whose runner is cmd.exe on Windows are exempt — they are
 * covered by their bundledShellFor entry instead.  Exported so the injection
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
  if (withShell) ensureTeamaiWrapper();
  if (skipped.size > 0) {
    log.warn(
      `Skipping hook injection for ${[...skipped].join(', ')}: no shell is available in this environment to execute hooks. ` +
      'Other tools (Claude Code, Cursor) are not affected.',
    );
  }
  return skipped;
}

/**
 * Read the machine-wide InstallPath the Git for Windows installer records
 * in HKLM. Exported so tests stub it at the module boundary instead of
 * shelling out to a real reg.exe. Returns null on any failure — an
 * unreadable registry just means "no extra candidate".
 */
export function queryGitInstallPath(): string | null {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' },
    );
    const match = out.match(/InstallPath\s+REG_SZ\s+(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Locate Git Bash on Windows. CreateProcess resolves a bare `bash` to
 * System32's WSL launcher before any PATH entry (the rationale already
 * documented for ZCode in hooks.ts), and the ZCode cmd fallback is not
 * available to rendered shell-string commands, so on Windows the
 * interpreter has to be an absolute path. Standard install locations
 * first; the HKLM `GitForWindows` key covers custom InstallPath.
 * Returns the exe path, or null when Git is not found.
 */
export function findGitBashWindows(
  env: NodeJS.ProcessEnv = process.env,
  home: string = getUserHome(),
  readInstallPath: () => string | null = queryGitInstallPath,
): string | null {
  const candidates: string[] = [];
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const installPath = readInstallPath();
  if (installPath) {
    const candidate = path.join(installPath, 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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

/** Generate the hook-dispatch command for a given event, tool, and optional matcher. */
export function getDispatchCommand(event: string, tool: string, matcher?: string, binPath?: string): string {
  const bin = binPath ?? 'teamai';
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `${getHookShellCommand()} -lc "${bin} hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null" || true`;
}

/**
 * Raw dispatch command without a shell wrapper. Used by ZCode, whose hook
 * entries are `process`-typed (an executable plus an argv vector): the writer
 * puts `bash -lc <raw>` into `args` itself, so the wrapper must not be baked
 * into the command string.
 */
export function getRawDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `teamai hook-dispatch ${event} --tool ${tool}${matcherArg}`;
}

/**
 * Build a hook command that prepends `$HOME/.teamai/bin` to PATH so the
 * wrapper script is found even without the user's login shell PATH.
 * Used by GUI tools (WorkBuddy, CodeBuddy) that spawn hook subprocesses
 * with a limited environment. The PATH value uses the `$HOME` shell literal
 * so that golden fixture output stays stable across machines.
 */
function getWrapperDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null || true`;
}

/**
 * cmd.exe counterpart of getWrapperDispatchCommand, for tools whose Windows
 * hook runner is cmd.exe rather than a POSIX shell. cmd.exe has no
 * `VAR=value command` prefix, no /dev/null and no `|| true`, so the POSIX form
 * above can never run there — it fails on its first token, whose `PATH=...`
 * assignment cmd reads as a command name. Emit the cmd equivalent: prepend the
 * wrapper dir to PATH (cmd resolves `teamai` to `teamai.cmd` through PATHEXT,
 * falling through to the npm shim further down PATH) and force exit 0 on
 * failure, mirroring the POSIX `|| true` — CodeBuddy reads a non-zero hook
 * status as `allowed:false`, which would BLOCK a UserPromptSubmit instead of
 * failing open.
 *
 * The PATH value is the bin dir resolved through getUserHome() — the SAME
 * resolver ensureTeamaiWrapper() writes `teamai.cmd` through — embedded as a
 * concrete path. A `%USERPROFILE%` literal here would disagree with the writer
 * whenever HOME wins (Git Bash, a custom environment) or USERPROFILE is absent:
 * the shim would land in one directory while the hook searched another, and the
 * hook would silently fail to find the CLI. The POSIX form keeps its `$HOME`
 * literal because getUserHome() prefers HOME and the shell expands it.
 */
function getCmdWrapperDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  const binDir = path.join(getUserHome(), TEAMAI_BIN_DIR);
  return `set "PATH=${binDir};%PATH%" && teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>nul || exit /b 0`;
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
  { key: 'Hook dispatch post-tool-use Skill', event: 'PostToolUse', dispatchEvent: 'post-tool-use', matcher: 'Skill', timeoutSec: 10 },
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

/**
 * Build the built-in hook definitions for a tool.
 *
 * Tool-specific by design: Cursor, WorkBuddy and CodeBuddy entries carry
 * per-hook timeouts so a slow/unreachable backend hook cannot hang the host;
 * only Claude/Codex entries carry no timeout. The reconcile engine renders the
 * same HookDef into each tool's on-disk shape.
 *
 * GUI tools (WorkBuddy, CodeBuddy) use the wrapper dispatch command so their
 * hook subprocesses can find `teamai` even without the user's full PATH. On
 * Windows the tools in WINDOWS_CMD_TOOLS get the cmd.exe syntax variant.
 */
const WRAPPER_TOOLS = SHELL_DEPENDENT_TOOLS;

export function builtinHookDefs(tool: string): HookDef[] {
  // ZCode renders per-event timeouts from the ZCODE_TIMEOUT_MS table in its own
  // writer (toZcodeEntry), so def.timeout stays unset for it.
  const withTimeout = tool === 'cursor' || tool === 'copilot' || tool === 'workbuddy' || tool === 'codebuddy';
  const buildCommand = tool === 'zcode'
    ? getRawDispatchCommand
    : WRAPPER_TOOLS.has(tool)
      ? (toolUsesCmdShell(tool) ? getCmdWrapperDispatchCommand : getWrapperDispatchCommand)
      : getDispatchCommand;
  const specs = tool === 'copilot'
    ? [...BUILTIN_HOOK_SPECS, COPILOT_SESSION_END_SPEC]
    : BUILTIN_HOOK_SPECS;
  return specs.map((spec) => ({
    source: 'builtin' as const,
    key: spec.key,
    event: spec.event,
    matcher: spec.matcher,
    command: buildCommand(spec.dispatchEvent, tool, spec.matcher),
    timeout: withTimeout ? spec.timeoutSec : undefined,
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
 * A tool in neither place is not listed: JoyCode has no hook surface at all,
 * and Kiro's session-start command is embedded per agent by the agent sync
 * (`renderForKiro`), so it exists only for agents that were actually synced
 * rather than coming from the hook pipeline.
 */
const ADAPTER_BUILTIN_HOOKS: Record<string, { keys: string[]; suffix?: string }> = {
  // hermes-hooks.ts registers one on_session_start script whose single line is
  // the dispatch command with errors swallowed (buildReportScript).
  hermes: { keys: ['Hook dispatch session-start'], suffix: ' >/dev/null 2>&1 || true' },
  // omp-hooks.ts subscribes to four OMP extension events and spawns the
  // dispatcher with argv; `tool_result` carries no matcher, so the Skill /
  // TodoWrite passes do not exist there.
  omp: {
    keys: [
      'Hook dispatch session-start',
      'Hook dispatch stop',
      'Hook dispatch post-tool-use wildcard',
      'Hook dispatch prompt-submit',
    ],
  },
  // opencode-hooks.ts covers the same four events plus the matcher-scoped
  // post-tool-use passes (TOOL_MATCHER), i.e. the whole built-in set.
  opencode: { keys: BUILTIN_HOOK_SPECS.map((spec) => spec.key) },
  // pi-hooks.ts maps the same four lifecycle events as OMP (session_start,
  // agent_settled, tool_execution_end, before_agent_start); Pi has no
  // Skill/TodoWrite matcher concept, so post-tool-use is wildcard-only there
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
  // openclaw-hooks.ts EVENT_MAP maps session:start and command:new only, and
  // its generated handler spawns the dispatcher with argv. Only `openclaw`:
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
