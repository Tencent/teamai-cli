import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { readJson, writeJson, readFileSafe, writeFile, expandHome, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import {
  COPILOT_TOOL_ID,
  TEAMAI_HOOK_DESCRIPTION_PREFIX,
  TEAMAI_CUSTOM_HOOK_PREFIX,
  TEAMAI_AGENT_HOOK_PREFIX,
  getManagedHooksPath,
  getCopilotHome,
  resolveHookScope,
  resolveLegacyProjectHookScope,
  resolveToolBaseDir,
  scopedToolPaths,
} from './types.js';
import type { HookDef, TeamaiConfig, LocalConfig, Scope } from './types.js';
import { isSelfMode } from './types.js';
import { resolveMembership } from './membership.js';
import { builtinHookDefs, applyBuiltinOverride, skipToolsWithoutShell, toolUsesCmdShell } from './builtin-hooks.js';
import type { BuiltinHookOverride } from './builtin-hooks.js';
import { resolveTeamHooks } from './resources/hooks.js';
import { getUserHome } from './utils/home.js';

/**
 * Lobster-family agents (OpenClaw engine) that use HOOK.md + handler.ts instead
 * of settings.json (issue #1, 方案二 §四).
 *
 * WorkBuddy is intentionally NOT here: it reads Claude-format hooks from
 * ~/.workbuddy/settings.json (verified on 5.2.0), so it routes through the
 * settings-based injection path like codebuddy. The remaining claw variants
 * stay on the OpenClaw HOOK.md path pending real-device confirmation.
 */
export const OPENCLAW_TOOLS = new Set(['openclaw', 'qclaw', 'easyclaw', 'autoclaw']);

/** Subcommands expected in each tool settings file (for `teamai doctor`). */
export const TEAMAI_HOOK_SUBCOMMANDS = ['hook-dispatch'] as const;

/** Legacy subcommands that are cleaned up during migration. */
export const TEAMAI_LEGACY_HOOK_SUBCOMMANDS = ['pull', 'update', 'track', 'track-slash', 'dashboard-report', 'contribute-check', 'auto-recall', 'todowrite-hint', 'mr-hint'] as const;

/** Claude PascalCase event → Cursor camelCase event (for tests / docs). */
export const CLAUDE_TO_CURSOR_EVENTS: Record<string, string> = {
  SessionStart: 'sessionStart',
  Stop: 'stop',
  PostToolUse: 'postToolUse',
  UserPromptSubmit: 'beforeSubmitPrompt',
};

/**
 * TeamAI hook events supported by Copilot's Claude-compatible schema. Keeping
 * PascalCase also keeps Copilot's stdin payload snake_case, which is the
 * contract consumed by hook-dispatch.
 */
export const CLAUDE_TO_COPILOT_EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
};

// ─── On-disk shapes ─────────────────────────────────────────

interface HookEntry {
  type: string;
  command: string;
  /** Per-hook timeout in seconds. Falls back to the tool default if omitted. */
  timeout?: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
  description?: string;
}

interface ClaudeSettingsJson {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

interface CursorHookEntry {
  command: string;
  timeout?: number;
  matcher?: string;
}

interface CursorHooksJson {
  version: number;
  hooks: Record<string, CursorHookEntry[]>;
}

interface CodexHookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface CodexHookMatcher {
  matcher?: string;
  hooks: CodexHookEntry[];
}

interface CodexHooksJson {
  hooks?: Record<string, CodexHookMatcher[]>;
  [key: string]: unknown;
}

interface CopilotHookEntry {
  type: 'command';
  bash: string;
  powershell: string;
  command: string;
  matcher?: string;
  timeoutSec?: number;
}

interface CopilotHooksJson {
  version: number;
  hooks: Record<string, CopilotHookEntry[]>;
}

const COPILOT_HOOK_SCHEMA_VERSION = 1;

// ZCode (~/.zcode/cli/config.json): Claude-shaped hooks nested under
// `hooks.events`, gated by `hooks.enabled` (config-file hooks are disabled by
// default — the writer must force it on). The file is shared with ZCode's own
// plugin state, so reconcile merges keys and never replaces the document.
// Hook entries use the `process` type (argv vector, no shell): spawning the
// bare string `bash -lc "..."` through ZCode's command-type shell is
// unreliable on Windows, where PATH order can resolve `bash` to the WSL
// launcher instead of Git Bash.
interface ZcodeHookEntry {
  type: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
}

interface ZcodeHookMatcher {
  matcher?: string;
  hooks: ZcodeHookEntry[];
}

interface ZcodeHooksJson {
  hooks?: {
    enabled?: boolean;
    events?: Record<string, ZcodeHookMatcher[]>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Unified reconcile engine (issue #19) ───────────────────
//
//  A single engine injects BOTH built-in operational hooks (source: 'builtin',
//  from builtinHookDefs) and team-declared hooks (source: 'team', from
//  hooks/hooks.yaml). They coexist in the same settings file, isolated by
//  marker namespaces:
//    - built-in:  description starts with "[teamai] " / command matches a marker
//    - team:      description starts with "[teamai:hook:<id>]"
//  Cursor and Codex hook files carry no description, so team hooks there are
//  tracked via the managed-hooks manifest (see ManagedHooksManifest).
//
//  Reconcile is idempotent and only writes when content actually changes, so an
//  upgraded CLI re-running over an already-injected file produces a zero-diff.

type ToolFormat = 'claude' | 'cursor' | 'codex' | 'copilot' | 'zcode';
export type HookStatus = 'installed' | 'missing';

const CURSOR_TOOLS = new Set(['cursor']);
const CODEX_TOOLS = new Set<string>(CODEX_TOOL_IDS);
const ZCODE_TOOLS = new Set(['zcode']);

function detectFormat(tool: string): ToolFormat {
  if (tool === COPILOT_TOOL_ID) return 'copilot';
  if (CODEX_TOOLS.has(tool)) return 'codex';
  if (ZCODE_TOOLS.has(tool)) return 'zcode';
  return CURSOR_TOOLS.has(tool) ? 'cursor' : 'claude';
}

/**
 * Tools that enforce a user trust gate on non-managed hooks. Only the public
 * Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) does: even after
 * teamai writes `<repo>/.codex/hooks.json` or `~/.codex/hooks.json`, Codex may
 * skip a newly added or changed hook until the user reviews/trusts it in
 * `/hooks` or Settings → Hooks. The internal variants (`codex-internal`,
 * `tcodex`) share the codex hooks.json *format* but not this trust gate, so
 * they are intentionally excluded.
 */
const CODEX_TRUST_GATE_TOOLS = new Set(['codex']);

/**
 * True for a tool that gates hooks behind an explicit user trust step (only the
 * public `codex`). teamai never edits Codex's `[hooks.state]` to auto-trust —
 * the reminder is UX only. Exported so `hooks inject` / `doctor` can surface it.
 */
export function isCodexTrustGatedTool(tool: string): boolean {
  return CODEX_TRUST_GATE_TOOLS.has(tool);
}

/**
 * One-line reminder that Codex may require the user to trust newly written hooks
 * before they run. Shared by `hooks inject` (post-write notice) and `doctor`
 * (installed-hooks note) so the wording stays identical.
 */
export function codexTrustReminder(): string {
  return 'Codex hooks written, but Codex may require you to review/trust them before they run — open /hooks or Settings → Hooks in Codex to trust them.';
}

/** Known teamai command substrings used to identify built-in / legacy hooks. */
const TEAMAI_COMMAND_MARKERS = [
  'teamai pull', 'teamai update', 'teamai track', 'teamai dashboard', 'teamai contribute-check',
  'teamai auto-recall', 'teamai todowrite-hint', 'teamai mr-hint', 'teamai hook-dispatch',
];

function extractTeamaiSubcommand(command: string): string | null {
  const match = command.match(/teamai\s+([\w-]+)/);
  return match ? match[1] : null;
}

function isTeamaiHookCommand(command: string): boolean {
  return /(?:^|"|\s)teamai\s/.test(command);
}

/** Filter team defs down to those that apply to the given tool. */
function teamDefsForTool(teamDefs: HookDef[], tool: string): HookDef[] {
  return teamDefs.filter((d) => !d.tools || d.tools.includes(tool));
}

/** Build the per-tool desired HookDef set: built-in (A) followed by team (B). */
function desiredDefs(tool: string, teamDefs: HookDef[], builtinOverride?: BuiltinHookOverride): HookDef[] {
  return [...applyBuiltinOverride(builtinHookDefs(tool), builtinOverride), ...teamDefsForTool(teamDefs, tool)];
}

// ─── Reconcile options & manifest ───────────────────────────

export interface ReconcileHooksOptions {
  /** Remove all teamai-managed hooks instead of injecting the desired set. */
  removeAll?: boolean;
  /**
   * Path to the managed-hooks manifest (~/.teamai/managed-hooks.json). Required
   * to track Cursor team hooks (their commands carry no teamai marker). When
   * omitted, only built-in (A) hooks are managed — used by the legacy
   * builtin-only public API.
   */
  manifestPath?: string;
  /** §4.8 team override of built-in hooks (disabled / timeout). */
  builtinOverride?: BuiltinHookOverride;
  /** Project root used to gate non-self project-scope team hooks. */
  teamHookProjectRoot?: string;
}

/** One injected team hook recorded in the manifest. */
export interface ManagedHookRecord {
  id: string;
  event: string;
  matcher?: string;
  command: string;
}

/** ~/.teamai/managed-hooks.json — team hooks injected per tool. */
export type ManagedHooksManifest = Record<string, ManagedHookRecord[]>;

async function readManifest(manifestPath: string): Promise<ManagedHooksManifest> {
  const data = await readJson<ManagedHooksManifest>(expandHome(manifestPath));
  return data && typeof data === 'object' ? data : {};
}

/** Team hooks to record in the manifest for a tool (empty when removing). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function canonicalProjectRoot(projectRoot: string): string {
  try { return realpathSync.native(projectRoot); } catch { return path.resolve(projectRoot); }
}

/**
 * Embed a Windows path in a cmd.exe command line so the child receives it
 * byte-for-byte.
 *
 * A path interpolated into cmd text is re-parsed: `%…%` expands and
 * `& ^ ( ) | < >` act on the line even inside double quotes, so a project at
 * `C:\src\x&whoami&` would run part of its own name every time a hook fires.
 * Caret escapes stop that during cmd's parsing, but cmd consumes them before
 * CreateProcess and the child then re-splits the line, where a caret cannot
 * keep a space in one token. Emitting the quotes as `^"` covers both: cmd
 * consumes the caret and hands over a real quote, so the value reaches the
 * child literally and spaces stay inside one argument.
 */
function cmdLiteral(value: string): string {
  return `^"${value.replace(/[%^&()<>|,;=]/g, (ch) => `^${ch}`)}^"`;
}

/**
 * cmd.exe equivalent of the POSIX project gate, as a prefix that resolves to
 * true only inside `root`.
 *
 * The cwd is read with a bare `cd`, whose output goes straight into the pipe:
 * unlike `echo %CD%`, the directory name is never part of a parsed command, so
 * `&`, `%` and `^` in it cannot be re-interpreted. `cd` prints no trailing
 * separator, so the root itself needs its own end-anchored test. The
 * separator-suffixed `/b` form covers everything below the root while a
 * sibling that merely shares the prefix (`C:\a\proj` vs `C:\a\proj-2`) does
 * not; `/e` accepts the root's own `C:\a\proj`, and a longer line ending in it
 * is not a valid absolute Windows path. `/l` keeps the pattern literal and
 * `/i` matches the case-insensitive Windows path. The pattern ends in `\\`
 * because findstr's CRT argument parser consumes one backslash.
 */
function cmdProjectGate(root: string): string {
  // A root that ends in a separator (a drive root, `C:\`) would end the quoted
  // literal with a backslash and escape its closing quote, unbalancing the
  // whole command line. Stripping it also leaves the `/b` form matching the
  // drive root's own `C:\` cwd.
  const literal = cmdLiteral(root.replace(/[\\/]+$/, ''));
  return `cd| findstr /i /b /l /c:${literal}\\\\ >nul || cd| findstr /i /e /l /c:${literal} >nul`;
}

/**
 * Keep a project-scope team hook from firing in every project on the machine.
 * The gate is rendered in the syntax of the shell that will actually run it:
 * cmd.exe for tools whose Windows hook runner is cmd.exe — a POSIX
 * `if [ "$PWD" ... ]` there is a syntax error that kills the whole command,
 * gate and payload alike, before it ever runs — and POSIX sh for every other
 * tool.
 *
 * Exit-status contract, identical for both renderings: outside the project the
 * gate is a no-op that exits 0, and inside it the command's own status is
 * passed through. A gate mismatch that returned non-zero would make CodeBuddy
 * read the hook as `allowed:false` and BLOCK every UserPromptSubmit outside the
 * project, so the cmd form must not inherit `findstr`'s failure status. That is
 * also why the cmd form is not `${gate} || exit /b 0 && (…)`: the `||` would
 * swallow a genuine payload failure along with the mismatch, losing the
 * pass-through the POSIX `if …; then …; fi` gives for free.
 */
function gateTeamHookCommand(command: string, projectRoot: string | undefined, tool: string): string {
  if (!projectRoot) return command;
  const root = canonicalProjectRoot(projectRoot);
  if (toolUsesCmdShell(tool)) {
    return `${cmdProjectGate(root)} & if not errorlevel 1 (${command}) else exit /b 0`;
  }
  const quoted = shellQuote(root);
  return `if [ "$PWD" = ${quoted} ] || case "$PWD" in ${quoted}/*) true;; *) false;; esac; then (${command}); fi`;
}

/** Recognise a project gate written by either renderer (entries outlive a platform switch). */
function isGatedForProject(command: string, projectRoot: string): boolean {
  const root = canonicalProjectRoot(projectRoot);
  return command.startsWith(`if [ "$PWD" = ${shellQuote(root)} ]`)
    || command.startsWith(cmdProjectGate(root));
}

function isProjectGatedCommand(command: string): boolean {
  return command.startsWith('if [ "$PWD" = ') || command.startsWith('cd| findstr ');
}

function scopedTeamDefs(teamDefs: HookDef[], projectRoot: string | undefined, tool: string): HookDef[] {
  if (!projectRoot) return teamDefs;
  return teamDefs.map((def) => ({ ...def, command: gateTeamHookCommand(def.command, projectRoot, tool) }));
}

function manifestRecordsForTool(teamDefs: HookDef[], tool: string, removeAll: boolean, projectRoot?: string): ManagedHookRecord[] {
  if (removeAll) return [];
  return teamDefsForTool(scopedTeamDefs(teamDefs, projectRoot, tool), tool).map((d) => ({
    id: d.key,
    event: d.event,
    ...(d.matcher && d.matcher !== '*' ? { matcher: d.matcher } : {}),
    command: d.command,
  }));
}

// ─── Render helpers (HookDef → on-disk entry) ───────────────

function toClaudeEntry(def: HookDef): HookMatcher {
  return {
    matcher: def.matcher ?? '*',
    hooks: [
      {
        type: 'command',
        command: def.command,
        ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      },
    ],
    description: def.description,
  };
}

function toCursorEntry(def: HookDef): CursorHookEntry {
  const entry: CursorHookEntry = { command: def.command };
  if (def.timeout !== undefined) entry.timeout = def.timeout;
  if (def.matcher && def.matcher !== '*') entry.matcher = def.matcher;
  return entry;
}

function toCodexEntry(def: HookDef): CodexHookMatcher {
  const entry: CodexHookMatcher = {
    hooks: [
      {
        type: 'command',
        command: def.command,
        ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      },
    ],
  };
  if (def.matcher && def.matcher !== '*') entry.matcher = def.matcher;
  return entry;
}

// getDispatchCommand() prefixes the launcher with a quoted, forward-slash Git
// Bash path on Windows and keeps bare `bash` everywhere else (and on Windows
// machines where Git Bash cannot be found).
const COPILOT_BUILTIN_COMMAND_RE = /^("[^"]+"|bash) -lc "(teamai hook-dispatch [^"]+) 2>\/dev\/null" \|\| true$/;

/** Render a valid PowerShell equivalent for TeamAI's generated bash wrapper. */
function copilotPowershellCommand(command: string): string {
  const match = command.match(COPILOT_BUILTIN_COMMAND_RE);
  if (!match) return command;
  // PowerShell needs the call operator before a quoted executable path, and
  // `|| true` maps to `; exit 0`. The dispatch command inside is
  // builtin-generated (no `$`, backticks or double quotes), so echoing it
  // inside a double-quoted PowerShell string is interpolation-safe.
  return match[1] === 'bash'
    ? `${match[2]} 2>$null; exit 0`
    : `& ${match[1]} -lc "${match[2]} 2>/dev/null"; exit 0`;
}

function toCopilotEntry(def: HookDef): CopilotHookEntry {
  const matcher = def.source === 'builtin'
    && def.event === 'PostToolUse'
    && def.matcher === 'Skill'
    ? 'skill'
    : def.matcher;
  return {
    type: 'command',
    bash: def.command,
    powershell: copilotPowershellCommand(def.command),
    command: def.command,
    ...(matcher && matcher !== '*' ? { matcher } : {}),
    ...(def.timeout !== undefined ? { timeoutSec: def.timeout } : {}),
  };
}

function toZcodeEntry(def: HookDef, vbsPath: string): ZcodeHookMatcher {
  // ZCode sessions run hooks inline: a session-start dispatch carries a network
  // pull (SSH to the team host), which on slower links exceeds the 10–15s
  // builtin defaults and gets killed mid-pull — so the timeouts here are
  // network-scale, not the shell-hook defaults.
  const ZCODE_TIMEOUT_MS: Record<string, number> = {
    SessionStart: 180000,
    Stop: 60000,
    PostToolUse: 30000,
    UserPromptSubmit: 60000,
  };
  // wscript.exe is a GUI-subsystem binary: unlike cmd/bash it never allocates
  // a console window, so hook runs don't flash a black box over the desktop.
  // The VBS launcher preserves the STDIN contract (ZCode's payload reaches
  // hook-dispatch via a spooled temp file), waits for the dispatch bounded by
  // the per-event timeout, and runs everything hidden (window style 0) with
  // the dispatch tail cmd-level quoted so team-declared commands survive
  // cmd's operator parsing. The payload travels verbatim as a single argument
  // so managed-entry detection and the manifest keep one command
  // representation.
  // The table is ZCode's DEFAULT, not an override: a timeout the team stated in
  // hooks.yaml (per-hook `timeout`, or `builtin.overrides.<key>.timeout`) is the
  // one the user asked for and still wins, as it does on every other tool.
  // `def.timeout` is in seconds; ZCode entries are in milliseconds.
  const timeoutMs =
    def.timeout !== undefined ? def.timeout * 1000 : ZCODE_TIMEOUT_MS[def.event] ?? 60000;
  const entry: ZcodeHookEntry =
    process.platform === 'win32'
      ? {
          // wscript.exe is a GUI-subsystem binary: unlike cmd/bash it never
          // allocates a console window, so hook runs don't flash a black box
          // over the desktop. The VBS launcher preserves the STDIN contract
          // (ZCode's payload reaches hook-dispatch via a spooled temp file),
          // waits bounded by the per-event timeout, and runs hidden (window
          // style 0). The payload travels verbatim as a single argument so
          // managed-entry detection and the manifest keep one command
          // representation.
          type: 'process',
          command: 'wscript.exe',
          args: [vbsPath, def.command],
          timeoutMs,
        }
      : {
          // POSIX has no console-flash problem: run the tail directly, like
          // every other shell-based tool format.
          type: 'process',
          command: 'bash',
          // Stored verbatim: the shell payload must equal `def.command` exactly
          // so managed-entry detection and the managed-hooks manifest share one
          // command representation (the same invariant the Codex format keeps).
          args: ['-lc', def.command],
          timeoutMs,
        };
  const group: ZcodeHookMatcher = { hooks: [entry] };
  // ZCode's matcher is a case-sensitive regex on the match value; '*' is an
  // invalid pattern that would never match. Omitted matcher matches everything.
  if (def.matcher && def.matcher !== '*') group.matcher = def.matcher;
  return group;
}

/** Shell payload of a ZCode hook entry, for managed-entry matching. */
function zcodeEntryCommand(entry: ZcodeHookMatcher): string {
  const hook = entry.hooks?.[0];
  // The wscript launcher carries the command tail as its LAST argument —
  // [vbsPath, tail] today; an earlier generation used a mode slot
  // ([vbsPath, 'wait', tail]). Reading the last slot recognizes both shapes
  // (and team commands, which carry no teamai marker and are matched against
  // the managed-hooks manifest) so they get replaced or removed, not duplicated.
  if (Array.isArray(hook?.args) && hook.args.length > 0) {
    return hook.args[hook.args.length - 1] ?? '';
  }
  return hook?.command ?? '';
}

/** Ordered, de-duplicated list of events appearing in the desired defs. */
function desiredEventOrder(defs: HookDef[], mapEvent: (e: string) => string | undefined): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const d of defs) {
    const mapped = mapEvent(d.event);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    order.push(mapped);
  }
  return order;
}

// ─── Claude / CodeBuddy (settings.json) reconcile ───────────

/** True if a settings entry is a teamai built-in (A) hook. */
function isBuiltinClaudeEntry(entry: HookMatcher): boolean {
  const desc = entry.description ?? '';
  if (desc.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX + ' ') || desc === TEAMAI_HOOK_DESCRIPTION_PREFIX) return true;
  const cmd = entry.hooks?.[0]?.command ?? '';
  return TEAMAI_COMMAND_MARKERS.some((marker) => cmd.includes(marker));
}

/** True if a settings entry is a teamai team (B) hook. */
function isTeamClaudeEntry(entry: HookMatcher): boolean {
  return (entry.description ?? '').startsWith(TEAMAI_CUSTOM_HOOK_PREFIX);
}

/** The hook id carried by a team entry's marker, `[teamai:hook:<id>] …`. */
function teamHookIdOf(description: string | undefined): string | null {
  const marker = description ?? '';
  if (!marker.startsWith(TEAMAI_CUSTOM_HOOK_PREFIX)) return null;
  const end = marker.indexOf(']');
  return end > TEAMAI_CUSTOM_HOOK_PREFIX.length
    ? marker.slice(TEAMAI_CUSTOM_HOOK_PREFIX.length, end)
    : null;
}

async function reconcileClaudeFormat(
  settingsPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  teamActive: boolean,
  desiredTeamCommands: Set<string>,
  priorTeamCommands: Set<string>,
): Promise<void> {
  // Built-in management never removes team hooks; team hooks are reconciled only
  // when a team pass is active (manifest present). This keeps the builtin-only
  // refresh path (injectHooks / autoMigrate) non-destructive to team hooks (§5).
  // Hook ids this reconcile declares for the tool, used to recognise our own
  // entries even when an older CLI rendered them differently.
  const desiredTeamIds = new Set(
    teamDefs.filter((d) => !d.tools || d.tools.includes(tool)).map((d) => d.key),
  );
  const isManaged = (e: HookMatcher): boolean => {
    if (isBuiltinClaudeEntry(e) || (!!opts.removeAll && isAgentClaudeEntry(e))) return true;
    if (!teamActive || !isTeamClaudeEntry(e)) return false;
    // Project-scope hooks share HOME with other projects. Only remove entries
    // recorded for this project (or desired by this reconcile); otherwise a
    // project B pull must not delete project A's hooks.
    if (opts.teamHookProjectRoot) {
      const command = e.hooks?.[0]?.command ?? '';
      // An entry gated for this project belongs to this project even when an
      // older CLI rendered the gate in another syntax (or the payload changed):
      // replace it instead of leaving a dead duplicate that removal can no
      // longer match.
      if (isGatedForProject(command, opts.teamHookProjectRoot)) {
        if (opts.removeAll) return true;
        const id = teamHookIdOf(e.description);
        if (id !== null && desiredTeamIds.has(id)) return true;
      }
      return desiredTeamCommands.has(command) || priorTeamCommands.has(command);
    }
    return true;
  };
  const expanded = expandHome(settingsPath);
  await ensureDir(path.dirname(expanded));
  const settings: ClaudeSettingsJson = (await readJson<ClaudeSettingsJson>(expanded)) ?? {};
  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  // Clean up empty camelCase keys left by a previous incorrect injection.
  for (const key of ['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt', 'userPromptSubmit']) {
    if (settings.hooks[key] && settings.hooks[key].length === 0) {
      delete settings.hooks[key];
      changed = true;
    }
  }

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts.builtinOverride);
  const eventOrder = desiredEventOrder(defs, (e) => e);
  const events = [...eventOrder, ...Object.keys(settings.hooks).filter((e) => !eventOrder.includes(e))];

  for (const event of events) {
    const existing = settings.hooks[event] ?? [];
    const untouched = existing.filter((e) => !isManaged(e));
    const desiredEntries = defs.filter((d) => d.event === event).map(toClaudeEntry);
    const newArr = [...untouched, ...desiredEntries];
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      settings.hooks[event] = newArr;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, settings);
    log.success(`${opts.removeAll ? 'Removed' : 'Updated'} teamai hooks in ${settingsPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${settingsPath}`);
  }
}

// ─── Cursor (hooks.json) reconcile ──────────────────────────

async function reconcileCursorFormat(
  hooksPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  priorTeamCommands: Set<string>,
): Promise<void> {
  const expanded = expandHome(hooksPath);
  await ensureDir(path.dirname(expanded));
  const hooksJson: CursorHooksJson = (await readJson<CursorHooksJson>(expanded)) ?? { version: 1, hooks: {} };
  if (!hooksJson.version) hooksJson.version = 1;
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (entry: CursorHookEntry): boolean =>
    isTeamaiHookCommand(entry.command) || priorTeamCommands.has(entry.command);

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts.builtinOverride);
  const desiredByEvent: Record<string, CursorHookEntry[]> = {};
  for (const def of defs) {
    const cursorEvent = CLAUDE_TO_CURSOR_EVENTS[def.event];
    if (!cursorEvent) continue; // event Cursor doesn't support → skip
    (desiredByEvent[cursorEvent] ??= []).push(toCursorEntry(def));
  }

  let changed = false;

  // Phase A: reconcile events already present in the file.
  for (const event of Object.keys(hooksJson.hooks)) {
    const existing = hooksJson.hooks[event];
    const untouched = existing.filter((e) => !isManaged(e));
    let newArr: CursorHookEntry[];
    if (desiredByEvent[event]) {
      newArr = [...untouched, ...desiredByEvent[event]];
    } else if (opts.removeAll) {
      newArr = untouched; // keep emptied desired events as [] (matches legacy remove)
    } else {
      // Stale teamai event key (e.g. userPromptSubmit → beforeSubmitPrompt).
      newArr = untouched;
      if (newArr.length === 0) {
        if (existing.length !== 0) changed = true;
        delete hooksJson.hooks[event];
        continue;
      }
    }
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      hooksJson.hooks[event] = newArr;
      changed = true;
    }
  }

  // Phase B: create desired events not yet present, in canonical order.
  for (const event of desiredEventOrder(defs, (e) => CLAUDE_TO_CURSOR_EVENTS[e])) {
    if (hooksJson.hooks[event]) continue;
    hooksJson.hooks[event] = desiredByEvent[event];
    changed = true;
  }

  if (changed) {
    await writeJson(expanded, hooksJson);
    log.success(`${opts.removeAll ? 'Removed' : 'Updated'} teamai hooks in ${hooksPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${hooksPath}`);
  }
}

// ─── GitHub Copilot CLI (standalone hooks/*.json) reconcile ──

function copilotEntryCommands(entry: CopilotHookEntry): string[] {
  return [entry.bash, entry.powershell, entry.command].filter(Boolean);
}

async function reconcileCopilotFormat(
  hooksPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  priorTeamCommands: Set<string>,
): Promise<void> {
  const expanded = expandHome(hooksPath);
  const existed = await pathExists(expanded);
  if (opts.removeAll && !existed) {
    log.debug(`No teamai hooks to remove from ${hooksPath}`);
    return;
  }
  await ensureDir(path.dirname(expanded));
  const hooksJson: CopilotHooksJson = (await readJson<CopilotHooksJson>(expanded)) ?? {
    version: COPILOT_HOOK_SCHEMA_VERSION,
    hooks: {},
  };
  let changed = hooksJson.version !== COPILOT_HOOK_SCHEMA_VERSION;
  hooksJson.version = COPILOT_HOOK_SCHEMA_VERSION;
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (entry: CopilotHookEntry): boolean => copilotEntryCommands(entry).some((command) =>
    TEAMAI_COMMAND_MARKERS.some((marker) => command.includes(marker)) || priorTeamCommands.has(command),
  );
  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts.builtinOverride);
  const desiredByEvent: Record<string, CopilotHookEntry[]> = {};
  for (const def of defs) {
    const event = CLAUDE_TO_COPILOT_EVENTS[def.event];
    if (!event) continue;
    (desiredByEvent[event] ??= []).push(toCopilotEntry(def));
  }

  for (const event of Object.keys(hooksJson.hooks)) {
    const existing = hooksJson.hooks[event] ?? [];
    const untouched = existing.filter((entry) => !isManaged(entry));
    const desired = desiredByEvent[event] ?? [];
    const next = [...untouched, ...desired];
    if (next.length === 0 && !opts.removeAll) {
      if (existing.length > 0) changed = true;
      delete hooksJson.hooks[event];
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      hooksJson.hooks[event] = next;
      changed = true;
    }
  }

  for (const event of desiredEventOrder(defs, (value) => CLAUDE_TO_COPILOT_EVENTS[value])) {
    if (hooksJson.hooks[event]) continue;
    hooksJson.hooks[event] = desiredByEvent[event];
    changed = true;
  }

  if (changed || !existed) {
    await writeJson(expanded, hooksJson);
    log.success(`${opts.removeAll ? 'Removed' : 'Updated'} teamai hooks in ${hooksPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${hooksPath}`);
  }
}

// ─── Codex (hooks.json) reconcile ───────────────────────────

async function reconcileCodexFormat(
  hooksPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  priorTeamCommands: Set<string>,
): Promise<void> {
  const expanded = expandHome(hooksPath);
  await ensureDir(path.dirname(expanded));
  const hooksJson: CodexHooksJson = (await readJson<CodexHooksJson>(expanded)) ?? {};
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (entry: CodexHookMatcher): boolean => {
    const cmd = entry.hooks?.[0]?.command ?? '';
    return TEAMAI_COMMAND_MARKERS.some((marker) => cmd.includes(marker)) || priorTeamCommands.has(cmd);
  };

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts.builtinOverride);
  const eventOrder = desiredEventOrder(defs, (e) => e);
  const events = [...eventOrder, ...Object.keys(hooksJson.hooks).filter((e) => !eventOrder.includes(e))];

  let changed = false;
  for (const event of events) {
    const existing = hooksJson.hooks[event] ?? [];
    const untouched = existing.filter((e) => !isManaged(e));
    const desiredEntries = defs.filter((d) => d.event === event).map(toCodexEntry);
    const newArr = [...untouched, ...desiredEntries];
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      hooksJson.hooks[event] = newArr;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, hooksJson);
    log.success(`${opts.removeAll ? 'Removed' : 'Updated'} teamai hooks in ${hooksPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${hooksPath}`);
  }
}

// ─── ZCode (~/.zcode/cli/config.json) reconcile ─────────────

async function reconcileZcodeFormat(
  settingsPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  priorTeamCommands: Set<string>,
): Promise<void> {
  const expanded = expandHome(settingsPath);
  await ensureDir(path.dirname(expanded));
  const vbsPath = path.join(path.dirname(expanded), 'teamai-hook-dispatch.vbs');
  // Hidden launcher: wscript.exe is a GUI-subsystem binary, so hook runs don't
  // flash a black box over the desktop, and the spool file keeps the STDIN
  // payload contract intact (ZCode's JSON reaches hook-dispatch even though
  // WScript.Shell.Run cannot forward a live stdin pipe).
  const vbsScript = [
    "' TeamAI hook dispatcher - hidden, timeout-bounded, stdin-preserving.",
    'Option Explicit',
    'Dim sh, fso, spool, f',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'spool = fso.GetSpecialFolder(2) & "\\teamai-hook-" & fso.GetTempName',
    'Set f = fso.CreateTextFile(spool, True)',
    'On Error Resume Next',
    'f.Write WScript.StdIn.ReadAll()',
    'f.Close',
    'sh.Run "cmd /d /s /c """ & WScript.Arguments(0) & " < """ & spool & """ >nul 2>&1""", 0, True',
    'fso.DeleteFile spool, True',
  ].join('\r\n');
  if (opts.removeAll) {
    // Unconditional: after a normal inject the file equals the template, so a
    // content-diff gate never fires and the script would be left behind.
    await rm(vbsPath, { force: true });
  } else if (process.platform === 'win32') {
    // POSIX never runs the launcher — writing it there would litter ~/.zcode
    // with a script no entry references.
    const existingVbs = await readFileSafe(vbsPath);
    if (existingVbs !== vbsScript) {
      await writeFile(vbsPath, vbsScript);
    }
  }
  const cfg: ZcodeHooksJson = (await readJson<ZcodeHooksJson>(expanded)) ?? {};
  if (!cfg.hooks) cfg.hooks = {};
  let changed = false;
  // ZCode validates the hooks block against a strict schema and REJECTS THE
  // WHOLE BLOCK on any unrecognized key (observed: `config_file_invalid —
  // hooks: Unrecognized key: "description"` → hookCount 0 → nothing fires).
  // Heal the config by keeping only the keys the schema knows about.
  const unknownHookKeys = Object.keys(cfg.hooks).filter((k) => k !== 'enabled' && k !== 'events');
  if (unknownHookKeys.length > 0) {
    for (const k of unknownHookKeys) delete cfg.hooks[k];
    changed = true;
  }
  // Config-file hooks are disabled by default in ZCode; entries we write would
  // never fire unless the runner is explicitly enabled. Persist the flip even
  // when the event arrays are already up to date — but only when installing.
  // Removal must preserve the runner state the user chose: re-enabling during
  // uninstall would switch hooks the user explicitly disabled back on.
  if (!opts.removeAll && cfg.hooks.enabled !== true) {
    cfg.hooks.enabled = true;
    changed = true;
  }
  if (!cfg.hooks.events) cfg.hooks.events = {};

  // ZCode hook entries carry no description field, so managed-entry detection
  // relies on the teamai command markers plus the managed-hooks manifest —
  // same strategy as the Codex format.
  const isManaged = (entry: ZcodeHookMatcher): boolean => {
    const cmd = zcodeEntryCommand(entry);
    return TEAMAI_COMMAND_MARKERS.some((marker) => cmd.includes(marker)) || priorTeamCommands.has(cmd);
  };

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts.builtinOverride);
  const eventOrder = desiredEventOrder(defs, (e) => e);
  const eventsMap = cfg.hooks.events;
  const events = [...eventOrder, ...Object.keys(eventsMap).filter((e) => !eventOrder.includes(e))];

  for (const event of events) {
    const existing = eventsMap[event] ?? [];
    const untouched = existing.filter((e) => !isManaged(e));
    const desiredEntries = defs.filter((d) => d.event === event).map((d) => toZcodeEntry(d, vbsPath));
    const newArr = [...untouched, ...desiredEntries];
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      eventsMap[event] = newArr;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, cfg);
    log.success(`${opts.removeAll ? 'Removed' : 'Updated'} teamai hooks in ${settingsPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${settingsPath}`);
  }
}

// ─── Agent hooks (HTTP-source, issue #238) ──────────────────

/**
 * Whitelisted hook events for HTTP-source agent hooks
 * (Claude PascalCase, native in both claude & codex formats).
 */
export const AGENT_HOOK_EVENTS = new Set<string>([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
]);

/** One HTTP-source agent hook to install. */
export interface AgentHookDef {
  slug: string;
  event: string;
  command: string;
  matcher?: string;
  timeout?: number;
}

/**
 * Return true if the tool supports agent hooks. All tools are supported except
 * cursor; each tool family dispatches to its own hook backend (settings.json for
 * claude/codex, config.yaml for hermes, HOOK.md + handler.ts for openclaw-family).
 */
export function isAgentHookSupportedTool(tool: string): boolean {
  return !CURSOR_TOOLS.has(tool);
}

/**
 * Return true if the event is in the whitelisted agent hook event set.
 */
export function isAgentHookEvent(event: string): boolean {
  return AGENT_HOOK_EVENTS.has(event);
}

/**
 * Generate the description marker for an agent hook entry.
 * Produces: `[teamai:agent-hook:<slug>]`
 */
export function agentHookDescription(slug: string): string {
  return `${TEAMAI_AGENT_HOOK_PREFIX}${slug}]`;
}

/** True if the HookMatcher entry is a teamai agent hook (optionally scoped to a slug). */
function isAgentClaudeEntry(entry: HookMatcher, slug?: string): boolean {
  const desc = entry.description ?? '';
  if (slug !== undefined) {
    return desc === agentHookDescription(slug);
  }
  return desc.startsWith(TEAMAI_AGENT_HOOK_PREFIX);
}

/**
 * Idempotently install or replace a single HTTP-source agent hook into a tool's
 * settings file. Claude format uses the marker description for precise replacement;
 * codex format uses the command for precise replacement. Only writes when content
 * has actually changed.
 */
export async function applyAgentHook(
  settingsPath: string,
  tool: string,
  def: AgentHookDef,
): Promise<void> {
  const format = detectFormat(tool);
  const expanded = expandHome(settingsPath);
  await ensureDir(path.dirname(expanded));

  const hookDef: HookDef = {
    source: 'team',
    key: def.slug,
    event: def.event,
    matcher: def.matcher ?? '*',
    command: def.command,
    ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
    description: agentHookDescription(def.slug),
  };

  // Codex entries carry no description field, so agent hooks are matched by
  // their exact command string (and tracked in the local-agent agent-hook
  // manifest, the authoritative record for codex teardown). Backends must use
  // a unique command per codex agent-hook slug so replace/remove stay precise.
  if (format === 'codex') {
    const hooksJson: CodexHooksJson = (await readJson<CodexHooksJson>(expanded)) ?? {};
    if (!hooksJson.hooks) hooksJson.hooks = {};
    const existing = hooksJson.hooks[def.event] ?? [];
    const untouched = existing.filter((e) => (e.hooks?.[0]?.command ?? '') !== def.command);
    const newArr = [...untouched, toCodexEntry(hookDef)];
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      hooksJson.hooks[def.event] = newArr;
      await writeJson(expanded, hooksJson);
      log.success(`Installed agent hook [${def.slug}] in ${settingsPath}`);
    } else {
      log.debug(`agent hook [${def.slug}] already up-to-date in ${settingsPath}`);
    }
  } else {
    const settings: ClaudeSettingsJson = (await readJson<ClaudeSettingsJson>(expanded)) ?? {};
    if (!settings.hooks) settings.hooks = {};
    const existing = settings.hooks[def.event] ?? [];
    const untouched = existing.filter((e) => !isAgentClaudeEntry(e, def.slug));
    const newArr = [...untouched, toClaudeEntry(hookDef)];
    if (JSON.stringify(existing) !== JSON.stringify(newArr)) {
      settings.hooks[def.event] = newArr;
      await writeJson(expanded, settings);
      log.success(`Installed agent hook [${def.slug}] in ${settingsPath}`);
    } else {
      log.debug(`agent hook [${def.slug}] already up-to-date in ${settingsPath}`);
    }
  }
}

/**
 * Remove a single agent hook from a tool's settings file by slug (claude) or
 * command (codex). Silent if the file does not exist or there is no matching entry.
 * Only writes when content has actually changed.
 */
export async function removeAgentHook(
  settingsPath: string,
  tool: string,
  opts: { slug: string; command?: string },
): Promise<void> {
  const expanded = expandHome(settingsPath);
  if (!(await pathExists(expanded))) return;
  const format = detectFormat(tool);

  // Codex removal matches by command (no marker in the file); callers pass the
  // command recorded in the agent-hook manifest, which is the source of truth
  // for codex teardown.
  if (format === 'codex') {
    if (!opts.command) return;
    const hooksJson: CodexHooksJson = (await readJson<CodexHooksJson>(expanded)) ?? {};
    if (!hooksJson.hooks) return;
    let changed = false;
    for (const event of Object.keys(hooksJson.hooks)) {
      const before = hooksJson.hooks[event];
      const after = before.filter((e) => (e.hooks?.[0]?.command ?? '') !== opts.command);
      if (after.length !== before.length) {
        changed = true;
        if (after.length === 0) {
          delete hooksJson.hooks[event];
        } else {
          hooksJson.hooks[event] = after;
        }
      }
    }
    if (changed) {
      await writeJson(expanded, hooksJson);
      log.success(`Removed agent hook [${opts.slug}] from ${settingsPath}`);
    }
  } else {
    const settings: ClaudeSettingsJson = (await readJson<ClaudeSettingsJson>(expanded)) ?? {};
    if (!settings.hooks) return;
    let changed = false;
    for (const event of Object.keys(settings.hooks)) {
      const before = settings.hooks[event];
      const after = before.filter((e) => !isAgentClaudeEntry(e, opts.slug));
      if (after.length !== before.length) {
        changed = true;
        if (after.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = after;
        }
      }
    }
    if (changed) {
      await writeJson(expanded, settings);
      log.success(`Removed agent hook [${opts.slug}] from ${settingsPath}`);
    }
  }
}

// ─── Public reconcile API ───────────────────────────────────

/**
 * Reconcile a single tool settings/hooks file to the desired teamai hook set
 * (built-in A + supplied team B defs). Idempotent; only writes on change.
 */
export async function reconcileHooks(
  settingsPath: string,
  tool: string,
  teamDefs: HookDef[] = [],
  opts: ReconcileHooksOptions = {},
): Promise<void> {
  const teamActive = !!opts.manifestPath;
  const manifest = opts.manifestPath ? await readManifest(opts.manifestPath) : null;
  const allPriorRecords = manifest?.[tool] ?? [];
  const priorRecords = opts.teamHookProjectRoot
    ? allPriorRecords.filter((r) => isGatedForProject(r.command, opts.teamHookProjectRoot!))
    : allPriorRecords;
  const priorTeamCommands = new Set(priorRecords.map((r) => r.command));
  const scopedDefs = scopedTeamDefs(teamDefs, opts.teamHookProjectRoot, tool);
  const desiredTeamCommands = new Set(scopedDefs.filter((d) => !d.tools || d.tools.includes(tool)).map((d) => d.command));

  const format = detectFormat(tool);
  if (format === 'cursor') {
    await reconcileCursorFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else if (format === 'copilot') {
    await reconcileCopilotFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else if (format === 'codex') {
    await reconcileCodexFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else if (format === 'zcode') {
    await reconcileZcodeFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else {
    await reconcileClaudeFormat(settingsPath, tool, scopedDefs, {
      ...opts,
      // In a shared HOME settings file, only remove team entries belonging to
      // this project. User-scope installs retain the historical marker sweep.
      teamHookProjectRoot: opts.teamHookProjectRoot,
    }, teamActive, desiredTeamCommands, priorTeamCommands);
  }

  // Update the manifest's team-hook index for this tool (when manifest is active).
  if (opts.manifestPath && manifest) {
    const records = manifestRecordsForTool(teamDefs, tool, !!opts.removeAll, opts.teamHookProjectRoot);
    const prev = manifest[tool] ?? [];
    const retained = opts.teamHookProjectRoot
      ? prev.filter((r) => !isGatedForProject(r.command, opts.teamHookProjectRoot!))
      : prev.filter((r) => isProjectGatedCommand(r.command));
    const nextRecords = [...retained, ...records];
    const sameAsPrev = JSON.stringify(prev) === JSON.stringify(nextRecords);
    const hadEntry = Object.prototype.hasOwnProperty.call(manifest, tool);
    if (nextRecords.length === 0) {
      if (hadEntry) {
        delete manifest[tool];
        await writeJson(expandHome(opts.manifestPath), manifest);
      }
    } else if (!sameAsPrev) {
      manifest[tool] = nextRecords;
      await writeJson(expandHome(opts.manifestPath), manifest);
    }
  }
}

// ─── Back-compatible public API (built-in A only) ───────────

/** Inject teamai built-in hooks into a tool's settings/hooks file. */
export async function injectHooks(settingsPath: string, tool?: string): Promise<void> {
  await reconcileHooks(settingsPath, tool ?? 'claude', []);
}

/** Remove all teamai hooks from a tool's settings/hooks file. */
export async function removeHooks(settingsPath: string, tool?: string): Promise<void> {
  await reconcileHooks(settingsPath, tool ?? 'claude', [], { removeAll: true });
}

/**
 * Report whether the current built-in (A) hook set is present in a tool settings
 * file. Computed against the unified HookDef model: every built-in entry for the
 * tool must already exist on disk.
 *
 * `builtinOverride` is the team's §4.8 override. Reconciliation applies it when
 * writing, so the status check must apply it too — otherwise a hook the team
 * disabled is still expected on disk and every tool reads as `missing`.
 */
export async function getHookStatus(
  settingsPath: string,
  tool?: string,
  builtinOverride?: BuiltinHookOverride,
): Promise<HookStatus> {
  const toolName = tool ?? 'claude';
  const expanded = expandHome(settingsPath);
  const defs = applyBuiltinOverride(builtinHookDefs(toolName), builtinOverride);

  const format = detectFormat(toolName);
  if (format === 'cursor') {
    const hooksJson = await readJson<CursorHooksJson>(expanded);
    if (!hooksJson?.hooks) return 'missing';
    const present = defs.every((def) => {
      const cursorEvent = CLAUDE_TO_CURSOR_EVENTS[def.event];
      if (!cursorEvent) return true;
      const want = toCursorEntry(def);
      const entries = hooksJson.hooks[cursorEvent] ?? [];
      return entries.some((e) => e.command === want.command && e.matcher === want.matcher);
    });
    return present ? 'installed' : 'missing';
  }

  if (format === 'copilot') {
    const hooksJson = await readJson<CopilotHooksJson>(expanded);
    if (hooksJson?.version !== COPILOT_HOOK_SCHEMA_VERSION || !hooksJson.hooks) return 'missing';
    const present = defs.every((def) => {
      const event = CLAUDE_TO_COPILOT_EVENTS[def.event];
      if (!event) return true;
      const want = toCopilotEntry(def);
      return (hooksJson.hooks[event] ?? []).some((entry) =>
        entry.type === want.type
        && entry.bash === want.bash
        && entry.powershell === want.powershell
        && entry.command === want.command
        && entry.matcher === want.matcher,
      );
    });
    return present ? 'installed' : 'missing';
  }

  if (format === 'codex') {
    const hooksJson = await readJson<CodexHooksJson>(expanded);
    if (!hooksJson?.hooks) return 'missing';
    const present = defs.every((def) => {
      const want = toCodexEntry(def);
      const entries = hooksJson.hooks?.[def.event] ?? [];
      return entries.some((e) => e.matcher === want.matcher && e.hooks?.[0]?.command === want.hooks[0].command);
    });
    return present ? 'installed' : 'missing';
  }

  if (format === 'zcode') {
    const vbsPath = path.join(path.dirname(expanded), 'teamai-hook-dispatch.vbs');
    const cfg = await readJson<ZcodeHooksJson>(expanded);
    const eventsMap = cfg?.hooks?.events;
    if (!eventsMap) return 'missing';
    // On Windows the entries are dead without the launcher script — a deleted,
    // stale, or AV-quarantined VBS must not be reported as installed.
    if (process.platform === 'win32' && !(await readFileSafe(vbsPath))) return 'missing';
    const present = defs.every((def) => {
      const want = toZcodeEntry(def, vbsPath);
      const wantCmd = zcodeEntryCommand(want);
      const entries = eventsMap[def.event] ?? [];
      return entries.some((e) => e.matcher === want.matcher && zcodeEntryCommand(e) === wantCmd);
    });
    return present ? 'installed' : 'missing';
  }

  const settings = await readJson<ClaudeSettingsJson>(expanded);
  if (!settings?.hooks) return 'missing';
  const present = defs.every((def) => {
    const want = toClaudeEntry(def);
    const entries = settings.hooks?.[def.event] ?? [];
    return entries.some((e) => e.matcher === want.matcher && e.hooks?.[0]?.command === want.hooks[0].command);
  });
  return present ? 'installed' : 'missing';
}

/**
 * Report whether a tool settings/hooks file currently holds ANY teamai-managed
 * hook entry (built-in A or team B). Unlike getHookStatus (which checks the full
 * built-in set is present), this returns true if even one teamai entry remains.
 * Used by `uninstall --agent` to decide whether a tool still has teamai hooks.
 * Manifest records must still exist in the file to count — stale manifest entries
 * (user hand-stripped the hook) are ignored.
 */
export async function hasTeamaiHooks(
  settingsPath: string,
  tool: string,
  manifestPath?: string,
): Promise<boolean> {
  const manifest = manifestPath ? await readManifest(manifestPath) : null;
  // Manifest records are only a signal when the recorded command still exists in
  // the settings file. A stale manifest entry (user hand-stripped the hook) must
  // NOT count as "still using teamai" — intersect manifest with actual content.
  const priorTeamCommands = new Set((manifest?.[tool] ?? []).map((r) => r.command));

  const expanded = expandHome(settingsPath);
  const format = detectFormat(tool);

  if (format === 'cursor') {
    const j = await readJson<CursorHooksJson>(expanded);
    if (!j?.hooks) return false;
    return Object.values(j.hooks).some((entries) =>
      (entries ?? []).some((e) => isTeamaiHookCommand(e.command) || priorTeamCommands.has(e.command)),
    );
  }
  if (format === 'copilot') {
    const j = await readJson<CopilotHooksJson>(expanded);
    if (!j?.hooks) return false;
    return Object.values(j.hooks).some((entries) =>
      (entries ?? []).some((entry) => copilotEntryCommands(entry).some((command) =>
        TEAMAI_COMMAND_MARKERS.some((marker) => command.includes(marker))
        || priorTeamCommands.has(command),
      )),
    );
  }

  if (format === 'codex') {
    const j = await readJson<CodexHooksJson>(expanded);
    if (!j?.hooks) return false;
    return Object.values(j.hooks).some((entries) =>
      (entries ?? []).some((e) => {
        const cmd = e.hooks?.[0]?.command ?? '';
        return TEAMAI_COMMAND_MARKERS.some((m) => cmd.includes(m)) || priorTeamCommands.has(cmd);
      }),
    );
  }

  if (format === 'zcode') {
    const j = await readJson<ZcodeHooksJson>(expanded);
    const eventsMap = j?.hooks?.events;
    if (!eventsMap) return false;
    return Object.values(eventsMap).some((entries) =>
      (entries ?? []).some((e) => {
        const cmd = zcodeEntryCommand(e);
        return TEAMAI_COMMAND_MARKERS.some((m) => cmd.includes(m)) || priorTeamCommands.has(cmd);
      }),
    );
  }

  const s = await readJson<ClaudeSettingsJson>(expanded);
  if (!s?.hooks) return false;
  return Object.values(s.hooks).some((entries) =>
    (entries ?? []).some((e) => {
      if (isBuiltinClaudeEntry(e) || isTeamClaudeEntry(e)) return true;
      const cmd = e.hooks?.[0]?.command ?? '';
      return priorTeamCommands.has(cmd);
    }),
  );
}

/**
 * Reconcile the single teamai OpenCode plugin.
 *
 * OpenCode auto-loads plugins from BOTH `~/.config/opencode/plugin` and
 * `<project>/.opencode/plugin`, so a project-scope copy living next to a
 * user-scope one makes OpenCode load two identical plugins and dispatch every
 * event twice. teamai therefore keeps exactly one copy, in the user plugin dir —
 * matching the settings.json hooks of every other tool, which also live in HOME
 * and gate on the `cwd` fed to `hook-dispatch`. Any project-scope copy left by
 * an earlier layout is deleted on the way through.
 */
async function reconcileOpencodePlugin(baseDir: string, removeAll = false, installedBaseDir?: string): Promise<void> {
  const home = getUserHome();
  const { injectOpencodeHooks, removeOpencodeHooks } = await import('./opencode-hooks.js');
  if (path.resolve(baseDir) !== path.resolve(home)) {
    await removeOpencodeHooks(baseDir, 'project');
  }
  if (removeAll) {
    await removeOpencodeHooks(home, 'user');
    return;
  }
  const homeInstalled = await pathExists(path.join(home, '.config', 'opencode'));
  const projectInstalled = installedBaseDir
    ? await pathExists(path.join(installedBaseDir, '.opencode'))
    : false;
  if (homeInstalled || projectInstalled) {
    await injectOpencodeHooks(home, 'user');
  }
}

/**
 * Reconcile the single teamai OMP extension.
 *
 * OMP auto-loads extensions from BOTH ~/.omp/agent/extensions (user) and
 * <cwd>/.omp/extensions (project), and dedups by absolute path — two copies
 * of the teamai file would dispatch every event twice. teamai therefore
 * writes exactly one copy, in the user agent dir, matching the OpenCode
 * plugin policy and the settings.json hooks of every other tool (which also
 * live in HOME and gate on the `cwd` fed to hook-dispatch). Install only when
 * ~/.omp exists, so a machine without OMP never grows a config dir.
 */
async function reconcileOmpExtension(removeAll = false): Promise<void> {
  const home = getUserHome();
  const { injectOmpHooks, removeOmpHooks } = await import('./omp-hooks.js');
  if (removeAll) {
    await removeOmpHooks();
    return;
  }
  if (await pathExists(path.join(home, '.omp'))) {
    await injectOmpHooks();
  }
}

/** True when Pi looks installed at the user or the resolved project root. */
async function isPiInstalled(baseDir: string, installedBaseDir?: string): Promise<boolean> {
  return await pathExists(path.join(getUserHome(), '.pi'))
    || await pathExists(path.join(installedBaseDir ?? baseDir, '.pi'));
}

/**
 * Reconcile the single TeamAI Pi extension in the user agent directory. Pi
 * also auto-loads a project extensions dir with absolute-path dedup, so
 * writing a second copy there would dispatch every event twice (the same
 * single-copy policy as the OMP adapter) — only the user-scope copy is ever
 * written. A TeamAI-marked project copy left by an earlier revision is
 * cleaned up when reconciling that project. Mirrors the OMP adapter on
 * removal too: any `removeAll` pass — a scoped `uninstall --agent pi` or the
 * explicit `hooks remove` command — deletes the single global copy outright.
 * Pi has no way to scope a shared file to one project, so a "preserve for
 * other projects" guarantee was never actually enforceable at dispatch time
 * anyway (the generated extension fires for every Pi session regardless of
 * which project asked to be excluded).
 */
async function reconcilePiExtension(
  baseDir: string,
  removeAll = false,
  installedBaseDir?: string,
): Promise<void> {
  const home = getUserHome();
  const { injectPiHooks, removePiHooks, removePiProjectHooks } = await import('./pi-hooks.js');
  const inferredProjectScope = path.resolve(baseDir) !== path.resolve(home);
  const projectRoot = installedBaseDir ?? (inferredProjectScope ? baseDir : undefined);

  if (projectRoot && path.resolve(projectRoot) !== path.resolve(home)) {
    await removePiProjectHooks(projectRoot);
  }
  if (removeAll) {
    await removePiHooks();
    return;
  }
  if (await isPiInstalled(baseDir, installedBaseDir)) await injectPiHooks();
}

/**
 * Inject teamai built-in hooks into all AI tool settings.
 * Only writes to tools whose root directory already exists on disk,
 * preventing creation of config dirs for tools the user hasn't installed.
 */
export async function injectHooksToAllTools(toolPaths: Record<string, { settings?: string }>, baseDir?: string, filterAgents?: string[]): Promise<void> {
  const resolvedBaseDir = baseDir ?? getUserHome();
  const skipped = skipToolsWithoutShell(
    Object.keys(toolPaths).filter(t => !filterAgents || filterAgents.includes(t)),
  );
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (filterAgents && !filterAgents.includes(tool)) continue;
    if (skipped.has(tool)) continue;
    if (tool === 'pi') {
      try {
        await reconcilePiExtension(resolvedBaseDir);
      } catch (e) {
        log.warn(`Failed to inject Pi hook: ${(e as Error).message}`);
      }
    } else if (paths.settings) {
      const toolRoot = path.join(resolvedBaseDir, paths.settings.split('/')[0]);
      if (!await pathExists(toolRoot)) continue;
      const settingsPath = path.join(resolvedBaseDir, paths.settings);
      try {
        await injectHooks(settingsPath, tool);
      } catch (e) {
        log.warn(`Failed to inject hook into ${tool}: ${(e as Error).message}`);
      }
    } else if (OPENCLAW_TOOLS.has(tool)) {
      try {
        const { injectOpenClawHooks } = await import('./openclaw-hooks.js');
        await injectOpenClawHooks(undefined, tool);
      } catch (e) {
        log.warn(`Failed to inject OpenClaw hook into ${tool}: ${(e as Error).message}`);
      }
    } else if (tool === 'hermes') {
      try {
        const { injectHermesHooks } = await import('./hermes-hooks.js');
        await injectHermesHooks();
      } catch (e) {
        log.warn(`Failed to inject Hermes hook: ${(e as Error).message}`);
      }
    } else if (tool === 'opencode') {
      try {
        await reconcileOpencodePlugin(resolvedBaseDir);
      } catch (e) {
        log.warn(`Failed to inject OpenCode hook into ${tool}: ${(e as Error).message}`);
      }
    } else if (tool === 'omp') {
      try {
        await reconcileOmpExtension();
      } catch (e) {
        log.warn(`Failed to inject OMP hook into ${tool}: ${(e as Error).message}`);
      }
    }
  }
}

/**
 * Reconcile built-in (A) + team (B) hooks across every tool that has a settings
 * path, using a shared managed-hooks manifest. This is the authoritative
 * injection path used by `teamai pull` / `init` / `hooks inject`.
 *
 * `settingsOnly` restricts the pass to tools reconciled through their settings
 * file, skipping Hermes, OpenCode, and OMP. Those three go through global
 * adapters that ignore `baseDir` — `removeHermesHooks()` takes none, and the
 * OpenCode / OMP adapters' removeAll branches always target HOME — so a caller
 * sweeping a secondary location (the legacy `<projectRoot>` copy) must opt out,
 * or it deletes the hooks the primary pass just installed.
 */
export async function reconcileHooksToAllTools(
  toolPaths: Record<string, { settings?: string }>,
  baseDir: string,
  teamDefs: HookDef[],
  manifestPath: string,
  opts: { removeAll?: boolean; builtinOverride?: BuiltinHookOverride; filterAgents?: string[]; settingsOnly?: boolean; installedBaseDir?: string; teamHookProjectRoot?: string; scope?: Scope } = {},
): Promise<void> {
  // Removal is JSON editing and needs no shell, so the gate only applies to
  // injection passes — otherwise tools without a shell could never clean up
  // their injected entries.
  const skipped = opts.removeAll
    ? new Set<string>()
    : skipToolsWithoutShell(
        Object.keys(toolPaths).filter(t => !opts.filterAgents || opts.filterAgents.includes(t)),
      );
  // One settings file is one install. Two targets can resolve to the same file —
  // Qoder CN's project scope IS Qoder's `<root>/.qoder/settings.json` — and this
  // pass is per tool, so a second pass over the file re-renders every built-in
  // entry with the *other* tool's dispatch identity (`teamai hook-dispatch …
  // --tool <tool>`) and drops the team hooks scoped to the first one. Reconcile
  // each file once, for the first target that reaches it.
  //
  // The owner is the first *enabled* target, not the first in the shipped table:
  // `filterAgents` is applied above, so a tool the user excluded is skipped before
  // it can claim a file, and an install that enabled Qoder CN without Qoder gets
  // `--tool qoder-cn` built-ins plus its `tools: [qoder-cn]` team hooks in the
  // shared project file instead of Qoder's identity (and Qoder's team hooks).
  //
  // With both editions enabled (the default: no whitelist) `qoder` comes first in
  // the table and keeps ownership, so a `tools: [qoder-cn]` team hook has no file
  // to land in and is dropped silently by the per-tool filter in reconcileHooks.
  // One physical file can carry only one dispatch identity; this is the documented
  // limit of sharing a project scope, not a bug this pass can fix.
  const claimedSettingsFiles = new Set<string>();
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (opts.filterAgents && !opts.filterAgents.includes(tool)) continue;
    if (skipped.has(tool)) continue;
    // Hermes uses config.yaml (YAML) + a script dir + allowlist instead of a
    // JSON settings file, so it bypasses the settings-based reconcile path.
    // Install when the .hermes home exists; removeAll clears the teamai hook.
    if (tool === 'hermes') {
      if (opts.settingsOnly) continue;
      try {
        const { getHermesHome } = await import('./hermes-home.js');
        const hermesRoot = getHermesHome();
        if (opts.removeAll) {
          const { removeHermesHooks } = await import('./hermes-hooks.js');
          await removeHermesHooks();
        } else if (await pathExists(hermesRoot)) {
          const { injectHermesHooks } = await import('./hermes-hooks.js');
          await injectHermesHooks();
        }
      } catch (e) {
        log.warn(`Failed to reconcile Hermes hooks: ${(e as Error).message}`);
      }
      continue;
    }
    // OpenClaw has no settings hook list either: its hook is a HOOK.md +
    // handler.ts pair under the resolved workspace dir. Route it to that
    // adapter, which no-ops when the workspace cannot be resolved, so an
    // uninstalled OpenClaw never grows a config dir. Only `openclaw` itself:
    // resolveOpenclawWorkspaceDir resolves the OpenClaw workspace, so routing
    // the other claw variants here would make them overwrite that one handler
    // with each other's --tool value.
    if (tool === 'openclaw') {
      if (opts.settingsOnly) continue;
      try {
        if (opts.removeAll) {
          const { removeOpenClawHooks, resolveOpenclawWorkspaceDir } = await import('./openclaw-hooks.js');
          const wsDir = await resolveOpenclawWorkspaceDir();
          if (wsDir) await removeOpenClawHooks(path.join(wsDir, 'hooks'));
        } else {
          const { injectOpenClawHooks } = await import('./openclaw-hooks.js');
          await injectOpenClawHooks(undefined, tool);
        }
      } catch (e) {
        log.warn(`Failed to reconcile OpenClaw hooks for ${tool}: ${(e as Error).message}`);
      }
      continue;
    }
    // OpenCode has no settings.json hook list; it auto-loads JS/TS plugins from
    // its config dirs. Route it to the plugin-file adapter instead of the
    // settings-based path.
    if (tool === 'opencode') {
      if (opts.settingsOnly) continue;
      try {
        await reconcileOpencodePlugin(baseDir, opts.removeAll, opts.installedBaseDir);
      } catch (e) {
        log.warn(`Failed to reconcile OpenCode hooks: ${(e as Error).message}`);
      }
      continue;
    }
    // OMP likewise has no settings hook list: it auto-loads TS extensions from
    // the agent dir. Route it to the extension adapter.
    if (tool === 'omp') {
      if (opts.settingsOnly) continue;
      try {
        await reconcileOmpExtension(opts.removeAll);
      } catch (e) {
        log.warn(`Failed to reconcile OMP hooks: ${(e as Error).message}`);
      }
      continue;
    }
    if (tool === 'pi') {
      if (opts.settingsOnly) continue;
      try {
        // Only warn about skipped team/override hooks when Pi is actually
        // installed — Pi is in every team's default toolPaths, so without this
        // gate teammates who never use Pi see this warning on every
        // reconcile whenever the team defines a Pi-targeted hook.
        if (!opts.removeAll && await isPiInstalled(baseDir, opts.installedBaseDir)) {
          const applicableTeamDefs = teamDefsForTool(teamDefs, 'pi');
          if (applicableTeamDefs.length > 0) {
            log.warn(
              `Pi supports built-in lifecycle hooks only; skipping ${applicableTeamDefs.length} custom team hook(s) from hooks/hooks.yaml`,
            );
          }
          const builtinOverrideCount = (opts.builtinOverride?.disabled?.length ?? 0)
            + Object.keys(opts.builtinOverride?.overrides ?? {}).length;
          if (builtinOverrideCount > 0) {
            log.warn(
              `Pi supports built-in lifecycle hooks only; skipping ${builtinOverrideCount} built-in hook override(s) from hooks/hooks.yaml`,
            );
          }
        }
        await reconcilePiExtension(baseDir, opts.removeAll, opts.installedBaseDir);
      } catch (e) {
        log.warn(`Failed to reconcile Pi hooks: ${(e as Error).message}`);
      }
      continue;
    }
    // DeepSeek Harness has no settings-file hook surface. Its official
    // Claude-hook bridge is a Cordis plugin loaded through a user-supplied
    // profile patch, so keep the generated config and patch in ~/.teamai.
    if (tool === 'dsh') {
      if (opts.settingsOnly) continue;
      try {
        const dshHome = getUserHome();
        if (opts.removeAll || await pathExists(path.join(dshHome, '.dsh'))) {
          const { reconcileDshHooks } = await import('./dsh-hooks.js');
          await reconcileDshHooks(teamDefs, {
            manifestPath,
            removeAll: opts.removeAll,
            builtinOverride: opts.builtinOverride,
          });
        }
      } catch (e) {
        log.warn(`Failed to reconcile DeepSeek Harness hooks: ${(e as Error).message}`);
      }
      continue;
    }
    if (!paths.settings) continue;
    // Only reconcile hooks for tools the user actually has installed. Without
    // this gate, `hooks inject`/`remove` would create root directories for
    // every configured tool (e.g. ~/.tclaude, ~/.tcodex) via reconcileHooks's
    // ensureDir — making uninstalled tools look installed and pulling skills
    // into them on later `pull`s.
    const toolRoot = path.join(baseDir, paths.settings.split('/')[0]);
    const installedRoot = opts.installedBaseDir
      ? path.join(opts.installedBaseDir, paths.settings.split('/')[0])
      : toolRoot;
    if (!await pathExists(toolRoot) && !await pathExists(installedRoot)) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    const settingsFileKey = path.resolve(settingsPath);
    if (claimedSettingsFiles.has(settingsFileKey)) continue;
    claimedSettingsFiles.add(settingsFileKey);
    try {
      await reconcileHooks(settingsPath, tool, teamDefs, {
        manifestPath,
        removeAll: opts.removeAll,
        builtinOverride: opts.builtinOverride,
        teamHookProjectRoot: opts.teamHookProjectRoot,
      });
    } catch (e) {
      log.warn(`Failed to reconcile hooks for ${tool}: ${(e as Error).message}`);
    }
  }
}

/**
 * True if a trust-gated Codex tool (the public `codex`) is both configured with
 * a settings path and actually installed on disk under baseDir.
 *
 * "Installed" uses the same root-directory gate as reconcileHooksToAllTools, so
 * a true result means inject just wrote hooks that Codex may require the user to
 * trust. Internal variants (codex-internal / tcodex) are excluded — they share
 * the format but not the trust gate. Used to decide whether to print the
 * reminder after inject.
 */
export async function hasInstalledCodexTrustGatedTool(
  toolPaths: Record<string, { settings?: string }>,
  baseDir: string,
): Promise<boolean> {
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!isCodexTrustGatedTool(tool) || !paths.settings) continue;
    const toolRoot = path.join(baseDir, paths.settings.split('/')[0]);
    if (await pathExists(toolRoot)) return true;
  }
  return false;
}

/**
 * Sweep the legacy `<projectRoot>` hook copy a pre-#370 CLI wrote alongside
 * HOME for a non-self project scope. Without it both copies stay live after an
 * upgrade and every session start fires hook-dispatch twice (two concurrent
 * background pulls), and the auto-migrate guard never converges.
 *
 * Shared by the inject path (`init`/`pull`/`bootstrap`), `hooks inject`, and
 * `hooks remove` so all three sweep identically. Two rules this encodes:
 *
 * - `settingsOnly` — Hermes and OpenCode reconcile through global adapters that
 *   ignore `baseDir` (removeHermesHooks() takes none; the OpenCode adapter's
 *   removeAll branch always targets HOME), so letting a secondary-location
 *   sweep reach them deletes the hooks the primary pass just installed. The
 *   project-scope OpenCode plugin is instead removed directly below, which is
 *   the only OpenCode copy this legacy location can own.
 * - No `filterAgents` — cleanup of a legacy location must be unconditional. A
 *   tool disabled today may well be the one that wrote the stale copy back when
 *   it was enabled; filtering it out would leave that copy firing forever.
 */
export async function sweepLegacyProjectHooks(
  toolPaths: Record<string, { settings?: string }>,
  localConfig: LocalConfig,
): Promise<void> {
  const legacy = resolveLegacyProjectHookScope(localConfig);
  if (!legacy) return;
  await reconcileHooksToAllTools(toolPaths, legacy.baseDir, [], legacy.manifestPath, {
    removeAll: true,
    settingsOnly: true,
  });
  if (toolPaths.opencode) {
    try {
      const { removeOpencodeHooks } = await import('./opencode-hooks.js');
      await removeOpencodeHooks(legacy.baseDir, 'project');
    } catch (e) {
      log.warn(`Failed to remove legacy OpenCode project plugin: ${(e as Error).message}`);
    }
  }
  if (toolPaths.pi) {
    try {
      const { removePiProjectHooks } = await import('./pi-hooks.js');
      await removePiProjectHooks(legacy.baseDir);
    } catch (e) {
      log.warn(`Failed to remove legacy Pi project extension: ${(e as Error).message}`);
    }
  }
}

/**
 * Reconcile built-in (A) + team (B) hooks for a single scope's tools.
 * Parses the scope's hooks/hooks.yaml, resolves the scope base dir + manifest,
 * and reconciles every tool. Returns the team defs that were applied (for
 * logging/transparency). Used by `pull`, `init`, and `hooks inject`.
 */
export async function reconcileTeamHooksForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  opts: { removeAll?: boolean; auto?: boolean; silent?: boolean; filterAgents?: string[] } = {},
): Promise<HookDef[]> {
  const { defs: teamDefs, builtin } = opts.removeAll
    ? { defs: [] as HookDef[], builtin: undefined }
    : await resolveTeamHooks(teamConfig, localConfig.repo.localPath, {
        auto: opts.auto,
        silent: opts.silent,
        membership: resolveMembership(localConfig),
      });
  const { baseDir, manifestPath, scope: hookScope } = resolveHookScope(localConfig);
  const explicitlySelectedAgents = opts.filterAgents ?? localConfig.enabledAgents;
  let filterAgents = explicitlySelectedAgents;
  const disabled = localConfig.disabledAgents;
  if (disabled && disabled.length > 0) {
    // Exclusion always applies, even when there is no whitelist. When no
    // whitelist exists, start from the full configured tool set.
    const universe = filterAgents ?? Object.keys(teamConfig.toolPaths);
    filterAgents = universe.filter((t) => !disabled.includes(t));
  }
  // Resolve the tool paths at the scope hooks actually live in, not at the
  // config's scope: a non-self project scope puts hooks in HOME, so its paths
  // must be the user-scope ones.
  await reconcileHooksToAllTools(scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope }), baseDir, teamDefs, manifestPath, {
    removeAll: opts.removeAll,
    builtinOverride: builtin,
    filterAgents,
    teamHookProjectRoot: localConfig.scope === 'project' && !isSelfMode(localConfig)
      ? localConfig.projectRoot
      : undefined,
    installedBaseDir: localConfig.scope === 'project' ? (localConfig.projectRoot ?? baseDir) : undefined,
    scope: localConfig.scope,
  });

  const copilotExcluded = disabled?.includes(COPILOT_TOOL_ID) ?? false;
  const copilotSelected = !copilotExcluded
    && (explicitlySelectedAgents?.includes(COPILOT_TOOL_ID) ?? false);
  const copilotEnabled = !copilotExcluded && (
    copilotSelected
    || (explicitlySelectedAgents === undefined && await pathExists(getCopilotHome()))
  );
  const copilotPaths = scopedToolPaths(teamConfig, localConfig)[COPILOT_TOOL_ID];
  if (copilotEnabled && copilotPaths?.hooks) {
    const copilotBase = resolveToolBaseDir(COPILOT_TOOL_ID, localConfig);
    if (copilotSelected || await pathExists(getCopilotHome())) {
      await reconcileHooks(
        path.join(copilotBase, copilotPaths.hooks),
        COPILOT_TOOL_ID,
        teamDefs,
        {
          manifestPath: getManagedHooksPath(localConfig.scope, localConfig.projectRoot),
          removeAll: opts.removeAll,
          builtinOverride: builtin,
        },
      );
    }
  }
  await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig);
  return teamDefs;
}
