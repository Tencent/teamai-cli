import path from 'node:path';
import { readJson, writeJson, expandHome, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';

/** Generate the hook-dispatch command for a given event, tool, and optional matcher. */
function getDispatchCommand(event: string, tool: string, matcher?: string): string {
  const matcherArg = matcher && matcher !== '*' ? ` --matcher ${matcher}` : '';
  return `bash -lc "teamai hook-dispatch ${event} --tool ${tool}${matcherArg} 2>/dev/null" || true`;
}

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

// ─── Claude Code / Claude Internal format (settings.json) ───

interface HookEntry {
  type: string;
  command: string;
  /** Per-hook timeout in seconds. Falls back to Claude Code's default (60s) if omitted. */
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

// ─── Claude hook definitions ────────────────────────────────
//
//  Hook injection matrix:
//
//  Event Type          Matcher      Command                                Description keyword
//  ──────────────────  ───────────  ─────────────────────────────────────  ──────────────────
//  SessionStart        *            teamai pull                            "Auto-pull"
//  SessionStart        *            teamai dashboard-report --stdin        "Dashboard report"
//  Stop                *            teamai update                          "Auto-update"
//  Stop                *            teamai dashboard-report --stdin        "Dashboard stop"
//  Stop                *            teamai contribute-check --stdin        "Contribute check"
//  PostToolUse         Skill        teamai track --stdin                   "Track skill"
//  PostToolUse         *            teamai dashboard-report --stdin        "Dashboard tool"
//  PostToolUse         Bash         teamai auto-recall --stdin             "Auto-recall Bash"
//  PostToolUse         Grep         teamai auto-recall --stdin             "Auto-recall Grep"
//  PostToolUse         WebSearch    teamai auto-recall --stdin             "Auto-recall WebSearch"
//  PostToolUse         WebFetch     teamai auto-recall --stdin             "Auto-recall WebFetch"
//  UserPromptSubmit    *            teamai track-slash                     "Track slash"
//  UserPromptSubmit    *            teamai dashboard-report --stdin        "Dashboard prompt"
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
    // ─── SessionStart: single dispatcher handles pull + dashboard-report ────
    {
      eventType: 'SessionStart',
      descriptionKeyword: 'Hook dispatch session-start',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDispatchCommand('session-start', tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch session-start`,
      },
    },
    // ─── Stop: single dispatcher handles update + contribute-check + dashboard-report ────
    {
      eventType: 'Stop',
      descriptionKeyword: 'Hook dispatch stop',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDispatchCommand('stop', tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch stop`,
      },
    },
    // ─── PostToolUse (*): dashboard-report ────
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Hook dispatch post-tool-use wildcard',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDispatchCommand('post-tool-use', tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch post-tool-use wildcard`,
      },
    },
    // ─── PostToolUse (Skill): track ────
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Hook dispatch post-tool-use Skill',
      hook: {
        matcher: 'Skill',
        hooks: [{ type: 'command', command: getDispatchCommand('post-tool-use', tool, 'Skill') }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch post-tool-use Skill`,
      },
    },
    // ─── PostToolUse (Bash/Grep/WebSearch/WebFetch): auto-recall ────
    ...(['Bash', 'Grep', 'WebSearch', 'WebFetch'] as const).map((matcher) => ({
      eventType: 'PostToolUse' as const,
      descriptionKeyword: `Hook dispatch post-tool-use ${matcher}`,
      hook: {
        matcher,
        hooks: [{ type: 'command', command: getDispatchCommand('post-tool-use', tool, matcher) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch post-tool-use ${matcher}`,
      },
    })),
    // ─── PostToolUse (TodoWrite): todowrite-hint ────
    {
      eventType: 'PostToolUse',
      descriptionKeyword: 'Hook dispatch post-tool-use TodoWrite',
      hook: {
        matcher: 'TodoWrite',
        hooks: [{ type: 'command', command: getDispatchCommand('post-tool-use', tool, 'TodoWrite') }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch post-tool-use TodoWrite`,
      },
    },
    // ─── UserPromptSubmit: track-slash + dashboard-report ────
    {
      eventType: 'UserPromptSubmit',
      descriptionKeyword: 'Hook dispatch prompt-submit',
      hook: {
        matcher: '*',
        hooks: [{ type: 'command', command: getDispatchCommand('prompt-submit', tool) }],
        description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Hook dispatch prompt-submit`,
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
      { command: getDispatchCommand('session-start', tool), timeout: 60 },
    ],
    stop: [
      { command: getDispatchCommand('stop', tool), timeout: 15 },
    ],
    postToolUse: [
      { command: getDispatchCommand('post-tool-use', tool), timeout: 10 },
      { command: getDispatchCommand('post-tool-use', tool, 'Skill'), timeout: 10, matcher: 'Skill' },
      ...(['Bash', 'Grep', 'WebSearch', 'WebFetch'] as const).map((matcher) => ({
        command: getDispatchCommand('post-tool-use', tool, matcher),
        timeout: 10,
        matcher,
      })),
      { command: getDispatchCommand('post-tool-use', tool, 'TodoWrite'), timeout: 3, matcher: 'TodoWrite' },
    ],
    beforeSubmitPrompt: [
      { command: getDispatchCommand('prompt-submit', tool), timeout: 10 },
    ],
  };
}

// ─── CodeBuddy format ───────────────────────────────────────
//
//  CodeBuddy uses the same settings.json structure AND PascalCase event
//  keys as Claude Code (SessionStart, Stop, PostToolUse, UserPromptSubmit).
//  Its HookExecutor internally looks up hooks by PascalCase key.
//
//  The only difference is that the hook_event_name field in STDIN JSON
//  uses camelCase names (sessionStart, stop, postToolUse, beforeSubmitPrompt).
//  This is handled in dashboard-collector.ts mapEventType(), not here.
//
//  Therefore CodeBuddy shares the same injection logic as Claude.

// ─── Tool format detection ──────────────────────────────────

type ToolFormat = 'claude' | 'cursor';
export type HookStatus = 'installed' | 'missing';

const CURSOR_TOOLS = new Set(['cursor']);

function detectFormat(tool: string): ToolFormat {
  if (CURSOR_TOOLS.has(tool)) return 'cursor';
  return 'claude';
}

function hasExpectedClaudeHook(settings: ClaudeSettingsJson, def: ClaudeHookDef): boolean {
  const matchers = settings.hooks?.[def.eventType] ?? [];
  const expectedCmd = def.hook.hooks[0].command;
  const expectedMatcher = def.hook.matcher;

  return matchers.some((h) =>
    h.matcher === expectedMatcher &&
    h.hooks?.some((hook) => hook.command === expectedCmd),
  );
}

function hasExpectedCursorHook(entries: CursorHookEntry[], expected: CursorHookEntry): boolean {
  return entries.some((entry) =>
    entry.command === expected.command &&
    entry.matcher === expected.matcher,
  );
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
  'teamai pull', 'teamai update', 'teamai track', 'teamai dashboard', 'teamai contribute-check', 'teamai auto-recall', 'teamai todowrite-hint', 'teamai mr-hint', 'teamai hook-dispatch',
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

  // Clean up empty camelCase keys left from previous incorrect camelCase injection
  if (settings.hooks) {
    const camelCaseKeys = ['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt', 'userPromptSubmit'];
    for (const key of camelCaseKeys) {
      if (settings.hooks[key] && settings.hooks[key].length === 0) {
        delete settings.hooks[key];
        changed = true;
      }
    }
  }

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

  // Clean up legacy individual teamai hooks (pull, track, dashboard-report, etc.)
  // that are being replaced by unified hook-dispatch entries.
  for (const event of Object.keys(hooksJson.hooks)) {
    const entries = hooksJson.hooks[event];
    const filtered = entries.filter((h) => {
      if (!isTeamaiHookCommand(h.command)) return true;
      // Keep hook-dispatch entries, remove all legacy individual subcommand entries
      const subcmd = extractTeamaiSubcommand(h.command);
      return subcmd === 'hook-dispatch';
    });
    if (filtered.length !== entries.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooksJson.hooks[event];
      } else {
        hooksJson.hooks[event] = filtered;
      }
    }
  }

  // Clean up stale event keys no longer in the desired set (e.g. userPromptSubmit → beforeSubmitPrompt rename)
  const desiredEvents = new Set(Object.keys(desiredHooks));
  for (const event of Object.keys(hooksJson.hooks)) {
    if (desiredEvents.has(event)) continue;
    const entries = hooksJson.hooks[event];
    const filtered = entries.filter((h) => !isTeamaiHookCommand(h.command));
    if (filtered.length !== entries.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooksJson.hooks[event];
      } else {
        hooksJson.hooks[event] = filtered;
      }
    }
  }

  for (const [event, newEntries] of Object.entries(desiredHooks)) {
    if (!hooksJson.hooks[event]) {
      hooksJson.hooks[event] = [];
    }

    for (const newEntry of newEntries) {
      const newSubcmd = extractTeamaiSubcommand(newEntry.command);
      const newMatcher = (newEntry as { matcher?: string }).matcher;
      const existingIdx = hooksJson.hooks[event].findIndex(
        (h) => {
          const hMatcher = (h as { matcher?: string }).matcher;
          return extractTeamaiSubcommand(h.command) === newSubcmd
            && hMatcher === newMatcher;
        },
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
    // Both claude and codebuddy use PascalCase event keys in settings.json
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
    // Both claude and codebuddy use the same settings.json structure for removal
    await removeClaudeHooks(settingsPath);
  }
}

/**
 * Report whether the current teamai hook set is present in a tool settings file.
 */
export async function getHookStatus(settingsPath: string, tool?: string): Promise<HookStatus> {
  const toolName = tool ?? 'claude';
  const format = detectFormat(toolName);
  const expanded = expandHome(settingsPath);

  if (format === 'cursor') {
    const hooksJson = await readJson<CursorHooksJson>(expanded);
    if (!hooksJson?.hooks) return 'missing';

    const desiredHooks = buildCursorHooks(toolName);
    const installed = Object.entries(desiredHooks).every(([event, expectedEntries]) => {
      const entries = hooksJson.hooks[event] ?? [];
      return expectedEntries.every((expected) => hasExpectedCursorHook(entries, expected));
    });

    return installed ? 'installed' : 'missing';
  }

  const settings = await readJson<ClaudeSettingsJson>(expanded);
  if (!settings?.hooks) return 'missing';

  const installed = getClaudeHooks(toolName).every((def) =>
    hasExpectedClaudeHook(settings, def),
  );

  return installed ? 'installed' : 'missing';
}

/**
 * Inject teamai hooks into all AI tool settings
 */
export async function injectHooksToAllTools(toolPaths: Record<string, { settings?: string }>, baseDir?: string): Promise<void> {
  const resolvedBaseDir = baseDir ?? (process.env.HOME ?? '');
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (paths.settings) {
      const settingsPath = path.join(resolvedBaseDir, paths.settings);
      try {
        await injectHooks(settingsPath, tool);
      } catch (e) {
        log.warn(`Failed to inject hook into ${tool}: ${(e as Error).message}`);
      }
    }
  }
}
