import path from 'node:path';
import { readJson, writeJson, expandHome, ensureDir, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX, TEAMAI_CUSTOM_HOOK_PREFIX, getManagedHooksPath, resolveBaseDir } from './types.js';
import type { HookDef, TeamaiConfig, LocalConfig } from './types.js';
import { builtinHookDefs, applyBuiltinOverride } from './builtin-hooks.js';
import type { BuiltinHookOverride } from './builtin-hooks.js';
import { resolveTeamHooks } from './resources/hooks.js';

/**
 * Lobster-family agents (OpenClaw engine) that use HOOK.md + handler.ts instead
 * of settings.json (issue #1, 方案二 §四).
 *
 * WorkBuddy is intentionally NOT here: it reads Claude-format hooks from
 * ~/.workbuddy/settings.json (verified on 5.2.0), so it routes through the
 * settings-based injection path like codebuddy. The remaining claw variants
 * stay on the OpenClaw HOOK.md path pending real-device confirmation.
 */
const OPENCLAW_TOOLS = new Set(['openclaw', 'qclaw', 'easyclaw', 'autoclaw']);

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

type ToolFormat = 'claude' | 'cursor' | 'codex';
export type HookStatus = 'installed' | 'missing';

const CURSOR_TOOLS = new Set(['cursor']);
const CODEX_TOOLS = new Set(['codex', 'codex-internal', 'tcodex']);

function detectFormat(tool: string): ToolFormat {
  if (CODEX_TOOLS.has(tool)) return 'codex';
  return CURSOR_TOOLS.has(tool) ? 'cursor' : 'claude';
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
  return /"teamai\s/.test(command);
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
function manifestRecordsForTool(teamDefs: HookDef[], tool: string, removeAll: boolean): ManagedHookRecord[] {
  if (removeAll) return [];
  return teamDefsForTool(teamDefs, tool).map((d) => ({
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

async function reconcileClaudeFormat(
  settingsPath: string,
  tool: string,
  teamDefs: HookDef[],
  opts: ReconcileHooksOptions,
  teamActive: boolean,
): Promise<void> {
  // Built-in management never removes team hooks; team hooks are reconciled only
  // when a team pass is active (manifest present). This keeps the builtin-only
  // refresh path (injectHooks / autoMigrate) non-destructive to team hooks (§5).
  const isManaged = (e: HookMatcher): boolean =>
    isBuiltinClaudeEntry(e) || (teamActive && isTeamClaudeEntry(e));
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
  const priorTeamCommands = new Set((manifest?.[tool] ?? []).map((r) => r.command));

  const format = detectFormat(tool);
  if (format === 'cursor') {
    await reconcileCursorFormat(settingsPath, tool, teamDefs, opts, priorTeamCommands);
  } else if (format === 'codex') {
    await reconcileCodexFormat(settingsPath, tool, teamDefs, opts, priorTeamCommands);
  } else {
    await reconcileClaudeFormat(settingsPath, tool, teamDefs, opts, teamActive);
  }

  // Update the manifest's team-hook index for this tool (when manifest is active).
  if (opts.manifestPath && manifest) {
    const records = manifestRecordsForTool(teamDefs, tool, !!opts.removeAll);
    const prev = manifest[tool] ?? [];
    const sameAsPrev = JSON.stringify(prev) === JSON.stringify(records);
    const hadEntry = Object.prototype.hasOwnProperty.call(manifest, tool);
    if (records.length === 0) {
      if (hadEntry) {
        delete manifest[tool];
        await writeJson(expandHome(opts.manifestPath), manifest);
      }
    } else if (!sameAsPrev) {
      manifest[tool] = records;
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
 */
export async function getHookStatus(settingsPath: string, tool?: string): Promise<HookStatus> {
  const toolName = tool ?? 'claude';
  const expanded = expandHome(settingsPath);
  const defs = builtinHookDefs(toolName);

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
 * Inject teamai built-in hooks into all AI tool settings.
 * Only writes to tools whose root directory already exists on disk,
 * preventing creation of config dirs for tools the user hasn't installed.
 */
export async function injectHooksToAllTools(toolPaths: Record<string, { settings?: string }>, baseDir?: string): Promise<void> {
  const resolvedBaseDir = baseDir ?? (process.env.HOME ?? '');
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (paths.settings) {
      const toolRoot = path.join(resolvedBaseDir, paths.settings.split('/')[0]);
      if (!await pathExists(toolRoot)) continue;
      const settingsPath = path.join(resolvedBaseDir, paths.settings);
      try {
        await injectHooks(settingsPath, tool);
      } catch (e) {
        log.warn(`Failed to inject hook into ${tool}: ${(e as Error).message}`);
      }
    } else if (OPENCLAW_TOOLS.has(tool)) {
      const agentRoot = path.join(resolvedBaseDir, `.${tool}`);
      if (await pathExists(agentRoot)) {
        try {
          const { injectOpenClawHooks } = await import('./openclaw-hooks.js');
          await injectOpenClawHooks(path.join(agentRoot, 'hooks'), tool);
        } catch (e) {
          log.warn(`Failed to inject OpenClaw hook into ${tool}: ${(e as Error).message}`);
        }
      }
    }
  }
}

/**
 * Reconcile built-in (A) + team (B) hooks across every tool that has a settings
 * path, using a shared managed-hooks manifest. This is the authoritative
 * injection path used by `teamai pull` / `init` / `hooks inject`.
 */
export async function reconcileHooksToAllTools(
  toolPaths: Record<string, { settings?: string }>,
  baseDir: string,
  teamDefs: HookDef[],
  manifestPath: string,
  opts: { removeAll?: boolean; builtinOverride?: BuiltinHookOverride; force?: boolean } = {},
): Promise<void> {
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!paths.settings) continue;
    if (!opts.force) {
      const toolRoot = path.join(baseDir, paths.settings.split('/')[0]);
      if (!await pathExists(toolRoot)) continue;
    }
    const settingsPath = path.join(baseDir, paths.settings);
    try {
      await reconcileHooks(settingsPath, tool, teamDefs, {
        manifestPath,
        removeAll: opts.removeAll,
        builtinOverride: opts.builtinOverride,
      });
    } catch (e) {
      log.warn(`Failed to reconcile hooks for ${tool}: ${(e as Error).message}`);
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
  opts: { removeAll?: boolean; auto?: boolean; silent?: boolean } = {},
): Promise<HookDef[]> {
  const { defs: teamDefs, builtin } = opts.removeAll
    ? { defs: [] as HookDef[], builtin: undefined }
    : await resolveTeamHooks(teamConfig, localConfig.repo.localPath, { auto: opts.auto, silent: opts.silent });
  const baseDir = resolveBaseDir(localConfig);
  const manifestPath = getManagedHooksPath(localConfig.scope, localConfig.projectRoot);
  await reconcileHooksToAllTools(teamConfig.toolPaths, baseDir, teamDefs, manifestPath, {
    removeAll: opts.removeAll,
    builtinOverride: builtin,
  });
  return teamDefs;
}
