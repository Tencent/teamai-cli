import { CODEX_TOOL_IDS } from './utils/tool-names.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync } from 'node:fs';
import { lstat, rm, stat } from 'node:fs/promises';
import { readJson, readJsonObject, writeJson, readFileSafe, writeFile, expandHome, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import {
  COPILOT_TOOL_ID,
  TEAMAI_HOOK_DESCRIPTION_PREFIX,
  TEAMAI_CUSTOM_HOOK_PREFIX,
  TEAMAI_AGENT_HOOK_PREFIX,
  getManagedHooksPath,
  legacyManagedHooksPath,
  getCopilotHome,
  resolveHookScope,
  resolveLegacyProjectHookScope,
  resolveToolBaseDir,
  scopedToolPaths,
  toolInstallRoot,
} from './types.js';
import type { HookDef, TeamaiConfig, LocalConfig, ManagedMcpManifest, Scope } from './types.js';
import {
  CODEX_TOOL_ID,
  DEFAULT_CODEX_ROOT,
  getDataHome,
  isGitExcludeEnabled,
  getTeamaiHome,
  isAgentExcluded,
  isSelfMode,
  managedMcpManifestKey,
  managedMcpManifestPath,
  managedMcpWorkspaceId,
  resolveGitExclude,
  resolveToolRootDir,
} from './types.js';
import { builtinHookDefs, applyBuiltinOverride, getRawDispatchCommand, skipToolsWithoutShell } from './builtin-hooks.js';
import type { BuiltinHookOverride } from './builtin-hooks.js';
import { parseTeamHooks, resolveTeamHooks, teamHookToDef } from './resources/hooks.js';
import { entryLayout } from './namespaced-entries.js';
import { historicalContents } from './utils/team-history.js';
import { getUserHome } from './utils/home.js';
import { CLAUDE_HOOK_OTHER_HOST_SKIP } from './claude-hook-host.js';
import { listWorktrees, resolveAnchors } from './utils/git.js';
import { findOnPath } from './utils/lookpath.js';
import type { CodexHookTrustReport, CodexTrust } from './codex-trust.js';
import { dispatchedCodexHooks, isCodexTeamHookDispatcher, reconcileCodexDispatchers, runsFromCodexDispatcher, setCodexDispatcherHooks } from './codex-team-hooks.js';
import type { CodexTeamHook } from './codex-team-hooks.js';

export { CLAUDE_HOOK_OTHER_HOST_SKIP };

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
  additionalContextLimit?: number;
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
 * Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) does: it skips a hook
 * whose hash is not recorded as trusted in its `config.toml`, so after every
 * write teamai trusts the hooks it wrote through `codex app-server`
 * (codex-trust.ts, #955). The internal variants (`codex-internal`, `tcodex`)
 * share the codex hooks.json *format* but not this trust gate, so they are
 * intentionally excluded.
 */
const CODEX_TRUST_GATE_TOOLS = new Set(['codex']);

/**
 * True for a tool that gates hooks behind an explicit user trust step (only the
 * public `codex`). Exported so `hooks inject` / `doctor` can surface it.
 */
export function isCodexTrustGatedTool(tool: string): boolean {
  return CODEX_TRUST_GATE_TOOLS.has(tool);
}

/**
 * One-line reminder that Codex may require the user to trust newly written
 * hooks before they run, for when teamai could not trust them itself (no
 * `codex` on PATH, a failure, or the member's `codexTrustEnabled: false`).
 * Shared with `doctor` (installed-hooks note) so the wording stays identical.
 */
export function codexTrustReminder(): string {
  return 'Codex hooks written, but Codex may require you to review/trust them before they run — open /hooks or Settings → Hooks in Codex to trust them. '
    + 'Until you do, a project\'s team rules do not reach Codex: they come through those hooks.';
}

/**
 * Report what trusting the written Codex hooks did. `all` is for commands that
 * write hooks on request (`init`, `hooks inject`); `problems` is for an
 * interactive pull, which only speaks up when trusting failed or Codex keeps a
 * project untrusted.
 */
export function reportCodexTrust(trust: CodexTrust | undefined, mode: 'all' | 'problems'): void {
  if (!trust) return;
  switch (trust.kind) {
    case 'trusted':
      if (trust.hooks > 0 && mode === 'all') log.success(`Trusted ${trust.hooks} teamai hook(s) in Codex`);
      else log.debug(`Codex: trusted ${trust.hooks} teamai hook(s)`);
      return;
    case 'project-untrusted':
      log.warn(`Codex marks ${trust.project} as untrusted, so it does not load teamai's project hooks or MCP configuration. `
        + 'teamai leaves that choice to you: trust the project in Codex to load its configuration.');
      return;
    case 'disabled':
    case 'unavailable':
      if (mode === 'all') log.warn(codexTrustReminder());
      else log.debug(`Codex hooks not trusted: ${trust.kind === 'disabled' ? 'codexTrustEnabled is false' : trust.reason}`);
      return;
    case 'failed':
      log.warn(`Could not trust the teamai hooks in Codex (${trust.reason}). ${codexTrustReminder()}`);
      return;
    default: {
      const unhandled: never = trust;
      return unhandled;
    }
  }
}

/** Known teamai command substrings used to identify built-in / legacy hooks. */
const TEAMAI_COMMAND_MARKERS = [
  'teamai pull', 'teamai update', 'teamai track', 'teamai dashboard', 'teamai contribute-check',
  'teamai auto-recall', 'teamai todowrite-hint', 'teamai mr-hint', 'teamai hook-dispatch',
];

function isTeamaiHookCommand(command: string): boolean {
  return /(?:^|"|\s)teamai\s/.test(command);
}

/** Filter team defs down to those that apply to the given tool. */
function teamDefsForTool(teamDefs: HookDef[], tool: string): HookDef[] {
  return teamDefs.filter((d) => !d.tools || d.tools.includes(tool));
}

/**
 * Build the per-tool desired HookDef set: built-in (A) followed by team (B).
 * `teamOnly` leaves the built-ins out, for a file that holds team hooks only
 * (the main checkout's, see MAIN_CHECKOUT_TEAM_HOOK_TOOLS).
 */
function desiredDefs(
  tool: string,
  teamDefs: HookDef[],
  opts: { builtinOverride?: BuiltinHookOverride; teamOnly?: boolean },
): HookDef[] {
  const builtins = opts.teamOnly ? [] : applyBuiltinOverride(builtinHookDefs(tool), opts.builtinOverride);
  return [...builtins, ...teamDefsForTool(teamDefs, tool)];
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
  /** Legacy ownership of the same project file, transferred after reconciliation. */
  legacyManifestPath?: string;
  /** §4.8 team override of built-in hooks (disabled / timeout). */
  builtinOverride?: BuiltinHookOverride;
  /** Project root used to gate non-self project-scope team hooks. */
  teamHookProjectRoot?: string;
  /**
   * Write the team hooks alone: the built-ins are not desired here, and any
   * built-in entry found in the file is removed. Team entries are owned only
   * when the manifest records them, or when they equal a render of a team hook
   * from `teamHookHistory`; a matching command alone is not ownership.
   */
  teamOnly?: boolean;
  /** Shared main-checkout ownership to reconcile before changing this file. */
  mainCheckout?: MainCheckoutHooks;
  /** The team's hooks at every revision, to recognize entries the manifest does not record (#993). */
  teamHookHistory?: TeamHookHistory;
  /**
   * Without a manifest, still treat every entry carrying a team hook's marker
   * as teamai's: the pass removes them and records nothing. For self mode's
   * tracked settings while the team hooks live in `settings.local.json` (#915).
   */
  dropTeamEntries?: boolean;
}

/** Every team hook any revision of the team repo's hook files declares, read once. */
export type TeamHookHistory = () => Promise<HookDef[]>;

/** `TeamHookHistory` of `localConfig`'s team repo: empty when git cannot read it, or for an HTTP-backed team. */
export function teamHookHistory(localConfig: LocalConfig): TeamHookHistory {
  let defs: Promise<HookDef[]> | undefined;
  return () => defs ??= (async () => {
    if (localConfig.repo.kind === 'http') return [];
    const layout = entryLayout('hooks');
    const versions = await historicalContents(localConfig.repo.localPath, layout.dir) ?? [];
    const unique = new Map<string, HookDef>();
    for (const version of versions) {
      if (path.posix.basename(version.path) !== layout.file) continue;
      for (const hook of parseTeamHooks(version.content.toString('utf8')) ?? []) {
        const def = teamHookToDef(hook);
        unique.set(JSON.stringify(def), def);
      }
    }
    return [...unique.values()];
  })();
}

/**
 * The lines a pull prints for the entries of this checkout's main-checkout
 * hook files it keeps as the member's (#993), for `doctor`. Read-only.
 */
export async function keptTeamHookEntries(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const mainCheckout = await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths);
  if (!mainCheckout) return [];
  const manifest = await readManifest(mainCheckout.manifestPath);
  const legacy = await readManifest(legacyManagedHooksPath(mainCheckout.root));
  const history = teamHookHistory(localConfig);
  const kept: string[] = [];
  for (const [tool, file] of Object.entries(mainCheckout.files)) {
    if (!await pathExists(file)) continue;
    const recorded = [...manifest[tool] ?? [], ...tool === CODEX_TOOL_ID ? legacy[tool] ?? [] : []];
    kept.push(...(await judgeUnrecordedTeamEntries(file, tool, [], recorded, { teamOnly: true, teamHookHistory: history })).kept);
  }
  return kept;
}

/**
 * Whether a hook file holds an entry no record claims that equals the render of
 * exactly one team hook (#993): teamai's, for uninstall to find a file whose
 * records are lost. Read-only.
 */
export async function hasUnrecordedTeamHooks(
  settingsPath: string,
  tool: string,
  opts: Pick<ReconcileHooksOptions, 'teamHookHistory' | 'teamHookProjectRoot' | 'teamOnly'>,
): Promise<boolean> {
  return (await judgeUnrecordedTeamEntries(settingsPath, tool, [], [], opts)).adopted.length > 0;
}

/** An entry of a hook file, in any tool's format. */
type HookFileEntry = HookMatcher | CodexHookMatcher | CursorHookEntry | CopilotHookEntry | ZcodeHookMatcher;

/** What `judgeUnrecordedTeamEntries` found in a hook file. */
interface UnrecordedTeamEntries {
  /** Records for the entries that equal exactly one team hook's render: teamai's, handled as recorded ones. */
  adopted: ManagedHookRecord[];
  /** A line naming each entry kept as the member's. */
  kept: string[];
}

/**
 * The entries of a hook file that no record in `recorded` owns, judged against
 * teamai's render of every team hook for `tool` in the file's own format, as
 * its reconciler writes it: today's (`scopedDefs`) and at every revision in the
 * team repo's history (#993). One equal to the render of exactly one hook is
 * adopted. In a team-only file (the main checkout's) a Claude entry carrying a
 * team hook's marker that equals none is the member's, and named; so is an
 * entry, in any file, equal to the renders of more than one hook. Other entries
 * are the member's own hooks, left alone as always; entries teamai's built-in
 * markers already claim are not judged. Read-only.
 */
async function judgeUnrecordedTeamEntries(
  settingsPath: string,
  tool: string,
  scopedDefs: HookDef[],
  recorded: ManagedHookRecord[],
  opts: ReconcileHooksOptions,
): Promise<UnrecordedTeamEntries> {
  const result: UnrecordedTeamEntries = { adopted: [], kept: [] };
  const format = detectFormat(tool);
  // A Claude file outside a project is swept by marker: every marked entry is teamai's already.
  if (!opts.teamHookHistory || (format === 'claude' && !opts.teamOnly && !opts.teamHookProjectRoot)) return result;
  const file = expandHome(settingsPath);
  const json = await readJson<{ hooks?: Record<string, unknown> }>(file);
  const hooks = (format === 'zcode' ? (json as ZcodeHooksJson | null)?.hooks?.events : json?.hooks) as
    Record<string, HookFileEntry[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return result;

  const vbsPath = path.join(path.dirname(file), 'teamai-hook-dispatch.vbs');
  // The event key and entry each reconciler writes for a hook.
  const render = (def: HookDef): { event?: string; entry: unknown } => {
    switch (format) {
      case 'cursor': return { event: CLAUDE_TO_CURSOR_EVENTS[def.event], entry: toCursorEntry(def) };
      case 'copilot': return { event: CLAUDE_TO_COPILOT_EVENTS[def.event], entry: toCopilotEntry(def) };
      case 'zcode': return { event: def.event, entry: toZcodeEntry(def, vbsPath) };
      case 'codex': return { event: def.event, entry: toCodexEntry(def) };
      default: return { event: def.event, entry: toClaudeEntry(def) };
    }
  };
  let renders: Array<{ def: HookDef; event?: string; entry: unknown }> | undefined;
  const loadRenders = async () => renders ??= [
    ...teamDefsForTool(scopedDefs, tool),
    ...teamDefsForTool(scopedTeamDefs(await opts.teamHookHistory!(), opts.teamHookProjectRoot, tool), tool),
  ].map((def) => ({ def, ...render(def) }));
  const marked = (command: string) => TEAMAI_COMMAND_MARKERS.some((m) => command.includes(m));
  // The commands each reconciler owns an entry by; none for an entry its built-in handling claims.
  const commandsOf = (event: string, entry: HookFileEntry): string[] => {
    if (!entry || typeof entry !== 'object') return [];
    switch (format) {
      case 'cursor': {
        const { command } = entry as CursorHookEntry;
        return typeof command === 'string' && !isTeamaiHookCommand(command) ? [command] : [];
      }
      case 'copilot': {
        const commands = copilotEntryCommands(entry as CopilotHookEntry);
        return commands.some(marked) ? [] : commands;
      }
      case 'zcode': {
        const command = zcodeEntryCommand(entry as ZcodeHookMatcher);
        return command && !marked(command) ? [command] : [];
      }
      default: {
        const matcher = entry as HookMatcher | CodexHookMatcher;
        const command = matcher.hooks?.length === 1 && matcher.hooks[0].type === 'command' ? matcher.hooks[0].command : undefined;
        return typeof command === 'string' && !isExactBuiltinEntry(event, tool, matcher) ? [command] : [];
      }
    }
  };

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const [index, entry] of entries.entries()) {
      const commands = commandsOf(event, entry);
      if (commands.length === 0) continue;
      const command = commands[0];
      const marker = format === 'claude' ? teamHookIdOf((entry as HookMatcher).description) : null;
      // Only a marked entry can equal a Claude render, whose description carries the marker.
      if (format === 'claude' && marker === null) continue;
      const owned = recorded.some((record) => format === 'claude'
        ? record.event === event && (record.matcher ?? '*') === ((entry as HookMatcher).matcher ?? '*') && record.command === command && record.id === marker
        : format === 'codex' && tool === CODEX_TOOL_ID
          ? ownsCodexEntry(record, event, index, entries as CodexHookMatcher[])
          : commands.includes(record.command));
      if (owned) continue;
      const matches = (await loadRenders()).filter((r) => r.event === event && isDeepStrictEqual(r.entry, entry));
      const ids = [...new Set(matches.map((r) => r.def.key))];
      if (ids.length === 1) {
        const { def } = matches[0];
        result.adopted.push({
          id: ids[0], event: def.event, command: def.command,
          ...(def.matcher && def.matcher !== '*' ? { matcher: def.matcher } : {}),
          ...(format === 'codex' && tool === CODEX_TOOL_ID ? { codexEntryIndex: index, codexEntry: entry as CodexHookMatcher } : {}),
        });
      } else if (ids.length > 1) {
        result.kept.push(`Kept the ${event} hook entry in ${settingsPath}: it matches more than one team hook (${ids.join(', ')}), `
          + 'so teamai cannot tell which one it is. Delete it if it is a copy teamai wrote.');
      } else if (marker !== null && opts.teamOnly) {
        result.kept.push(`Kept the ${event} hook entry ${marker} in ${settingsPath}: it is not teamai's (no delivery record, `
          + `and it matches no team version of hook ${marker}). Delete it if you no longer need it.`);
      }
    }
  }
  return result;
}

/** One injected team hook recorded in the manifest. */
export interface ManagedHookRecord {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  /** Codex matcher-group position and complete definition written by reconciliation. */
  codexEntryIndex?: number;
  codexEntry?: CodexHookMatcher;
}

/** ~/.teamai/managed-hooks.json — team hooks injected per tool. */
export type ManagedHooksManifest = Record<string, ManagedHookRecord[]>;

/**
 * Install the built-in hooks alone, for a team set that did not resolve:
 * `with-overrides` in each tool missing one of them, applying the given
 * overrides; `defaults-where-none` only in a tool with no teamai hook at all,
 * for when hooks/hooks.yaml does not parse and the overrides are unknown.
 */
export type BuiltinsOnly = 'with-overrides' | 'defaults-where-none';

async function readManifest(manifestPath: string): Promise<ManagedHooksManifest> {
  const data = await readJson<ManagedHooksManifest>(expandHome(manifestPath));
  return data && typeof data === 'object' ? data : {};
}

/** ~/.teamai/managed-main-checkout-hooks.json — team hooks injected into the main checkout, with checkout tracking. */
export interface SharedHooksManifest {
  checkouts?: Record<string, string[]> | string[];
  [tool: string]: ManagedHookRecord[] | Record<string, string[]> | string[] | undefined;
}

export function getToolCheckouts(manifest: SharedHooksManifest, tool: string): string[] {
  if (Array.isArray(manifest.checkouts)) {
    return manifest.checkouts;
  }
  if (manifest.checkouts && typeof manifest.checkouts === 'object') {
    const list = (manifest.checkouts as Record<string, string[]>)[tool];
    if (Array.isArray(list)) return list;
  }
  return [];
}

export function setToolCheckouts(manifest: SharedHooksManifest, tool: string, checkouts: string[]): void {
  if (Array.isArray(manifest.checkouts)) {
    const checkouts = manifest.checkouts;
    manifest.checkouts = Object.fromEntries(MAIN_CHECKOUT_TEAM_HOOK_TOOLS.map((tool) => [tool, [...checkouts]]));
  } else if (!manifest.checkouts) {
    manifest.checkouts = {};
  }
  (manifest.checkouts as Record<string, string[]>)[tool] = checkouts;
}

/** Release registration even when the checkout's hook file was already deleted. */
export async function unregisterCheckoutFromSharedManifest(
  manifestPath: string,
  checkout: string,
  tools: readonly string[],
): Promise<void> {
  const manifest = await readJson<SharedHooksManifest>(expandHome(manifestPath));
  if (!manifest) return;
  const canonical = canonicalProjectRoot(checkout);
  let changed = false;
  for (const tool of MAIN_CHECKOUT_TEAM_HOOK_TOOLS) {
    if (!tools.includes(tool)) continue;
    const registered = getToolCheckouts(manifest, tool);
    const remaining = registered.filter((root) => canonicalProjectRoot(root) !== canonical);
    if (remaining.length === registered.length) continue;
    setToolCheckouts(manifest, tool, remaining);
    changed = true;
  }
  if (changed) await writeJson(expandHome(manifestPath), manifest);
}

/**
 * Move what a release before #993 recorded in `<root>/.teamai/managed-hooks.json`
 * into this checkout's manifest in the data home: the Copilot records in a
 * project scope, every record in self mode. The other records stay there for
 * the pre-#370 Codex import and the legacy hook sweep. The file is deleted
 * once empty, unless git tracks it: doctor names a tracked one. Idempotent;
 * an unreadable file is left alone.
 */
export async function migrateLegacyManagedHooks(localConfig: LocalConfig): Promise<void> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return;
  const legacyPath = legacyManagedHooksPath(localConfig.projectRoot);
  const legacy = await readJson<ManagedHooksManifest>(legacyPath);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;
  const moving = Object.keys(legacy).filter((tool) => isSelfMode(localConfig) || tool === COPILOT_TOOL_ID);
  if (moving.length > 0) {
    const manifestPath = getManagedHooksPath(localConfig);
    const manifest = await readManifest(manifestPath);
    for (const tool of moving) {
      const records = manifest[tool] ?? [];
      for (const record of legacy[tool] ?? []) {
        if (!records.some((r) => isDeepStrictEqual(r, record))) records.push(record);
      }
      if (records.length > 0) manifest[tool] = records;
      delete legacy[tool];
    }
    await writeJson(manifestPath, manifest);
  }
  if (Object.keys(legacy).length === 0) {
    const { gitTracks } = await import('./git-exclude.js');
    if ((await gitTracks(legacyPath)).kind === 'untracked') {
      await rm(legacyPath, { force: true });
      return;
    }
  }
  if (moving.length > 0) await writeJson(legacyPath, legacy);
}

/** Team hooks to record in the manifest for a tool (empty when removing). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function canonicalProjectRoot(projectRoot: string): string {
  try { return realpathSync.native(projectRoot); } catch { return path.resolve(projectRoot); }
}

/**
 * The same project root as the shell that runs the hook names its cwd.
 *
 * On Windows every hook runner is an MSYS shell — CodeBuddy's required Git
 * Bash, WorkBuddy's bundled PortableGit — and MSYS exposes a drive-letter path
 * as `/c/proj`, never as the `C:\proj` a Windows path resolves to. A gate that
 * compares `$PWD` against the Windows spelling therefore never matches, and the
 * project's team hooks silently never run: `canonicalProjectRoot()` returns the
 * native form, so the comparison has to be made in the form the shell uses.
 *
 * Drive roots lose their trailing separator (`C:\` → `/c`), which is how MSYS
 * spells them. A path that already has no drive letter (Linux, macOS) is
 * returned unchanged, and so is a UNC path (`\\server\share`), whose MSYS form
 * this does not attempt.
 */
function msysProjectRoot(root: string): string {
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(root);
  if (!drive) return root;
  return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/';
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
 * Read-only: this gate is only ever matched against (isGatedForProject), never
 * rendered. 0.26.0 wrote it for CodeBuddy on Windows; those entries are still
 * on disk, and recognising them is what lets a re-render replace the gate
 * instead of stacking a second one.
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
 *
 * Every tool runs hook commands through a POSIX shell on every platform
 * (WorkBuddy's bundled MSYS sh, CodeBuddy's required Git Bash, `bash -lc` for
 * the rest), so the gate is always the POSIX form. Outside the project it is a
 * no-op that exits 0 and inside it the payload's own status is passed through:
 * a gate mismatch that returned non-zero would make CodeBuddy read the hook as
 * `allowed:false` and BLOCK every UserPromptSubmit outside the project.
 *
 * A Windows root is tested in both spellings. The shell names its cwd the MSYS
 * way (`/c/proj`); the native form is kept because it is what previous versions
 * wrote, so a re-render recognises and replaces those entries instead of
 * stacking a second gate beside them. On a non-Windows root the two forms are
 * identical and the gate carries one test.
 *
 * Legacy cmd.exe gates are still recognised on read by isGatedForProject(), so
 * a re-render replaces 0.26.0's cmd gate instead of stacking a second one.
 */
function gateTeamHookCommand(command: string, projectRoot: string | undefined): string {
  if (!projectRoot) return command;
  const root = canonicalProjectRoot(projectRoot);
  const msys = msysProjectRoot(root);
  const quoted = shellQuote(root);
  if (msys === root) {
    return `if [ "$PWD" = ${quoted} ] || case "$PWD" in ${quoted}/*) true;; *) false;; esac; then (${command}); fi`;
  }
  const shellQuoted = shellQuote(msys);
  return `if [ "$PWD" = ${quoted} ] || [ "$PWD" = ${shellQuoted} ]`
    + ` || case "$PWD" in ${quoted}/*|${shellQuoted}/*) true;; *) false;; esac; then (${command}); fi`;
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

/**
 * Team commands written for `claude` exit when Cursor or Copilot CLI runs them
 * and that host's own teamai hooks are installed. The prefix checks the hook
 * file; it does not skip a claude-only setup. Built-in hooks take the same
 * exit inside hook-dispatch instead of here.
 *
 * `tool` here keys the cursor/copilot wrapper, which is orthogonal to the
 * project gate: the gate lost its per-tool form once every render became POSIX
 * (CodeBuddy's Windows hooks run through Git Bash), but this wrapper still
 * needs to know which tool it is rendering for.
 */
function skipWhenAnotherHostLoadsClaudeSettings(command: string, tool: string): string {
  if (tool !== 'claude') return command;
  return `${CLAUDE_HOOK_OTHER_HOST_SKIP}${command}`;
}

/**
 * Matches a POSIX gate and captures its *first* quoted root, which is always
 * the native spelling: on Windows the MSYS spelling follows as an optional
 * second test, on a non-Windows root the two are the same and only one is
 * written. Reading the native form back keeps the root comparable with the
 * Windows paths the callers hold.
 */
const POSIX_GATE_ROOT_RE = /^if \[ "\$PWD" = ('(?:[^']|'"'"')*') \](?: \|\| \[ "\$PWD" = '(?:[^']|'"'"')*' \])? \|\| case "\$PWD" in /;

/**
 * The project root a POSIX gate was rendered for, or null for an ungated or
 * cmd.exe-gated command. Only the POSIX form is read: it is the one the tools
 * that moved to the main checkout (MAIN_CHECKOUT_TEAM_HOOK_TOOLS) ever wrote.
 */
function gatedProjectRoot(command: string): string | null {
  const quoted = POSIX_GATE_ROOT_RE.exec(command)?.[1];
  return quoted ? quoted.slice(1, -1).split(`'"'"'`).join("'") : null;
}

/**
 * The project-scope team hook file, relative to the main checkout, of each
 * tool that reads it from every linked worktree of the repository (#955):
 * Claude Code reads `<main>/.claude/settings.local.json` in a worktree without
 * a `.claude/` of its own, and Codex reads `<main>/.codex/hooks.json` (under
 * the main checkout's trust) once the worktree has a `.codex/` directory, which
 * its SessionStart creates (seedProjectAgentRoot). A non-self project scope
 * writes these tools' team hooks there, ungated, so every checkout shares one
 * set of entries and Codex one set of trust keys; their built-in hooks stay in
 * HOME, which every worktree reads from its first session. Every other tool
 * keeps its team hooks in HOME behind a `$PWD` gate.
 */
const MAIN_CHECKOUT_TEAM_HOOK_TOOLS = ['claude', 'codex'] as const;

/** Where a non-self project scope keeps Claude/Codex team hooks. */
export interface MainCheckoutHooks {
  /** The main checkout (realpath), or the current workspace when the anchor is bare. */
  root: string;
  /** The current checkout's projectRoot. */
  current?: string;
  /** Bare repositories have no main checkout; each workspace keeps its own files. */
  worktreeScoped: boolean;
  /** Manifest of the team hooks written in this target root. */
  manifestPath: string;
  /**
   * The manifest an older CLI kept for this target in the current checkout's
   * own data home, when that differs from `manifestPath` (#373). Its records
   * are adopted so the entries it appended are reconciled once.
   */
  checkoutManifestPath?: string;
  /**
   * Another checkout's install also uses the entries in `manifestPath`, so
   * removal from this one takes back only `checkoutManifestPath`'s records.
   */
  sharedWithOtherInstall?: boolean;
  /** Configured project-scope targets; Claude uses settings.local.json beside its settings file. */
  files: Readonly<Record<string, string>>;
}

/**
 * The main checkout a non-self project scope writes its Claude and Codex team
 * hooks into, or null when its hooks do not go there: user scope, self mode
 * (which writes every hook into its own checkout), or a project rooted at HOME,
 * whose "main checkout" files are the HOME files themselves.
 */
export async function resolveMainCheckoutHooks(
  localConfig: LocalConfig,
  toolPaths: Record<string, { settings?: string }>,
): Promise<MainCheckoutHooks | null> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot || isSelfMode(localConfig)) return null;
  const { root, worktreeScoped } = await mainCheckoutOf(localConfig.projectRoot);
  if (root === canonicalProjectRoot(getUserHome())) return null;
  const files = Object.fromEntries(MAIN_CHECKOUT_TEAM_HOOK_TOOLS.flatMap((tool) => {
    const settings = toolPaths[tool]?.settings;
    if (!settings) return [];
    const relative = tool === 'claude' ? path.join(path.dirname(settings), 'settings.local.json') : settings;
    return [[tool, path.join(root, relative)]];
  }));
  const manifestName = 'managed-main-checkout-hooks.json';
  if (worktreeScoped) {
    const manifestRoot = path.join(getDataHome(localConfig), 'workspaces', managedMcpWorkspaceId(root));
    return { root, current: canonicalProjectRoot(localConfig.projectRoot), worktreeScoped, manifestPath: path.join(manifestRoot, manifestName), files };
  }
  // Every checkout shares the main checkout's files, so their ownership lives
  // in the main checkout's data home. An un-migrated linked worktree has a data
  // home of its own, in the checkout, where a separate record would append the
  // entries again. A main checkout without a config of its own still has one
  // data home: the in-checkout one its config would use.
  const current = canonicalProjectRoot(localConfig.projectRoot);
  const checkoutHome = getDataHome(localConfig);
  const checkoutManifestPath = path.join(checkoutHome, manifestName);
  if (root === current || checkoutHome !== getTeamaiHome('project', localConfig.projectRoot)) {
    const sharedWithOtherInstall = await isSharedWithOtherInstall(root, current, checkoutManifestPath, true);
    return { root, current, worktreeScoped, manifestPath: checkoutManifestPath, sharedWithOtherInstall, files };
  }
  const { detectProjectConfig } = await import('./config.js');
  const mainConfig = await pathExists(root) ? await detectProjectConfig(root).catch(() => null) : null;
  const sharedHome = mainConfig ? getDataHome(mainConfig) : getTeamaiHome('project', root);
  const sharedManifestPath = path.join(sharedHome, manifestName);
  if (sharedHome === checkoutHome) {
    const sharedWithOtherInstall = await isSharedWithOtherInstall(root, current, checkoutManifestPath, mainConfig !== null);
    return { root, current, worktreeScoped, manifestPath: checkoutManifestPath, sharedWithOtherInstall, files };
  }
  return {
    root,
    current,
    worktreeScoped,
    manifestPath: sharedManifestPath,
    checkoutManifestPath,
    sharedWithOtherInstall: await isSharedWithOtherInstall(root, current, sharedManifestPath, mainConfig !== null),
    files,
  };
}

/**
 * Whether a linked worktree of `root` other than `current` has an un-migrated
 * install of its own (a migrated one would have made the main checkout's
 * config resolvable).
 */
async function otherWorktreeInstalled(root: string, current: string): Promise<boolean> {
  const canonicalCurrent = canonicalProjectRoot(current);
  const canonicalRoot = canonicalProjectRoot(root);
  for (const worktree of await listWorktrees(root)) {
    const canonical = canonicalProjectRoot(worktree);
    if (canonical === canonicalRoot || canonical === canonicalCurrent) continue;
    if (await pathExists(path.join(getTeamaiHome('project', worktree), 'config.yaml'))) return true;
  }
  return false;
}

async function otherWorktreeHasOwnManifest(root: string, current: string, tool: string): Promise<boolean> {
  const canonicalCurrent = canonicalProjectRoot(current);
  const canonicalRoot = canonicalProjectRoot(root);
  for (const worktree of await listWorktrees(root)) {
    const canonical = canonicalProjectRoot(worktree);
    if (canonical === canonicalRoot || canonical === canonicalCurrent) continue;
    const manifest = await readManifest(path.join(getTeamaiHome('project', worktree), 'managed-main-checkout-hooks.json'));
    if (manifest[tool]?.length) return true;
  }
  return false;
}

async function discoverInstalledCheckouts(root: string, tool: string): Promise<string[]> {
  const result: string[] = [];
  const canonicalRoot = canonicalProjectRoot(root);
  const { detectProjectConfig, readConfigFrom } = await import('./config.js');
  const mainConfig = await pathExists(root) ? await detectProjectConfig(root, undefined, { dryRun: true }).catch(() => null) : null;
  const sharedPartition = mainConfig
    && path.resolve(getDataHome(mainConfig)) !== path.resolve(getTeamaiHome('project', canonicalRoot));
  if (mainConfig && !isAgentExcluded(mainConfig, tool)) result.push(canonicalRoot);
  for (const worktree of await listWorktrees(root)) {
    const canonical = canonicalProjectRoot(worktree);
    if (canonical === canonicalRoot) continue;
    // A partition config governs every linked worktree, without local configs.
    if (sharedPartition) {
      if (!isAgentExcluded(mainConfig, tool)) result.push(canonical);
      continue;
    }
    const home = getTeamaiHome('project', worktree);
    if (await pathExists(path.join(home, 'config.yaml'))) {
      const config = await readConfigFrom(home, worktree);
      // An unreadable installed config cannot prove that its tool was excluded.
      if (!config || !isAgentExcluded(config, tool)) result.push(canonical);
    }
  }
  return result;
}

async function isSharedWithOtherInstall(
  root: string,
  current: string,
  manifestPath: string,
  mainConfigExists: boolean,
): Promise<boolean> {
  const canonicalCurrent = canonicalProjectRoot(current);
  const canonicalRoot = canonicalProjectRoot(root);
  const manifest = await readJson<SharedHooksManifest>(expandHome(manifestPath));
  if (manifest) {
    const allCheckouts = new Set<string>();
    if (Array.isArray(manifest.checkouts)) {
      for (const c of manifest.checkouts) allCheckouts.add(canonicalProjectRoot(c));
    } else if (manifest.checkouts && typeof manifest.checkouts === 'object') {
      for (const list of Object.values(manifest.checkouts as Record<string, string[]>)) {
        if (Array.isArray(list)) {
          for (const c of list) allCheckouts.add(canonicalProjectRoot(c));
        }
      }
    }
    allCheckouts.delete(canonicalCurrent);
    if (allCheckouts.size > 0) {
      const liveWorktrees = new Set((await listWorktrees(root)).map(canonicalProjectRoot));
      for (const c of allCheckouts) {
        if (c === canonicalRoot || liveWorktrees.has(c)) return true;
      }
    }
  }
  if (canonicalCurrent !== canonicalRoot && mainConfigExists) return true;
  return await otherWorktreeInstalled(root, current);
}
async function mainCheckoutOf(projectRoot: string): Promise<{ root: string; worktreeScoped: boolean }> {
  const anchors = await pathExists(projectRoot) ? await resolveAnchors(projectRoot) : null;
  return {
    root: (anchors?.projectAnchorIsBare ? anchors.workspaceRoot : anchors?.projectAnchor)
      ?? canonicalProjectRoot(projectRoot),
    worktreeScoped: anchors?.projectAnchorIsBare === true,
  };
}

/** The main checkout's team hook file of `tool`, when the tool keeps one there. */
export function mainCheckoutHookFile(mainCheckout: MainCheckoutHooks | null | undefined, tool: string): string | null {
  return mainCheckout?.files[tool] ?? null;
}

/**
 * The project whose Codex team hooks a dispatcher entry runs for a checkout
 * (#915): the main checkout, whose `.codex/hooks.json` every worktree reads, or
 * in self mode the checkout itself, which keeps its own hook files. Null
 * outside a project scope.
 */
export async function codexTeamHookProject(localConfig: LocalConfig): Promise<string | null> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return null;
  if (isSelfMode(localConfig)) return canonicalProjectRoot(localConfig.projectRoot);
  const { root } = await mainCheckoutOf(localConfig.projectRoot);
  return root === canonicalProjectRoot(getUserHome()) ? null : root;
}

/** `~/.codex/hooks.json` as this scope resolves Codex's user hook file, or null. */
function codexHomeHooksFile(teamConfig: TeamaiConfig, localConfig: LocalConfig): string | null {
  const settings = scopedToolPaths(teamConfig, { ...localConfig, scope: 'user' })[CODEX_TOOL_ID]?.settings;
  return settings ? path.join(canonicalProjectRoot(getUserHome()), settings) : null;
}

/**
 * Stop running this project's Codex team hooks from the dispatcher, and drop
 * the dispatcher entries no other project needs (#915). For `uninstall`, whose
 * hook removal does not go through the reconcile that does this on pull.
 * Returns the file it could not update, which keeps them running, or null.
 */
export async function stopCodexTeamHookDispatch(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string | null> {
  const project = await codexTeamHookProject(localConfig);
  const homeFile = codexHomeHooksFile(teamConfig, localConfig);
  const hooks = project ? await dispatchedCodexHooks(project) : undefined;
  if (!project || !hooks) return null;
  const index = path.join('~', '.teamai', 'codex-team-hooks.json');
  if (!await setCodexDispatcherHooks(project, null)) {
    log.warn(`Could not update ${index}: another teamai process held it, so the Codex team hooks of ${project} still run.`);
    return index;
  }
  if (!homeFile) return null;
  try {
    await reconcileCodexDispatchers(homeFile);
    return null;
  } catch (e) {
    // The entry comes back, so the retry still finds the dispatcher entries to remove.
    await setCodexDispatcherHooks(project, hooks);
    log.warn(`Could not remove the Codex team-hook dispatchers from ${homeFile}: ${(e as Error).message}. The Codex team hooks of ${project} still run.`);
    return homeFile;
  }
}

/** Where a project scope's Codex team hooks go (#915); see placeCodexTeamHooks. */
interface CodexTeamHookPlacement {
  project: string;
  /** The resolved `sharing.gitExclude`; undefined leaves the hooks where they are. */
  gitExclude: boolean | undefined;
  /** Self mode: the committed file holds the built-ins, so it is never teamai's alone. */
  self: boolean;
  /** `~/.codex/hooks.json`, which holds the dispatcher entries; null when Codex has none here. */
  homeFile: string | null;
}

/**
 * Whether the project's Codex hook file holds anything teamai does not own:
 * git tracks it, it is not a plain JSON file of hooks, or an entry is neither
 * recorded in `recorded`, nor equal to teamai's render of a team hook (#993),
 * nor an exact built-in. Read-only.
 */
async function holdsForeignCodexHooks(
  file: string,
  teamDefs: HookDef[],
  recorded: ManagedHookRecord[],
  history: TeamHookHistory | undefined,
): Promise<boolean> {
  const stats = await lstat(file).catch(() => null);
  if (!stats) return false;
  if (!stats.isFile()) return true;
  const { gitUntracked } = await import('./git-exclude.js');
  // A file git cannot judge inside a repository may be tracked.
  if (!await gitUntracked(file, 'entry')) return true;
  const raw = await readFileSafe(file);
  if (raw === null || raw.trim() === '') return false;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return true;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return true;
  const { hooks, ...others } = json as { hooks?: unknown };
  if (Object.keys(others).length > 0) return true;
  if (hooks === undefined) return false;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return true;
  const owners = [...recorded, ...(await judgeUnrecordedTeamEntries(file, CODEX_TOOL_ID, teamDefs, recorded, { teamOnly: true, teamHookHistory: history })).adopted];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) return true;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index] as CodexHookMatcher;
      if (!entry || typeof entry !== 'object') return true;
      if (isExactBuiltinEntry(event, CODEX_TOOL_ID, entry)) continue;
      if (!owners.some((record) => ownsCodexEntry(record, event, index, entries as CodexHookMatcher[]))) return true;
    }
  }
  return false;
}

/**
 * Decide, on this run, whether the project's Codex team hooks run from the
 * dispatcher (#915), and record that: while `sharing.gitExclude` is on and
 * `file` holds anything teamai does not own (always in self mode). Returns
 * whether they do. When the index cannot be updated, they stay where they are.
 */
async function placeCodexTeamHooks(
  placement: CodexTeamHookPlacement,
  file: string,
  teamDefs: HookDef[],
  recorded: ManagedHookRecord[],
  opts: { removeAll?: boolean; teamHookHistory?: TeamHookHistory },
): Promise<boolean> {
  const current = await runsFromCodexDispatcher(placement.project);
  const dispatch = opts.removeAll ? false
    : placement.gitExclude === undefined ? current
      : placement.gitExclude && (placement.self || await holdsForeignCodexHooks(file, teamDefs, recorded, opts.teamHookHistory));
  const hooks: CodexTeamHook[] = teamDefsForTool(teamDefs, CODEX_TOOL_ID).map((def) => ({
    id: def.key, event: def.event, command: def.command,
    ...(def.matcher && def.matcher !== '*' ? { matcher: def.matcher } : {}),
    ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
  }));
  if (!await setCodexDispatcherHooks(placement.project, dispatch && hooks.length > 0 ? hooks : null)) {
    log.warn(`Could not update ${path.join('~', '.teamai', 'codex-team-hooks.json')}: another teamai process held it. `
      + 'The Codex team hooks stay where they are; the next pull places them.');
    return current;
  }
  if (!dispatch || hooks.length === 0) return dispatch;
  // The project file gives up the team hooks only once the dispatcher entries that run them are in place.
  try {
    if (!placement.homeFile) throw new Error('Codex has no user hook file here');
    await reconcileCodexDispatchers(placement.homeFile);
    return true;
  } catch (e) {
    await setCodexDispatcherHooks(placement.project, null);
    log.warn(`Could not add the Codex team-hook dispatchers to ${placement.homeFile ?? '~/.codex/hooks.json'}: ${(e as Error).message}. `
      + `The team hooks stay in ${file}; fix the cause above, then run \`teamai pull\`.`);
    return false;
  }
}

/**
 * Self mode (#915): the tools whose team hooks leave the committed settings
 * for the checkout's own `settings.local.json` while `sharing.gitExclude` is
 * on. Their built-ins stay committed, so a fresh clone still has them.
 */
const SELF_LOCAL_TEAM_HOOK_TOOLS: readonly string[] = ['claude'];

function selfLocalHookFile(baseDir: string, tool: string, settings: string): string | null {
  return SELF_LOCAL_TEAM_HOOK_TOOLS.includes(tool) ? path.join(baseDir, path.dirname(settings), 'settings.local.json') : null;
}

/** This self-mode checkout's `settings.local.json` that can hold `tool`'s team hooks, or null. */
export function selfLocalTeamHookFile(
  localConfig: LocalConfig,
  toolPaths: Record<string, { settings?: string }>,
  tool: string,
): string | null {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot || !isSelfMode(localConfig)) return null;
  const settings = toolPaths[tool]?.settings;
  return settings ? selfLocalHookFile(resolveHookScope(localConfig).baseDir, tool, settings) : null;
}

/**
 * Reconcile one self-mode tool whose team hooks can live in `localFile`. The
 * per-checkout manifest keys records by tool, so its records for `tool`
 * describe one file at a time: the one holding the team hooks.
 *
 * - `relocate` (the resolved `sharing.gitExclude` on): the local file is
 *   reconciled team-only from those records first; then the tracked file
 *   keeps the built-ins and drops every team entry by its marker, without
 *   reading or writing the records.
 * - otherwise: the local file gives up the entries the records name (and is
 *   deleted when nothing else is left in it), then the tracked file gets the
 *   built-ins and team hooks as before #915, and its pass records them.
 */
async function reconcileSelfLocalTeamHooks(
  settingsPath: string,
  localFile: string,
  tool: string,
  teamDefs: HookDef[],
  manifestPath: string,
  opts: { relocate: boolean; removeAll?: boolean; builtinOverride?: BuiltinHookOverride; teamHookHistory?: TeamHookHistory },
): Promise<void> {
  const relocate = opts.relocate && !opts.removeAll;
  if (relocate || await hasTeamaiHooks(localFile, tool, manifestPath)) {
    await reconcileMainCheckoutTeamHooks(localFile, tool, relocate ? teamDefs : [], {
      manifestPath,
      removeAll: !relocate,
      teamHookHistory: opts.teamHookHistory,
    });
    if (!relocate) await removeEmptyHookFile(localFile);
  }
  await reconcileHooks(settingsPath, tool, relocate ? [] : teamDefs, relocate
    ? { builtinOverride: opts.builtinOverride, dropTeamEntries: true }
    : { manifestPath, removeAll: opts.removeAll, builtinOverride: opts.builtinOverride, teamHookHistory: opts.teamHookHistory });
}

/** Delete an untracked hook file that holds nothing but empty hook lists. */
async function removeEmptyHookFile(file: string): Promise<void> {
  const json = await readJson<Record<string, unknown>>(file);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return;
  const hooks = json.hooks;
  const empty = Object.keys(json).every((key) => key === 'hooks')
    && (hooks === undefined || (typeof hooks === 'object' && hooks !== null
      && Object.values(hooks).every((entries) => Array.isArray(entries) && entries.length === 0)));
  if (!empty) return;
  const { gitTracks } = await import('./git-exclude.js');
  if ((await gitTracks(file, 'entry')).kind === 'untracked') await rm(file, { force: true });
}

/**
 * The project roots whose gated team entries a pass over HOME removes for
 * `tool`: this checkout's, and the ones an older CLI wrote for the main
 * checkout, a live worktree of it, or a directory that no longer exists (a
 * removed worktree). Another project's live entries are left alone.
 */
async function staleCheckoutGateRoots(
  manifestPath: string | undefined,
  tool: string,
  current: string,
  mainCheckout: MainCheckoutHooks,
): Promise<string[]> {
  const roots = new Set([canonicalProjectRoot(current)]);
  if (!manifestPath) return [...roots];
  const records = (await readManifest(manifestPath))[tool] ?? [];
  const gated = [...new Set(records.map((r) => gatedProjectRoot(r.command)).filter((r): r is string => r !== null))];
  if (gated.length === 0) return [...roots];
  const ours = new Set([mainCheckout.root, ...await listWorktrees(mainCheckout.root)]);
  for (const root of gated) {
    if (ours.has(root) || !await pathExists(root)) roots.add(root);
  }
  return [...roots];
}

function scopedTeamDefs(teamDefs: HookDef[], projectRoot: string | undefined, tool: string): HookDef[] {
  const prepared = teamDefs.map((def) => ({
    ...def,
    command: skipWhenAnotherHostLoadsClaudeSettings(def.command, tool),
  }));
  if (!projectRoot) return prepared;
  return prepared.map((def) => ({ ...def, command: gateTeamHookCommand(def.command, projectRoot) }));
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
        ...(def.additionalContextLimit !== undefined ? { additionalContextLimit: def.additionalContextLimit } : {}),
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

/** Match standard built-ins exactly when cleaning a project team-only file. */
function isExactBuiltinEntry(event: string, tool: string, entry: HookMatcher | CodexHookMatcher): boolean {
  if (entry.hooks?.length !== 1 || entry.hooks[0].type !== 'command') return false;
  const command = entry.hooks[0].command;
  return builtinHookDefs(tool).some((def) => {
    if (def.event !== event || (entry.matcher ?? '*') !== (def.matcher ?? '*')) return false;
    const dispatch = /\bhook-dispatch ([a-z-]+)/.exec(def.command)?.[1];
    return command === def.command
      || (dispatch !== undefined && command === getRawDispatchCommand(dispatch, tool, def.matcher));
  });
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
  priorRecords: ManagedHookRecord[],
): Promise<void> {
  // Built-in management never removes team hooks; team hooks are reconciled only
  // when a team pass is active (manifest present). This keeps the builtin-only
  // refresh path (injectHooks / autoMigrate) non-destructive to team hooks (§5).
  // Hook ids this reconcile declares for the tool, used to recognise our own
  // entries even when an older CLI rendered them differently.
  const desiredTeamIds = new Set(
    teamDefs.filter((d) => !d.tools || d.tools.includes(tool)).map((d) => d.key),
  );
  // Removal releases one entry per record, as Codex does by position: an older
  // CLI could append an identical entry that another checkout records (#373).
  // Reconciling keeps matching every copy, since it writes the desired one back.
  const unreleased = opts.removeAll ? [...priorRecords] : priorRecords;
  const isManaged = (event: string, e: HookMatcher): boolean => {
    if (opts.teamOnly) {
      if (isExactBuiltinEntry(event, tool, e)) return true;
      const index = e.hooks?.length === 1 ? unreleased.findIndex((r) =>
        r.event === event && (r.matcher ?? '*') === (e.matcher ?? '*') && r.command === e.hooks[0].command
        && teamHookIdOf(e.description) === r.id) : -1;
      if (index >= 0 && opts.removeAll) unreleased.splice(index, 1);
      return index >= 0;
    }
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
  const settings: ClaudeSettingsJson = await readHookFile<ClaudeSettingsJson>(expanded, {});
  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  // Clean up empty camelCase keys left by a previous incorrect injection.
  for (const key of ['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt', 'userPromptSubmit']) {
    if (settings.hooks[key] && settings.hooks[key].length === 0) {
      delete settings.hooks[key];
      changed = true;
    }
  }

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts);
  const eventOrder = desiredEventOrder(defs, (e) => e);
  const events = [...eventOrder, ...Object.keys(settings.hooks).filter((e) => !eventOrder.includes(e))];

  for (const event of events) {
    const existing = settings.hooks[event] ?? [];
    const untouched = existing.filter((e) => !isManaged(event, e));
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
  const hooksJson: CursorHooksJson = await readHookFile<CursorHooksJson>(expanded, { version: 1, hooks: {} });
  if (!hooksJson.version) hooksJson.version = 1;
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (entry: CursorHookEntry): boolean =>
    isTeamaiHookCommand(entry.command) || priorTeamCommands.has(entry.command);

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts);
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
  const hooksJson: CopilotHooksJson = await readHookFile<CopilotHooksJson>(expanded, {
    version: COPILOT_HOOK_SCHEMA_VERSION,
    hooks: {},
  });
  let changed = hooksJson.version !== COPILOT_HOOK_SCHEMA_VERSION;
  hooksJson.version = COPILOT_HOOK_SCHEMA_VERSION;
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (entry: CopilotHookEntry): boolean => copilotEntryCommands(entry).some((command) =>
    TEAMAI_COMMAND_MARKERS.some((marker) => command.includes(marker)) || priorTeamCommands.has(command),
  );
  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts);
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
  priorRecords: ManagedHookRecord[],
): Promise<ManagedHookRecord[]> {
  const expanded = expandHome(hooksPath);
  await ensureDir(path.dirname(expanded));
  const hooksJson: CodexHooksJson = await readHookFile<CodexHooksJson>(expanded, {});
  if (!hooksJson.hooks) hooksJson.hooks = {};

  const isManaged = (event: string, index: number, entries: CodexHookMatcher[]): boolean => {
    const entry = entries[index];
    const cmd = entry.hooks?.[0]?.command ?? '';
    // The team-hook dispatchers have their own pass (reconcileCodexDispatchers).
    if (!opts.removeAll && isCodexTeamHookDispatcher(cmd)) return false;
    return (opts.teamOnly
      ? isExactBuiltinEntry(event, tool, entry)
      : TEAMAI_COMMAND_MARKERS.some((marker) => cmd.includes(marker)))
      || priorRecords.some((record) => tool === CODEX_TOOL_ID
        ? ownsCodexEntry(record, event, index, entries)
        : record.command === cmd);
  };

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts);
  const eventOrder = desiredEventOrder(defs, (e) => e);
  const events = [...eventOrder, ...Object.keys(hooksJson.hooks).filter((e) => !eventOrder.includes(e))];

  let changed = false;
  const records: ManagedHookRecord[] = [];
  for (const event of events) {
    const existing = hooksJson.hooks[event] ?? [];
    const untouched = existing.filter((_, index) => !isManaged(event, index, existing));
    const eventDefs = defs.filter((d) => d.event === event);
    const desiredEntries = eventDefs.map(toCodexEntry);
    const newArr = [...untouched, ...desiredEntries];
    eventDefs.forEach((def, index) => {
      if (def.source !== 'team') return;
      records.push({
        id: def.key, event, command: def.command,
        ...(def.matcher && def.matcher !== '*' ? { matcher: def.matcher } : {}),
        ...(tool === CODEX_TOOL_ID ? {
          codexEntryIndex: untouched.length + index,
          codexEntry: desiredEntries[index],
        } : {}),
      });
    });
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
  return records;
}

/** Recover only a unique match on the definition or fields the manifest recorded. */
function ownsCodexEntry(record: ManagedHookRecord, event: string, index: number, entries: CodexHookMatcher[]): boolean {
  if (record.event !== event) return false;
  const entry = entries[index];
  if (record.codexEntry && record.codexEntryIndex === index && isDeepStrictEqual(entry, record.codexEntry)) return true;
  // Legacy manifests omitted timeout and additionalContextLimit. Requiring
  // those unrecorded options to be absent would orphan hooks on upgrade.
  const matches = record.codexEntry
    ? (candidate: CodexHookMatcher) => isDeepStrictEqual(candidate, record.codexEntry)
    : (candidate: CodexHookMatcher) => candidate.matcher === record.matcher
      && candidate.hooks?.length === 1
      && candidate.hooks[0].type === 'command'
      && candidate.hooks[0].command === record.command;
  return matches(entry) && entries.filter(matches).length === 1;
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
  const cfg: ZcodeHooksJson = await readHookFile<ZcodeHooksJson>(expanded, {});
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

  const defs = opts.removeAll ? [] : desiredDefs(tool, teamDefs, opts);
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
    const hooksJson: CodexHooksJson = await readHookFile<CodexHooksJson>(expanded, {});
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
    const settings: ClaudeSettingsJson = await readHookFile<ClaudeSettingsJson>(expanded, {});
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
    const hooksJson: CodexHooksJson = await readHookFile<CodexHooksJson>(expanded, {});
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
    const settings: ClaudeSettingsJson = await readHookFile<ClaudeSettingsJson>(expanded, {});
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
 * A hook settings file teamai writes back, or `fallback` when there is none. One that does not
 * parse, or is not a JSON object, is the member's to repair (#993): writing it would replace all
 * of it, so the hook pass for it stops here, the file left byte-identical and nothing recorded,
 * and the first pull after the repair writes it.
 */
export async function readHookFile<T>(file: string, fallback: T): Promise<T> {
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') {
    throw new Error(`${file} does not parse (${read.error}), so teamai left it as it is. Fix it, then run the command again.`);
  }
  return read.kind === 'ok' ? read.value as T : fallback;
}

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
  if (opts.mainCheckout) {
    const target = opts.mainCheckout;
    return reconcileMainCheckoutTeamHooks(settingsPath, tool, teamDefs, {
      manifestPath: target.manifestPath,
      legacyManifestPath: legacyManagedHooksPath(target.root),
      checkoutManifestPath: target.checkoutManifestPath,
      sharedWithOtherInstall: target.sharedWithOtherInstall,
      current: target.worktreeScoped ? undefined : target.current,
      root: target.worktreeScoped ? undefined : target.root,
      removeAll: opts.removeAll,
      teamHookHistory: opts.teamHookHistory,
    });
  }
  const teamActive = !!opts.manifestPath || !!opts.dropTeamEntries;
  const manifest = opts.manifestPath ? await readManifest(opts.manifestPath) : null;
  // Pre-#370 Codex hooks used this same file. Persist their authority in the
  // new manifest before touching the file; retire the old records only on success.
  const legacy = opts.teamOnly && tool === CODEX_TOOL_ID && opts.legacyManifestPath && manifest
    ? await readManifest(opts.legacyManifestPath) : null;
  if (legacy?.[tool]?.length && manifest && opts.manifestPath) {
    manifest[tool] = [...(manifest[tool] ?? []), ...legacy[tool]];
    await writeJson(expandHome(opts.manifestPath), manifest);
  }
  const allPriorRecords = manifest?.[tool] ?? [];
  const scopedDefs = scopedTeamDefs(teamDefs, opts.teamHookProjectRoot, tool);
  const recorded = opts.teamHookProjectRoot
    ? allPriorRecords.filter((r) => isGatedForProject(r.command, opts.teamHookProjectRoot!))
    : allPriorRecords;
  // An entry a lost record leaves is teamai's when it equals a team render, and is adopted (#993):
  // replaced by today's render, or removed when nothing is desired.
  const unrecorded = manifest && opts.teamHookHistory
    ? await judgeUnrecordedTeamEntries(settingsPath, tool, scopedDefs, recorded, opts)
    : null;
  for (const message of unrecorded?.kept ?? []) log.warn(message);
  const priorRecords = [...recorded, ...unrecorded?.adopted ?? []];
  const desiredTeamCommands = new Set(scopedDefs.filter((d) => !d.tools || d.tools.includes(tool)).map((d) => d.command));
  const priorTeamCommands = new Set(priorRecords.map((r) => r.command));

  const format = detectFormat(tool);
  let codexRecords: ManagedHookRecord[] | undefined;
  if (format === 'cursor') {
    await reconcileCursorFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else if (format === 'copilot') {
    await reconcileCopilotFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else if (format === 'codex') {
    codexRecords = await reconcileCodexFormat(settingsPath, tool, scopedDefs, opts, priorRecords);
  } else if (format === 'zcode') {
    await reconcileZcodeFormat(settingsPath, tool, scopedDefs, opts, priorTeamCommands);
  } else {
    await reconcileClaudeFormat(settingsPath, tool, scopedDefs, {
      ...opts,
      // In a shared HOME settings file, only remove team entries belonging to
      // this project. User-scope installs retain the historical marker sweep.
      teamHookProjectRoot: opts.teamHookProjectRoot,
    }, teamActive, desiredTeamCommands, priorTeamCommands, priorRecords);
  }

  // Update the manifest's team-hook index for this tool (when manifest is active).
  if (opts.manifestPath && manifest) {
    const records = codexRecords ?? manifestRecordsForTool(teamDefs, tool, !!opts.removeAll, opts.teamHookProjectRoot);
    const prev = manifest[tool] ?? [];
    // Main-checkout team-only files belong to one project; their old gated
    // records are consumed on migration. HOME retains the other projects.
    const retained = opts.teamHookProjectRoot
      ? prev.filter((r) => !isGatedForProject(r.command, opts.teamHookProjectRoot!))
      : prev.filter((r) => !opts.teamOnly && isProjectGatedCommand(r.command));
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
  if (legacy?.[tool]?.length && opts.legacyManifestPath) {
    delete legacy[tool];
    await writeJson(expandHome(opts.legacyManifestPath), legacy);
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
 * Pi cannot run custom team hooks — it supports built-in lifecycle hooks only —
 * so anything the team scoped to Pi is skipped, and a real reconcile says so.
 * Extracted from the reconcile loop so a dry run, which stops before the
 * per-tool stage, prints the same report without writing anything and its
 * "Would apply" line does not promise hooks no tool will run.
 *
 * Only warns when Pi is actually installed: Pi is in every team's default
 * toolPaths, so without this gate teammates who never use Pi see this warning
 * on every reconcile whenever the team defines a Pi-targeted hook.
 */
async function reportPiSkippedTeamHooks(
  defs: HookDef[],
  baseDir: string,
  installedBaseDir: string | undefined,
  builtinOverride: BuiltinHookOverride | undefined,
): Promise<void> {
  if (!await isPiInstalled(baseDir, installedBaseDir)) return;
  const applicableTeamDefs = teamDefsForTool(defs, 'pi');
  if (applicableTeamDefs.length > 0) {
    log.warn(
      `Pi supports built-in lifecycle hooks only; skipping ${applicableTeamDefs.length} custom team hook(s) from hooks/hooks.yaml`,
    );
  }
  const builtinOverrideCount = (builtinOverride?.disabled?.length ?? 0)
    + Object.keys(builtinOverride?.overrides ?? {}).length;
  if (builtinOverrideCount > 0) {
    log.warn(
      `Pi supports built-in lifecycle hooks only; skipping ${builtinOverrideCount} built-in hook override(s) from hooks/hooks.yaml`,
    );
  }
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
      const toolRoot = path.join(resolvedBaseDir, toolInstallRoot(paths.settings));
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
 * True when a `builtinsOnly` pass has nothing to install in this tool file, so
 * it is left byte-for-byte as it is. False for a normal reconcile.
 */
async function builtinsInstalled(
  builtinsOnly: BuiltinsOnly | undefined,
  settingsPath: string,
  tool: string,
  manifestPath: string,
  builtinOverride: BuiltinHookOverride | undefined,
): Promise<boolean> {
  switch (builtinsOnly) {
    case undefined:
      return false;
    case 'with-overrides':
      return await getHookStatus(settingsPath, tool, builtinOverride) === 'installed';
    case 'defaults-where-none':
      return hasTeamaiHooks(settingsPath, tool, manifestPath);
    default: {
      const unhandled: never = builtinsOnly;
      return unhandled;
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
 *
 * `builtinsOnly` (see BuiltinsOnly) installs the built-in hooks where they are
 * missing and leaves every installed team hook and the manifest as they are.
 */
export async function reconcileHooksToAllTools(
  toolPaths: Record<string, { settings?: string }>,
  baseDir: string,
  teamDefs: HookDef[],
  manifestPath: string,
  opts: {
    removeAll?: boolean; builtinOverride?: BuiltinHookOverride; filterAgents?: string[]; settingsOnly?: boolean; installedBaseDir?: string; teamHookProjectRoot?: string; scope?: Scope; builtinsOnly?: BuiltinsOnly; mainCheckout?: MainCheckoutHooks | null; teamHookHistory?: TeamHookHistory;
    /** Self mode: team hooks of SELF_LOCAL_TEAM_HOOK_TOOLS go to `settings.local.json` while `relocate` (#915). */
    selfLocalTeamHooks?: { relocate: boolean };
    /** Project scope: Codex team hooks may run from the dispatcher instead of the project's file (#915). */
    codexTeamHooks?: CodexTeamHookPlacement;
  } = {},
): Promise<Set<string>> {
  // Without the manifest, reconcileHooks manages the built-in entries only.
  const teamManifestPath = opts.builtinsOnly ? undefined : manifestPath;
  const defs = opts.builtinsOnly ? [] : teamDefs;
  const skipInstalled = async (settingsPath: string, tool: string): Promise<boolean> =>
    builtinsInstalled(opts.builtinsOnly, settingsPath, tool, manifestPath, opts.builtinOverride);
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
  const reconciledMainTools = new Set<string>();
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
          const { removeOpenClawHooks, removeOpenClawHookEntry, resolveOpenclawWorkspaceDir } = await import('./openclaw-hooks.js');
          const wsDir = await resolveOpenclawWorkspaceDir();
          if (wsDir) await removeOpenClawHooks(path.join(wsDir, 'hooks'));
          await removeOpenClawHookEntry();
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
        if (!opts.removeAll) {
          await reportPiSkippedTeamHooks(defs, baseDir, opts.installedBaseDir, opts.builtinOverride);
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
        const { isDshInstalled, reconcileDshHooks, resolveDshHookConfigPath } = await import('./dsh-hooks.js');
        if (opts.removeAll || await isDshInstalled()) {
          if (await skipInstalled(resolveDshHookConfigPath(), 'dsh')) continue;
          await reconcileDshHooks(defs, {
            manifestPath: teamManifestPath,
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
    const toolRoot = path.join(baseDir, toolInstallRoot(paths.settings));
    const installedRoot = opts.installedBaseDir
      ? path.join(opts.installedBaseDir, toolInstallRoot(paths.settings))
      : toolRoot;
    const mainFile = mainCheckoutHookFile(opts.mainCheckout, tool);
    const localFile = opts.selfLocalTeamHooks ? selfLocalHookFile(baseDir, tool, paths.settings) : null;
    const installed = await pathExists(toolRoot) || await pathExists(installedRoot)
      || (!opts.removeAll && mainFile !== null && await pathExists(mainFile));
    // Existing main-checkout hooks can be removed after HOME was deleted or
    // relocated. Do not recreate the missing HOME root just to remove them.
    if (!installed && !(opts.removeAll && mainFile)) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    const settingsFileKey = path.resolve(settingsPath);
    if (claimedSettingsFiles.has(settingsFileKey)) continue;
    claimedSettingsFiles.add(settingsFileKey);
    try {
      if (installed && await skipInstalled(settingsPath, tool)) continue;
      // The file the project's Codex team hooks would go to: the main checkout's, or self mode's own.
      const codexFile = tool === CODEX_TOOL_ID && opts.codexTeamHooks && !opts.builtinsOnly
        ? mainFile ?? (opts.codexTeamHooks.self ? settingsPath : null) : null;
      const dispatched = codexFile !== null && await placeCodexTeamHooks(opts.codexTeamHooks!, codexFile, defs, [
        ...(await readManifest(opts.mainCheckout && mainFile ? opts.mainCheckout.manifestPath : manifestPath))[tool] ?? [],
        ...(opts.mainCheckout && mainFile ? (await readManifest(legacyManagedHooksPath(opts.mainCheckout.root)))[tool] ?? [] : []),
      ], { removeAll: opts.removeAll, teamHookHistory: opts.teamHookHistory });
      // Dispatched: teamai's entries leave the file, through its manifest.
      const fileDefs = dispatched ? [] : defs;
      if (installed) {
        if (mainFile && opts.mainCheckout && opts.teamHookProjectRoot && !opts.removeAll) {
          // HOME keeps this tool's built-ins only: the project's team hooks live
          // in the main checkout, and the gated copies of them are removed.
          for (const root of await staleCheckoutGateRoots(teamManifestPath, tool, opts.teamHookProjectRoot, opts.mainCheckout)) {
            await reconcileHooks(settingsPath, tool, [], {
              manifestPath: teamManifestPath,
              builtinOverride: opts.builtinOverride,
              teamHookProjectRoot: root,
              teamHookHistory: opts.teamHookHistory,
            });
          }
        } else if (localFile && !opts.builtinsOnly) {
          await reconcileSelfLocalTeamHooks(settingsPath, localFile, tool, defs, manifestPath, {
            relocate: opts.selfLocalTeamHooks?.relocate ?? false,
            removeAll: opts.removeAll,
            builtinOverride: opts.builtinOverride,
            teamHookHistory: opts.teamHookHistory,
          });
        } else {
          await reconcileHooks(settingsPath, tool, fileDefs, {
            manifestPath: teamManifestPath,
            removeAll: opts.removeAll,
            builtinOverride: opts.builtinOverride,
            teamHookProjectRoot: opts.teamHookProjectRoot,
            teamHookHistory: opts.teamHookHistory,
          });
        }
      }
      // With the team hooks unresolved, the ones installed there are kept.
      if (mainFile && opts.mainCheckout && !opts.builtinsOnly) {
        await reconcileMainCheckoutTeamHooks(mainFile, tool, fileDefs, {
          manifestPath: opts.mainCheckout.manifestPath,
          legacyManifestPath: legacyManagedHooksPath(opts.mainCheckout.root),
          checkoutManifestPath: opts.mainCheckout.checkoutManifestPath,
          sharedWithOtherInstall: opts.mainCheckout.sharedWithOtherInstall,
          current: opts.mainCheckout.worktreeScoped ? undefined : opts.mainCheckout.current,
          root: opts.mainCheckout.worktreeScoped ? undefined : opts.mainCheckout.root,
          removeAll: opts.removeAll,
          teamHookHistory: opts.teamHookHistory,
        });
        reconciledMainTools.add(tool);
      }
    } catch (e) {
      log.warn(`Failed to reconcile hooks for ${tool}: ${(e as Error).message}`);
    }
  }
  return reconciledMainTools;
}

/**
 * Reconcile the team hooks of one tool's main-checkout file
 * (MAIN_CHECKOUT_TEAM_HOOK_TOOLS). Nothing is created for a tool without team
 * hooks: a business repo that never had any gets no `.claude/settings.local.json`
 * or `.codex/` from teamai.
 */
async function reconcileMainCheckoutTeamHooks(
  file: string,
  tool: string,
  teamDefs: HookDef[],
  opts: {
    manifestPath: string;
    legacyManifestPath?: string;
    checkoutManifestPath?: string;
    sharedWithOtherInstall?: boolean;
    current?: string;
    root?: string;
    removeAll?: boolean;
    teamHookHistory?: TeamHookHistory;
  },
): Promise<void> {
  const { checkoutManifestPath, sharedWithOtherInstall, current, root, ...reconcileOpts } = opts;
  const wanted = opts.removeAll ? [] : teamDefsForTool(teamDefs, tool);
  if (wanted.length === 0 && !await pathExists(file) && !opts.removeAll) return;

  const manifest = await readJson<SharedHooksManifest>(expandHome(opts.manifestPath)) ?? {};
  const canonicalCurrent = current ? canonicalProjectRoot(current) : null;
  const canonicalRoot = root ? canonicalProjectRoot(root) : null;

  if (opts.removeAll) {
    let othersUsingHook = false;
    if (canonicalCurrent && canonicalRoot) {
      let checkouts = getToolCheckouts(manifest, tool);
      const tracked = Array.isArray(manifest.checkouts) || Object.hasOwn(manifest.checkouts ?? {}, tool);
      if (!tracked && manifest[tool]) {
        checkouts = await discoverInstalledCheckouts(canonicalRoot, tool);
      }
      const liveWorktrees = new Set((await listWorktrees(canonicalRoot)).map(canonicalProjectRoot));
      const remaining = checkouts
        .map(canonicalProjectRoot)
        .filter((c) => c !== canonicalCurrent && (c === canonicalRoot || liveWorktrees.has(c)));
      setToolCheckouts(manifest, tool, remaining);
      if (remaining.length > 0) {
        othersUsingHook = true;
      }
    } else if (sharedWithOtherInstall) {
      othersUsingHook = true;
    }

    if (othersUsingHook) {
      const otherHasOwnManifest = canonicalRoot
        ? await otherWorktreeHasOwnManifest(canonicalRoot, canonicalCurrent ?? canonicalRoot, tool)
        : false;
      await writeJson(expandHome(opts.manifestPath), manifest);
      const ownerManifestPath = checkoutManifestPath ?? (otherHasOwnManifest ? opts.manifestPath : undefined);
      if (ownerManifestPath) {
        await removeCheckoutTeamHooks(file, tool, ownerManifestPath, opts.manifestPath, canonicalRoot ?? undefined);
      }
      return;
    }

    if (manifest.checkouts && typeof manifest.checkouts === 'object' && !Array.isArray(manifest.checkouts)) {
      delete (manifest.checkouts as Record<string, string[]>)[tool];
      if (Object.keys(manifest.checkouts).length === 0) {
        delete manifest.checkouts;
      }
      await writeJson(expandHome(opts.manifestPath), manifest);
    }
  }

  // Injection consolidates every checkout's old ownership before deduplicating.
  // Leaving one old record behind would let a later removal take the shared copy.
  // Direct removal still consumes only this checkout's records.
  const checkoutPaths = new Set(checkoutManifestPath ? [checkoutManifestPath] : []);
  if (!opts.removeAll && canonicalRoot) {
    for (const worktree of await listWorktrees(canonicalRoot)) {
      if (canonicalProjectRoot(worktree) === canonicalRoot) continue;
      checkoutPaths.add(path.join(getTeamaiHome('project', worktree), 'managed-main-checkout-hooks.json'));
    }
  }
  checkoutPaths.delete(opts.manifestPath);
  const adopted: Array<{ path: string; manifest: ManagedHooksManifest }> = [];
  for (const checkoutPath of checkoutPaths) {
    const checkout = await readManifest(checkoutPath);
    if (!checkout[tool]?.length) continue;
    manifest[tool] = [...((manifest[tool] as ManagedHookRecord[]) ?? []), ...checkout[tool]];
    adopted.push({ path: checkoutPath, manifest: checkout });
  }
  if (adopted.length > 0) await writeJson(expandHome(opts.manifestPath), manifest);
  await reconcileHooks(file, tool, teamDefs, { ...reconcileOpts, teamOnly: true });
  for (const checkout of adopted) {
    delete checkout.manifest[tool];
    await writeJson(expandHome(checkout.path), checkout.manifest);
  }

  if (!opts.removeAll && canonicalCurrent) {
    const updated = await readJson<SharedHooksManifest>(expandHome(opts.manifestPath)) ?? {};
    if (updated[tool]?.length) {
      const existing = getToolCheckouts(updated, tool);
      let checkouts: string[];
      if (existing.length === 0) {
        const discovered = canonicalRoot ? await discoverInstalledCheckouts(canonicalRoot, tool) : [];
        checkouts = Array.from(new Set([...discovered, canonicalCurrent]));
      } else {
        checkouts = Array.from(new Set([...existing.map(canonicalProjectRoot), canonicalCurrent]));
      }
      setToolCheckouts(updated, tool, checkouts);
    } else {
      if (updated.checkouts && typeof updated.checkouts === 'object' && !Array.isArray(updated.checkouts)) {
        delete (updated.checkouts as Record<string, string[]>)[tool];
        if (Object.keys(updated.checkouts).length === 0) {
          delete updated.checkouts;
        }
      }
    }
    await writeJson(expandHome(opts.manifestPath), updated);
  }
}

/** Keep surviving legacy ownership positions aligned when a shared file shrinks. */
async function removeCheckoutTeamHooks(file: string, tool: string, manifestPath: string, sharedManifestPath: string, root?: string): Promise<void> {
  const before = tool === CODEX_TOOL_ID && root ? await readJson<CodexHooksJson>(file) : null;
  const owned = before ? (await readManifest(manifestPath))[tool] ?? [] : [];
  const surviving = new Map<string, number[]>();
  for (const [event, entries] of Object.entries(before?.hooks ?? {})) {
    surviving.set(event, entries.flatMap((entry, index) =>
      isExactBuiltinEntry(event, tool, entry) || owned.some((record) => ownsCodexEntry(record, event, index, entries))
        ? [] : [index]));
  }
  await reconcileHooks(file, tool, [], { manifestPath, removeAll: true, teamOnly: true });
  if (!before?.hooks || !root) return;
  const after = await readJson<CodexHooksJson>(file);
  const siblingPaths = new Set([sharedManifestPath, ...(await listWorktrees(root))
    .map((worktree) => path.join(getTeamaiHome('project', worktree), 'managed-main-checkout-hooks.json'))]);
  for (const siblingPath of siblingPaths) {
    if (siblingPath === manifestPath) continue;
    const sibling = await readManifest(siblingPath);
    let changed = false;
    for (const record of sibling[tool] ?? []) {
      const index = record.codexEntryIndex;
      if (index === undefined || !record.codexEntry
        || !isDeepStrictEqual(before.hooks[record.event]?.[index], record.codexEntry)) continue;
      const shifted = surviving.get(record.event)?.indexOf(index) ?? -1;
      if (shifted < 0 || shifted === index
        || !isDeepStrictEqual(after?.hooks?.[record.event]?.[shifted], record.codexEntry)) continue;
      record.codexEntryIndex = shifted;
      changed = true;
    }
    if (changed) await writeJson(expandHome(siblingPath), sibling);
  }
}

/** What a Codex trust pass for one scope works on. */
interface CodexTrustTargets {
  /** The Codex home teamai writes to (the member's `toolRoots.codex`, else `~/.codex`). */
  codexHome: string;
  /** The checkout whose hook layers are listed (HOME in user scope). */
  cwd: string;
  /** Exact generated Codex entries, including Codex's file/event/position key. */
  hooks: Array<{ file: string; command: string; key: string }>;
  /** The main checkout, when Codex has to read its `.codex/` layer. */
  project?: string;
  /** The files whose bytes a trust pass depends on. */
  inputs: string[];
  /** The Codex project MCP servers teamai wrote for this checkout. */
  mcpRecords: unknown[];
}

/** Select recorded team entries, not every occurrence of a managed command. */
async function teamaiCodexHooks(file: string, manifestPath: string): Promise<CodexTrustTargets['hooks']> {
  const json = await readJson<CodexHooksJson>(file);
  if (!json?.hooks) return [];
  const records = (await readManifest(manifestPath))[CODEX_TOOL_ID] ?? [];
  const builtins = builtinHookDefs(CODEX_TOOL_ID);
  return Object.entries(json.hooks).flatMap(([event, groups]) => (groups ?? []).flatMap((group, index) => {
    const command = group.hooks?.[0]?.command;
    const builtin = group.hooks?.length === 1 && (isCodexTeamHookDispatcher(command ?? '') || builtins.some((def) =>
      def.event === event && def.command === command && toCodexEntry(def).matcher === group.matcher));
    if (typeof command !== 'string' || !(builtin || records.some((r) => ownsCodexEntry(r, event, index, groups)))) return [];
    const snake = event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return [{ file, command, key: `${canonicalProjectRoot(file)}:${snake}:${index}:0` }];
  }));
}

/**
 * What a Codex trust pass covers in this scope, or null when teamai wrote
 * nothing for the public Codex here (not a configured or enabled tool, no hook
 * and no project MCP server written). The project is the main checkout: in self
 * mode always, and in a non-self project scope when its `.codex/` holds team
 * hooks or the checkout's Codex project MCP servers (#954), since Codex reads
 * neither from an untrusted project.
 */
async function codexTrustTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  selectedAgents?: string[],
): Promise<CodexTrustTargets | null> {
  const { baseDir, manifestPath, scope: hookScope } = resolveHookScope(localConfig);
  const paths = scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope })[CODEX_TOOL_ID];
  if (!paths?.settings) return null;
  const agents = hookFilterAgents(teamConfig, localConfig, selectedAgents);
  if (agents && !agents.includes(CODEX_TOOL_ID)) return null;

  const primary = path.join(canonicalProjectRoot(baseDir), paths.settings);
  const sources = [{ file: primary, manifestPath }];
  let anchor: string | undefined;
  let mainFile: string | null = null;
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    anchor = (await mainCheckoutOf(localConfig.projectRoot)).root;
    const mainCheckout = await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths);
    mainFile = mainCheckoutHookFile(mainCheckout, CODEX_TOOL_ID);
    if (mainCheckout && mainFile) {
      sources.push({ file: mainFile, manifestPath: mainCheckout.manifestPath });
    } else if (isSelfMode(localConfig) && path.join(anchor, paths.settings) !== primary) {
      // A linked worktree of a self repo: Codex reads the main checkout's file.
      sources[0] = { file: path.join(anchor, paths.settings), manifestPath };
    }
    // Self mode: the team-hook dispatchers live in HOME, beside the project's file.
    const home = codexHomeHooksFile(teamConfig, localConfig);
    if (isSelfMode(localConfig) && home && !sources.some((s) => s.file === home)) sources.push({ file: home, manifestPath });
  }
  const hooks = (await Promise.all(sources.map((s) => teamaiCodexHooks(s.file, s.manifestPath)))).flat();
  const mcpRecords = localConfig.scope === 'project'
    ? (await readJson<ManagedMcpManifest>(expandHome(managedMcpManifestPath(getDataHome(localConfig), localConfig.projectRoot))))
      ?.[managedMcpManifestKey(CODEX_TOOL_ID, true)] ?? []
    : [];
  if (hooks.length === 0 && mcpRecords.length === 0) return null;

  const projectLayer = isSelfMode(localConfig)
    || hooks.some((h) => h.file === mainFile)
    || mcpRecords.length > 0;
  const codexHome = resolveToolRootDir(CODEX_TOOL_ID, DEFAULT_CODEX_ROOT, localConfig.toolRoots);
  return {
    codexHome,
    cwd: anchor ?? baseDir,
    hooks,
    ...(anchor && projectLayer ? { project: anchor } : {}),
    inputs: [...sources.map((s) => s.file), path.join(codexHome, 'config.toml')],
    mcpRecords,
  };
}

/**
 * Everything a trust pass's outcome depends on: what teamai wrote, the bytes of
 * the hook files and of Codex's `config.toml`, and which `codex` binary would
 * answer — an upgrade can change how Codex hashes a hook without touching
 * any file here.
 */
async function codexTrustFingerprint(targets: CodexTrustTargets): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify({ ...targets, inputs: undefined }));
  for (const file of targets.inputs) hash.update(`\0${file}\0${await readFileSafe(file) ?? ''}`);
  const codex = findOnPath('codex');
  if (codex) {
    try {
      const real = realpathSync.native(codex);
      const { mtimeMs, size } = await stat(real);
      hash.update(`\0${real}\0${mtimeMs}\0${size}`);
    } catch {
      hash.update(`\0${codex}`);
    }
  }
  return hash.digest('hex');
}

/**
 * Trust in Codex what teamai wrote for it in this scope (#955): the hooks in
 * its hook files and, when Codex has to read the main checkout's `.codex/`,
 * that project. Run after every write of a Codex hooks file and, in a pull,
 * after the MCP reconcile too, so a project whose only Codex content is its MCP
 * servers is trusted by the same pull.
 *
 * Skips the `codex app-server` spawn when the last pass ended `trusted` and
 * none of its inputs changed since (see State.codexTrustFingerprint); `force`
 * runs it anyway. Undefined when there is nothing of teamai's to trust.
 */
export async function trustCodexForScope(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  opts: { filterAgents?: string[]; force?: boolean } = {},
): Promise<CodexTrust | undefined> {
  const targets = await codexTrustTargets(teamConfig, localConfig, opts.filterAgents);
  if (!targets) return undefined;
  if (localConfig.codexTrustEnabled === false) return { kind: 'disabled' };
  const { loadStateForScope, saveStateForScope } = await import('./config.js');
  const cached = { kind: 'trusted', hooks: 0, ...(targets.project ? { project: targets.project } : {}) } as const;
  if (!opts.force && (await loadStateForScope(localConfig)).codexTrustFingerprint === await codexTrustFingerprint(targets)) {
    return cached;
  }
  const { trustCodexHooks } = await import('./codex-trust.js');
  const trust = await trustCodexHooks(targets);
  const fingerprint = trust.kind === 'trusted' ? await codexTrustFingerprint(targets) : undefined;
  const state = await loadStateForScope(localConfig);
  if (state.codexTrustFingerprint !== fingerprint) {
    state.codexTrustFingerprint = fingerprint;
    await saveStateForScope(state, localConfig);
  }
  return trust;
}

/**
 * Read-only, for `doctor`: which teamai hooks Codex will not run in this scope.
 * Null when teamai wrote no Codex hook here.
 */
export async function readCodexHookTrustForScope(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<CodexHookTrustReport | null> {
  const targets = await codexTrustTargets(teamConfig, localConfig);
  if (!targets || targets.hooks.length === 0) return null;
  const { readCodexHookTrust } = await import('./codex-trust.js');
  return readCodexHookTrust({ ...targets, cwd: localConfig.projectRoot ?? targets.cwd });
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
  reconciledMainTools: ReadonlySet<string> = new Set(),
): Promise<void> {
  const legacy = resolveLegacyProjectHookScope(localConfig);
  if (!legacy) return;
  // A coincident main file is handled by the main pass only when that tool
  // actually ran. Excluded tools still need legacy cleanup, without claiming
  // current-generation or member entries in the same file.
  const mainCheckout = await resolveMainCheckoutHooks(localConfig, toolPaths);
  const legacyToolPaths: typeof toolPaths = {};
  for (const [tool, paths] of Object.entries(toolPaths)) {
    const mainFile = mainCheckoutHookFile(mainCheckout, tool);
    if (mainFile && paths.settings && path.join(canonicalProjectRoot(legacy.baseDir), paths.settings) === mainFile) {
      if (!reconciledMainTools.has(tool) && await pathExists(mainFile)) {
        await reconcileHooks(mainFile, tool, [], { removeAll: true, teamOnly: true, manifestPath: legacy.manifestPath });
      }
    } else {
      legacyToolPaths[tool] = paths;
    }
  }
  await reconcileHooksToAllTools(legacyToolPaths, legacy.baseDir, [], legacy.manifestPath, {
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
 * What a team-hooks reconcile did. When the team hooks do not resolve, every
 * installed team hook is kept and the built-in hooks, the session-start pull
 * among them, are still installed where missing: with the root file's
 * overrides when hooks/hooks.yaml parses, and otherwise with their defaults,
 * only in a tool that has no teamai hook yet (a first install).
 */
export type TeamHooksReconcile =
  | { ok: true; defs: HookDef[] }
  | { ok: false; builtins: BuiltinsOnly };

/**
 * The tools a hook pass reaches: the explicit selection (or the config's
 * `enabledAgents` whitelist) minus `disabledAgents`, which always applies —
 * with no whitelist, starting from the full configured tool set. Undefined
 * means every tool.
 */
function hookFilterAgents(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  selected?: string[],
): string[] | undefined {
  const filterAgents = selected ?? localConfig.enabledAgents;
  const disabled = localConfig.disabledAgents;
  if (!disabled || disabled.length === 0) return filterAgents;
  return (filterAgents ?? Object.keys(teamConfig.toolPaths)).filter((t) => !disabled.includes(t));
}

/**
 * Reconcile built-in (A) + team (B) hooks for a single scope's tools.
 * Resolves the scope's team hooks, the scope base dir + manifest, and
 * reconciles every tool. Returns the team defs that were applied (for
 * logging/transparency), or `ok: false` when the team hooks could not be
 * resolved (see TeamHooksReconcile). Used by `pull`, `init`, and `hooks inject`.
 */
export async function reconcileTeamHooksForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  opts: { removeAll?: boolean; auto?: boolean; silent?: boolean; filterAgents?: string[]; dryRun?: boolean } = {},
): Promise<TeamHooksReconcile> {
  const resolved: Awaited<ReturnType<typeof resolveTeamHooks>> = opts.removeAll
    ? { ok: true, defs: [], builtin: undefined }
    : await resolveTeamHooks(teamConfig, localConfig, {
        auto: opts.auto,
        silent: opts.silent,
        // Resolve and report, then stop: a dry run must show the entry warnings
        // and the hooks it would apply without touching any tool's settings
        // (#822).
        preview: opts.dryRun,
      });
  // The team's hooks could not be resolved (reported by resolveTeamHooks).
  // Reconciling the team set now would remove every installed team hook, so
  // only the built-in hooks are reconciled.
  const builtinsOnly: BuiltinsOnly | undefined = resolved.ok ? undefined
    : resolved.builtin.known ? 'with-overrides' : 'defaults-where-none';
  const teamDefs = resolved.ok ? resolved.defs : [];
  const builtin = resolved.ok ? resolved.builtin
    : resolved.builtin.known ? resolved.builtin.override : undefined;
  const { baseDir, manifestPath, scope: hookScope } = resolveHookScope(localConfig);
  const explicitlySelectedAgents = opts.filterAgents ?? localConfig.enabledAgents;
  const disabled = localConfig.disabledAgents;
  const filterAgents = hookFilterAgents(teamConfig, localConfig, opts.filterAgents);
  // Resolve the tool paths at the scope hooks actually live in, not at the
  // config's scope: a non-self project scope puts hooks in HOME, so its paths
  // must be the user-scope ones.
  //
  // A dry run stops here. The resolution above already reported the entry
  // warnings and the hooks it would apply; everything below writes a tool's
  // settings or the managed-hooks manifest. The result mirrors what a real
  // reconcile would report, so a caller cannot tell them apart by the shape.
  //
  // One report happens below the stop point and a dry run must still make it:
  // a tool that cannot run team hooks says so during the per-tool pass, and
  // the preview is only honest when the dry run repeats it — for the tools the
  // pass would actually reach, which is what hookToolPaths decides below too.
  const hookToolPaths = scopedToolPaths(teamConfig, { ...localConfig, scope: hookScope });
  if (opts.dryRun) {
    if (!opts.removeAll) await installProjectGitHook(localConfig, { dryRun: true });
    if (!opts.removeAll && 'pi' in hookToolPaths && (!filterAgents || filterAgents.includes('pi'))) {
      await reportPiSkippedTeamHooks(teamDefs, baseDir, localConfig.scope === 'project' ? (localConfig.projectRoot ?? baseDir) : undefined, builtin);
    }
    return resolved.ok ? { ok: true, defs: teamDefs } : { ok: false, builtins: builtinsOnly ?? 'with-overrides' };
  }
  // Before any reconcile reads this checkout's manifest (#993).
  await migrateLegacyManagedHooks(localConfig);
  const history = teamHookHistory(localConfig);
  const codexProject = await codexTeamHookProject(localConfig);
  const codexHome = codexHomeHooksFile(teamConfig, localConfig);
  const reconciledMainTools = await reconcileHooksToAllTools(hookToolPaths, baseDir, teamDefs, manifestPath, {
    removeAll: opts.removeAll,
    builtinOverride: builtin,
    filterAgents,
    teamHookProjectRoot: localConfig.scope === 'project' && !isSelfMode(localConfig)
      ? localConfig.projectRoot
      : undefined,
    installedBaseDir: localConfig.scope === 'project' ? (localConfig.projectRoot ?? baseDir) : undefined,
    scope: localConfig.scope,
    builtinsOnly,
    mainCheckout: await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths),
    teamHookHistory: history,
    ...(isSelfMode(localConfig) && localConfig.scope === 'project' && localConfig.projectRoot
      ? { selfLocalTeamHooks: { relocate: isGitExcludeEnabled(localConfig, teamConfig) } }
      : {}),
    ...(codexProject
      ? { codexTeamHooks: { project: codexProject, gitExclude: resolveGitExclude(localConfig, teamConfig), self: isSelfMode(localConfig), homeFile: codexHome } }
      : {}),
  });
  // The dispatcher entries follow every project's choice, this one's included.
  if (codexProject && codexHome && !builtinsOnly && (!filterAgents || filterAgents.includes(CODEX_TOOL_ID))) {
    try {
      await reconcileCodexDispatchers(codexHome);
    } catch (e) {
      log.warn(`Failed to reconcile the Codex team-hook dispatchers in ${codexHome}: ${(e as Error).message}`);
    }
  }

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
    const copilotHooksPath = path.join(copilotBase, copilotPaths.hooks);
    const copilotManifestPath = getManagedHooksPath(localConfig);
    const copilotInstalled = await builtinsInstalled(
      builtinsOnly, copilotHooksPath, COPILOT_TOOL_ID, copilotManifestPath, builtin);
    if (!copilotInstalled && (copilotSelected || await pathExists(getCopilotHome()))) {
      await reconcileHooks(
        copilotHooksPath,
        COPILOT_TOOL_ID,
        teamDefs,
        {
          manifestPath: builtinsOnly ? undefined : copilotManifestPath,
          removeAll: opts.removeAll,
          builtinOverride: builtin,
          teamHookHistory: history,
        },
      );
    }
  }
  if (!builtinsOnly) await sweepLegacyProjectHooks(teamConfig.toolPaths, localConfig, reconciledMainTools);
  // The pre-#370 import and the sweep above may have emptied the old index.
  await migrateLegacyManagedHooks(localConfig);
  // Last, so a repository whose hooks cannot be written still gets the agent
  // hooks above; the error then reaches the caller.
  if (!opts.removeAll) await installProjectGitHook(localConfig);
  if (builtinsOnly) return { ok: false, builtins: builtinsOnly };
  return { ok: true, defs: teamDefs };
}

/**
 * The project files holding teamai's hook entries, as a pull delivered them
 * (#915): the main checkout's `.claude/settings.local.json` while its manifest
 * records team hooks there, and Copilot's hook file while it holds teamai's
 * entries. Read from disk after the reconcile, so a file the pass left as it
 * was (team hooks unresolved, built-ins already installed) counts too. In self
 * mode, this checkout's `.claude/settings.local.json` while its manifest records
 * team hooks there; never the tracked settings or `.codex/hooks.json`.
 */
export async function deliveredHookFiles(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const files: string[] = [];
  for (const { file, tool, manifestPath } of await projectHookFiles(teamConfig, localConfig)) {
    if (await hasTeamaiHooks(file, tool, manifestPath)) files.push(file);
  }
  return files;
}

/**
 * The files of deliveredHookFiles' candidates that do not parse (#915). The
 * hook pass leaves such a file as it is, so whether it still holds teamai's
 * entries is unknown until the member repairs it.
 */
export async function unreadableHookFiles(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const files: string[] = [];
  for (const { file } of await projectHookFiles(teamConfig, localConfig)) {
    if ((await readJsonObject(file)).kind === 'invalid') files.push(file);
  }
  return files;
}

/** The project files that may hold teamai's hook entries, each with the manifest recording them. */
async function projectHookFiles(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<Array<{ file: string; tool: string; manifestPath: string }>> {
  if (localConfig.scope !== 'project') return [];
  const files: Array<{ file: string; tool: string; manifestPath: string }> = [];
  const main = await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths);
  const claudeFile = mainCheckoutHookFile(main, 'claude');
  if (main && claudeFile && ((await readManifest(main.manifestPath)).claude?.length ?? 0) > 0) {
    files.push({ file: claudeFile, tool: 'claude', manifestPath: main.manifestPath });
  }
  // Self mode: this checkout's own settings.local.json while its manifest records team hooks there.
  const selfLocal = selfLocalTeamHookFile(localConfig, scopedToolPaths(teamConfig, localConfig), 'claude');
  const selfManifest = getManagedHooksPath(localConfig);
  if (selfLocal && ((await readManifest(selfManifest)).claude?.length ?? 0) > 0) {
    files.push({ file: selfLocal, tool: 'claude', manifestPath: selfManifest });
  }
  const copilotHooks = scopedToolPaths(teamConfig, localConfig)[COPILOT_TOOL_ID]?.hooks;
  if (copilotHooks) {
    files.push({
      file: path.join(resolveToolBaseDir(COPILOT_TOOL_ID, localConfig), copilotHooks),
      tool: COPILOT_TOOL_ID,
      manifestPath: getManagedHooksPath(localConfig),
    });
  }
  return files;
}

/**
 * The project's `.codex/hooks.json`, when it exists and holds anything, and
 * whether it holds only teamai's team hooks (#915): no top-level key but
 * `hooks`, and every handler one that teamai's hook manifest for that file
 * records (the main checkout's `managed-main-checkout-hooks.json`, or this
 * checkout's `managed-hooks.json` in self mode), at least one. Run after the
 * reconcile, which records the unrecorded entries that equal a team render
 * (#993). A symlink is the member's and is not judged. Read-only.
 */
export async function judgeTeamaiOnlyCodexHooks(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<{ file: string; teamaiOnly: boolean } | null> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return null;
  let file: string | null;
  let manifestPath: string;
  if (isSelfMode(localConfig)) {
    const settings = scopedToolPaths(teamConfig, localConfig)[CODEX_TOOL_ID]?.settings;
    file = settings ? path.join(resolveHookScope(localConfig).baseDir, settings) : null;
    manifestPath = getManagedHooksPath(localConfig);
  } else {
    const main = await resolveMainCheckoutHooks(localConfig, teamConfig.toolPaths);
    file = mainCheckoutHookFile(main, CODEX_TOOL_ID);
    manifestPath = main?.manifestPath ?? '';
  }
  if (!file || !(await lstat(file).catch(() => null))?.isFile()) return null;
  const raw = await readFileSafe(file);
  if (raw === null || raw.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { file, teamaiOnly: false };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { file, teamaiOnly: false };
  if (Object.keys(json).length === 0) return null;
  const { hooks, ...others } = json as { hooks?: unknown };
  if (Object.keys(others).length > 0 || typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return { file, teamaiOnly: false };
  const records = (await readManifest(manifestPath))[CODEX_TOOL_ID] ?? [];
  let owned = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) return { file, teamaiOnly: false };
    for (let index = 0; index < entries.length; index++) {
      if (!records.some((record) => ownsCodexEntry(record, event, index, entries as CodexHookMatcher[]))) return { file, teamaiOnly: false };
      owned++;
    }
  }
  return { file, teamaiOnly: owned > 0 };
}

/**
 * Project scope: install teamai's git hook (git-hook.ts) in the repository, so
 * a new worktree gets the team's resources before `git worktree add` returns.
 * User scope installs none: its resources live in HOME, which a new worktree
 * does not change. Installation errors propagate to the caller.
 */
async function installProjectGitHook(localConfig: LocalConfig, opts: { dryRun?: boolean } = {}): Promise<void> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return;
  const { installGitHook } = await import('./git-hook.js');
  let result: Awaited<ReturnType<typeof installGitHook>>;
  try {
    result = await installGitHook(localConfig.projectRoot, opts);
  } catch (e) {
    throw new Error(`Could not install the teamai git hook in ${localConfig.projectRoot}: ${(e as Error).message}. `
      + 'New worktrees and `git pull` get the team\'s resources only at the next session. '
      + 'Fix the cause, then run `teamai pull` to install it.', { cause: e });
  }
  if (opts.dryRun && result.installed && result.changed) {
    log.info(`Would install or update the teamai git hook (post-checkout, post-merge, post-rewrite) in ${localConfig.projectRoot}`);
  }
  if (!result.installed) log.debug(`git hook: not installed in ${localConfig.projectRoot} (${result.reason})`);
}

/**
 * The line `init` and bootstrap print when the team hooks did not resolve. The
 * reason, naming the file, was already reported by the resolution.
 */
export function describeUnappliedTeamHooks(result: { builtins: BuiltinsOnly }): string {
  switch (result.builtins) {
    case 'with-overrides':
      return 'Team hooks were not installed (see the warning above); the built-in hooks were. '
        + 'Once the team repo is fixed, the next pull installs the team hooks.';
    case 'defaults-where-none':
      return 'Team hooks were not installed: hooks/hooks.yaml in the team repo does not parse, so its built-in '
        + 'hook overrides are unknown, and the built-in hooks were installed with their defaults where none were '
        + 'installed yet. Fix hooks/hooks.yaml in the team repo and push; the next pull then applies both.';
    default: {
      const unhandled: never = result.builtins;
      return String(unhandled);
    }
  }
}
