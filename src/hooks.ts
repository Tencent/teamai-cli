import path from 'node:path';
import { readJson, writeJson, expandHome, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';

const TEAMAI_PULL_COMMAND = 'bash -lc "teamai pull" 2>/dev/null || true';
const TEAMAI_UPDATE_COMMAND = 'bash -lc "teamai update" 2>/dev/null || true';

/** Generate the track command with tool identifier for correct usage attribution. */
function getTrackCommand(tool: string): string {
  return `bash -lc "teamai track --stdin --tool ${tool}" 2>>~/.teamai/debug.log || true`;
}

/** Generate the track-slash command with tool identifier. */
function getTrackSlashCommand(tool: string): string {
  return `bash -lc "teamai track-slash --stdin --tool ${tool}" 2>>~/.teamai/debug.log || true`;
}

/** Generate the dashboard-report command with tool identifier. */
function getDashboardReportCommand(tool: string): string {
  return `bash -lc "teamai dashboard-report --stdin --tool ${tool}" 2>>~/.teamai/debug.log || true`;
}

/** Generate the contribute-check command with tool identifier. */
function getContributeCheckCommand(tool: string): string {
  return `bash -lc "teamai contribute-check --stdin --tool ${tool}" 2>>~/.teamai/debug.log || true`;
}

/** Subcommands expected in each tool settings file (for `teamai doctor`). */
export const TEAMAI_HOOK_SUBCOMMANDS = ['pull', 'update', 'track', 'track-slash', 'dashboard-report', 'contribute-check'] as const;

/** Claude PascalCase event → Cursor camelCase event (for tests / docs). */
export const CLAUDE_TO_CURSOR_EVENTS: Record<string, string> = {
  SessionStart: 'sessionStart',
  Stop: 'stop',
  PostToolUse: 'postToolUse',
  UserPromptSubmit: 'userPromptSubmit',
};

// ─── Claude Code / Claude Internal format (settings.json) ───

interface HookEntry {
  type: string;
  command: string;
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

// ─── Claude hook definitions ────────────────────────────────
//
//  Hook injection matrix:
//
//  Event Type          Matcher   Command                                Description keyword
//  ──────────────────  ────────  ─────────────────────────────────────  ──────────────────
//  SessionStart        *         teamai pull                            "Auto-pull"
//  SessionStart        *         teamai dashboard-report --stdin        "Dashboard report"
//  Stop                *         teamai update                          "Auto-update"
//  Stop                *         teamai dashboard-report --stdin        "Dashboard stop"
//  PostToolUse         Skill     teamai track --stdin                   "Track skill"
//  PostToolUse         *         teamai dashboard-report --stdin        "Dashboard tool"
//  PostToolUse         *         teamai contribute-check --stdin        "Contribute check"
//  UserPromptSubmit    *         teamai track-slash                     "Track slash"
//  UserPromptSubmit    *         teamai dashboard-report --stdin        "Dashboard prompt"
//

/** Identifies a teamai hook by its description keyword (substring match). */
interface ClaudeHookDef {
  eventType: string;
  descriptionKeyword: string;
  hook: HookMatcher;
}

/** Build Claude hook definitions with the correct --tool identifier. */
function getClaudeHooks(tool: string): ClaudeHookDef[] {
  return [
    {
      eventType: 'SessionStart',
      descriptionKeyword: 'Auto-pull',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: TEAMAI_PULL_COMMAND }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Auto-pull team resources on session start`,
      },
    },
    {
      eventType: 'Stop',
      descriptionKeyword: 'Auto-update',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: TEAMAI_UPDATE_COMMAND }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Auto-update on session end`,
      },
    },
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Track skill',
      hook: {
        matcher: 'Skill',
        hooks: [{ type: 'command', command: getTrackCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Track skill usage`,
      },
    },
    {
      eventType: 'UserPromptSubmit',
      descriptionKeyword: 'Track slash',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getTrackSlashCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Track slash command usage`,
      },
    },
    // ─── Contribute check (smart threshold hint) ────────
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Contribute check',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getContributeCheckCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Contribute check on tool use`,
      },
    },
    // ─── Dashboard hooks (independent from tracking) ────────
    {
      eventType: 'SessionStart',
      descriptionKeyword: 'Dashboard report',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDashboardReportCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Dashboard report on session start`,
      },
    },
    {
      eventType: 'Stop',
      descriptionKeyword: 'Dashboard stop',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDashboardReportCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Dashboard report on session stop`,
      },
    },
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Dashboard tool',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDashboardReportCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Dashboard report on tool use`,
      },
    },
    {
      eventType: 'UserPromptSubmit',
      descriptionKeyword: 'Dashboard prompt',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDashboardReportCommand(tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Dashboard report on prompt submit`,
      },
    },
  ];
}

// ─── Cursor format (hooks.json) ─────────────────────────────

interface CursorHookEntry {
  command: string;
  timeout?: number;
  matcher?: string;
}

interface CursorHooksJson {
  version: number;
  hooks: Record<string, CursorHookEntry[]>;
}

/** Build Cursor hooks.json entries aligned with Claude semantics (camelCase events, Skill matcher). */
function buildCursorHooks(tool: string): Record<string, CursorHookEntry[]> {
  return {
    sessionStart: [
      { command: TEAMAI_PULL_COMMAND, timeout: 30 },
      { command: getDashboardReportCommand(tool), timeout: 10 },
    ],
    stop: [
      { command: TEAMAI_UPDATE_COMMAND, timeout: 90 },
      { command: getDashboardReportCommand(tool), timeout: 10 },
    ],
    postToolUse: [
      { command: getTrackCommand(tool), timeout: 10, matcher: 'Skill' },
      { command: getDashboardReportCommand(tool), timeout: 10 },
    ],
    userPromptSubmit: [
      { command: getTrackSlashCommand(tool), timeout: 10 },
      { command: getDashboardReportCommand(tool), timeout: 10 },
    ],
  };
}

// ─── Tool format detection ──────────────────────────────────

type ToolFormat = 'claude' | 'cursor';

const CURSOR_TOOLS = new Set(['cursor']);

function detectFormat(tool: string): ToolFormat {
  return CURSOR_TOOLS.has(tool) ? 'cursor' : 'claude';
}

function extractTeamaiSubcommand(command: string): string | null {
  const match = command.match(/teamai\s+([\w-]+)/);
  return match ? match[1] : null;
}

function isTeamaiHookCommand(command: string): boolean {
  return /"teamai\s/.test(command);
}

// ─── Claude Code hooks injection ────────────────────────────

/** Known teamai command substrings used to identify teamai-managed hooks. */
const TEAMAI_COMMAND_MARKERS = [
  'teamai pull', 'teamai update', 'teamai track', 'teamai dashboard', 'teamai contribute-check',
];

/**
 * Remove all teamai-managed hooks (identified by command content).
 *
 * This handles two cases:
 *   1. Legacy hooks injected without `description` — caused duplicates because
 *      `ensureClaudeHook` couldn't find them.
 *   2. Hooks with outdated `description` keywords (e.g. "Check for updates"
 *      renamed to "Auto-update") — `ensureClaudeHook` couldn't match them
 *      and appended a new entry.
 *
 * After cleanup, `ensureClaudeHook` re-injects fresh hooks with correct
 * descriptions and commands. Non-teamai hooks are preserved.
 *
 * Returns true if any entries were removed.
 */
function cleanupLegacyHooks(settings: ClaudeSettingsJson): boolean {
  if (!settings.hooks) return false;

  let changed = false;
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const filtered = matchers.filter((h) => {
      const cmd = h.hooks?.[0]?.command ?? '';
      const isTeamai = TEAMAI_COMMAND_MARKERS.some((marker) => cmd.includes(marker));
      return !isTeamai;
    });
    if (filtered.length !== matchers.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }

  return changed;
}

/**
 * Ensure a single teamai hook exists in the settings for the given event type.
 * If it already exists, update it if the command or matcher changed.
 * Returns true if any change was made.
 */
function ensureClaudeHook(
  settings: ClaudeSettingsJson,
  def: ClaudeHookDef,
): boolean {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks[def.eventType]) {
    settings.hooks[def.eventType] = [];
  }

  const matchers = settings.hooks[def.eventType];
  const existing = matchers.find(
    (h) =>
      h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX) &&
      h.description?.includes(def.descriptionKeyword),
  );

  if (!existing) {
    matchers.push(def.hook);
    return true;
  }

  // Check if update needed (command or matcher changed)
  const currentCmd = existing.hooks?.[0]?.command;
  const expectedCmd = def.hook.hooks[0].command;
  const currentMatcher = existing.matcher;
  const expectedMatcher = def.hook.matcher;

  if (currentCmd !== expectedCmd || currentMatcher !== expectedMatcher) {
    existing.hooks = def.hook.hooks;
    existing.matcher = def.hook.matcher;
    return true;
  }

  return false;
}

async function injectClaudeHooks(settingsPath: string, tool: string): Promise<void> {
  const expanded = expandHome(settingsPath);
  await ensureDir(path.dirname(expanded));
  const settings: ClaudeSettingsJson = (await readJson<ClaudeSettingsJson>(expanded)) ?? {};

  let changed = cleanupLegacyHooks(settings);
  for (const def of getClaudeHooks(tool)) {
    if (ensureClaudeHook(settings, def)) {
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, settings);
    log.success(`Updated teamai hooks in ${settingsPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${settingsPath}`);
  }
}

async function removeClaudeHooks(settingsPath: string): Promise<void> {
  const expanded = expandHome(settingsPath);
  const settings = await readJson<ClaudeSettingsJson>(expanded);
  if (!settings?.hooks) return;

  let changed = cleanupLegacyHooks(settings);
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const filtered = matchers.filter(
      (h) => !h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX)
    );
    if (filtered.length !== matchers.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, settings);
    log.success(`Removed teamai hooks from ${settingsPath}`);
  }
}

// ─── Cursor hooks injection ─────────────────────────────────

async function injectCursorHooks(hooksPath: string, tool: string): Promise<void> {
  const expanded = expandHome(hooksPath);
  await ensureDir(path.dirname(expanded));
  const hooksJson: CursorHooksJson = (await readJson<CursorHooksJson>(expanded)) ?? {
    version: 1,
    hooks: {},
  };

  if (!hooksJson.version) {
    hooksJson.version = 1;
  }
  if (!hooksJson.hooks) {
    hooksJson.hooks = {};
  }

  const desiredHooks = buildCursorHooks(tool);
  let changed = false;

  for (const [event, newEntries] of Object.entries(desiredHooks)) {
    if (!hooksJson.hooks[event]) {
      hooksJson.hooks[event] = [];
    }

    for (const newEntry of newEntries) {
      const newSubcmd = extractTeamaiSubcommand(newEntry.command);
      const existingIdx = hooksJson.hooks[event].findIndex(
        (h) => extractTeamaiSubcommand(h.command) === newSubcmd,
      );
      if (existingIdx >= 0) {
        const cur = hooksJson.hooks[event][existingIdx];
        if (JSON.stringify(cur) !== JSON.stringify(newEntry)) {
          hooksJson.hooks[event][existingIdx] = newEntry;
          changed = true;
        }
      } else {
        hooksJson.hooks[event].push(newEntry);
        changed = true;
      }
    }
  }

  if (changed) {
    await writeJson(expanded, hooksJson);
    log.success(`Updated teamai hooks in ${hooksPath}`);
  } else {
    log.debug(`teamai hooks already up-to-date in ${hooksPath}`);
  }
}

async function removeCursorHooks(hooksPath: string): Promise<void> {
  const expanded = expandHome(hooksPath);
  const hooksJson = await readJson<CursorHooksJson>(expanded);
  if (!hooksJson?.hooks) return;

  let changed = false;
  for (const [event, entries] of Object.entries(hooksJson.hooks)) {
    const filtered = entries.filter((h) => !isTeamaiHookCommand(h.command));
    if (filtered.length !== entries.length) {
      hooksJson.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(expanded, hooksJson);
    log.success(`Removed teamai hooks from ${hooksPath}`);
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Inject teamai hooks into a tool's settings/hooks file
 */
export async function injectHooks(settingsPath: string, tool?: string): Promise<void> {
  const toolName = tool ?? 'claude';
  const format = detectFormat(toolName);
  if (format === 'cursor') {
    await injectCursorHooks(settingsPath, toolName);
  } else {
    await injectClaudeHooks(settingsPath, toolName);
  }
}

/**
 * Remove teamai hooks from a tool's settings/hooks file
 */
export async function removeHooks(settingsPath: string, tool?: string): Promise<void> {
  const format = detectFormat(tool ?? '');
  if (format === 'cursor') {
    await removeCursorHooks(settingsPath);
  } else {
    await removeClaudeHooks(settingsPath);
  }
}

/**
 * Inject teamai hooks into all AI tool settings
 */
export async function injectHooksToAllTools(toolPaths: Record<string, { settings?: string }>): Promise<void> {
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (paths.settings) {
      const settingsPath = path.join(process.env.HOME ?? '', paths.settings);
      try {
        await injectHooks(settingsPath, tool);
      } catch (e) {
        log.warn(`Failed to inject hook into ${tool}: ${(e as Error).message}`);
      }
    }
  }
}
