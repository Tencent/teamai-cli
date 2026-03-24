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
//  Event Type          Matcher   Command               Description keyword
//  ──────────────────  ────────  ────────────────────   ──────────────────
//  SessionStart        *         teamai pull            "Auto-pull"
//  Stop                *         teamai update          "Auto-update"
//  PostToolUse         Skill     teamai track --stdin   "Track skill"
//  UserPromptSubmit    *         teamai track-slash     "Track slash"
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

const CURSOR_SESSION_START_HOOK: CursorHookEntry = {
  command: TEAMAI_PULL_COMMAND,
  timeout: 30,
};

const CURSOR_STOP_HOOK: CursorHookEntry = {
  command: TEAMAI_UPDATE_COMMAND,
  timeout: 90,
};

const CURSOR_POST_TOOL_USE_HOOK: CursorHookEntry = {
  command: getTrackCommand('cursor'),
  timeout: 10,
  matcher: 'Read',
};

// ─── Tool format detection ──────────────────────────────────

type ToolFormat = 'claude' | 'cursor';

const CURSOR_TOOLS = new Set(['cursor']);

function detectFormat(tool: string): ToolFormat {
  return CURSOR_TOOLS.has(tool) ? 'cursor' : 'claude';
}

// ─── Claude Code hooks injection ────────────────────────────

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

  let changed = false;
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

  let changed = false;
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

async function injectCursorHooks(hooksPath: string): Promise<void> {
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

  let changed = false;

  // Helper: ensure a Cursor hook exists for a given event type
  const ensureCursorHook = (
    eventType: string,
    expected: CursorHookEntry,
    matchBy: (h: CursorHookEntry) => boolean,
  ): void => {
    if (!hooksJson.hooks[eventType]) {
      hooksJson.hooks[eventType] = [];
    }
    const idx = hooksJson.hooks[eventType].findIndex(matchBy);
    if (idx < 0) {
      hooksJson.hooks[eventType].push(expected);
      changed = true;
    } else {
      const cur = hooksJson.hooks[eventType][idx];
      if (cur.command !== expected.command || cur.matcher !== expected.matcher) {
        hooksJson.hooks[eventType][idx] = expected;
        changed = true;
      }
    }
  };

  ensureCursorHook('sessionStart', CURSOR_SESSION_START_HOOK, (h) => h.command.includes('teamai pull'));
  ensureCursorHook('stop', CURSOR_STOP_HOOK, (h) => h.command.includes('teamai update'));
  ensureCursorHook('postToolUse', CURSOR_POST_TOOL_USE_HOOK, (h) => h.command.includes('teamai track'));

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
    const filtered = entries.filter(
      (h) => !h.command.includes('teamai pull') && !h.command.includes('teamai update') && !h.command.includes('teamai track')
    );
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
    await injectCursorHooks(settingsPath);
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
