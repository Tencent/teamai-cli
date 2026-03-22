import path from 'node:path';
import { readJson, writeJson, expandHome, ensureDir } from './utils/fs.js';
import { log } from './utils/logger.js';
import { TEAMAI_HOOK_DESCRIPTION_PREFIX } from './types.js';

const TEAMAI_PULL_COMMAND = 'bash -lc "teamai pull" 2>/dev/null || true';
const TEAMAI_UPDATE_COMMAND = 'bash -lc "teamai update" 2>/dev/null || true';
const TEAMAI_TRACK_COMMAND = 'bash -lc "teamai track --stdin" 2>>~/.teamai/debug.log || true';
/** Legacy command pattern for detecting old hook installations that need upgrading. */
const TEAMAI_TRACK_COMMAND_LEGACY = 'teamai track "$CLAUDE_TOOL_NAME"';

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

const CLAUDE_SESSION_START_HOOK: HookMatcher = {
  matcher: '*',
  hooks: [{ type: 'command', command: TEAMAI_PULL_COMMAND }],
  description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Auto-pull team resources on session start`,
};

const CLAUDE_STOP_HOOK: HookMatcher = {
  matcher: '*',
  hooks: [{ type: 'command', command: TEAMAI_UPDATE_COMMAND }],
  description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Auto-update on session end`,
};

const CLAUDE_POST_TOOL_USE_HOOK: HookMatcher = {
  matcher: 'Skill',
  hooks: [{ type: 'command', command: TEAMAI_TRACK_COMMAND }],
  description: `${TEAMAI_HOOK_DESCRIPTION_PREFIX} Track skill usage`,
};

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
  command: TEAMAI_TRACK_COMMAND,
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

async function injectClaudeHooks(settingsPath: string): Promise<void> {
  const expanded = expandHome(settingsPath);
  await ensureDir(path.dirname(expanded));
  const settings: ClaudeSettingsJson = (await readJson<ClaudeSettingsJson>(expanded)) ?? {};

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  const existing = settings.hooks.SessionStart.find(
    (h) => h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX)
  );
  if (existing) {
    // Update command if it changed (e.g. --silent removed)
    const currentCmd = existing.hooks?.[0]?.command;
    if (currentCmd !== TEAMAI_PULL_COMMAND) {
      existing.hooks = CLAUDE_SESSION_START_HOOK.hooks;
    }

    // Ensure Stop hook for update check exists
    if (!settings.hooks.Stop) {
      settings.hooks.Stop = [];
    }
    const existingStop = settings.hooks.Stop.find(
      (h) => h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX) && h.hooks?.[0]?.command?.includes('teamai update')
    );
    if (!existingStop) {
      settings.hooks.Stop.push(CLAUDE_STOP_HOOK);
      await writeJson(expanded, settings);
      log.success(`Injected teamai update hook into ${settingsPath}`);
    } else {
      const currentStopCmd = existingStop.hooks?.[0]?.command;
      if (currentStopCmd !== TEAMAI_UPDATE_COMMAND) {
        existingStop.hooks = CLAUDE_STOP_HOOK.hooks;
        await writeJson(expanded, settings);
        log.success(`Updated teamai update hook in ${settingsPath}`);
      } else if (currentCmd !== TEAMAI_PULL_COMMAND) {
        await writeJson(expanded, settings);
        log.success(`Updated teamai hook in ${settingsPath}`);
      } else {
        log.debug(`teamai hooks already exist in ${settingsPath}`);
      }
    }

    // Ensure PostToolUse hook for skill usage tracking exists
    if (!settings.hooks.PostToolUse) {
      settings.hooks.PostToolUse = [];
    }
    const existingTrackInner = settings.hooks.PostToolUse.find(
      (h) => h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX) && h.description?.includes('Track skill')
    );
    if (!existingTrackInner) {
      settings.hooks.PostToolUse.push(CLAUDE_POST_TOOL_USE_HOOK);
      await writeJson(expanded, settings);
      log.success(`Injected teamai track hook into ${settingsPath}`);
    } else {
      const currentTrackCmd = existingTrackInner.hooks?.[0]?.command;
      if (currentTrackCmd !== TEAMAI_TRACK_COMMAND) {
        existingTrackInner.hooks = CLAUDE_POST_TOOL_USE_HOOK.hooks;
        existingTrackInner.matcher = CLAUDE_POST_TOOL_USE_HOOK.matcher;
        await writeJson(expanded, settings);
        log.success(`Updated teamai track hook in ${settingsPath}`);
      }
    }

    return;
  }

  settings.hooks.SessionStart.push(CLAUDE_SESSION_START_HOOK);

  // Inject Stop hook for update check
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }
  const existingStop = settings.hooks.Stop.find(
    (h) => h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX) && h.hooks?.[0]?.command?.includes('teamai update')
  );
  if (!existingStop) {
    settings.hooks.Stop.push(CLAUDE_STOP_HOOK);
  } else {
    const currentStopCmd = existingStop.hooks?.[0]?.command;
    if (currentStopCmd !== TEAMAI_UPDATE_COMMAND) {
      existingStop.hooks = CLAUDE_STOP_HOOK.hooks;
    }
  }

  // Inject PostToolUse hook for skill usage tracking
  if (!settings.hooks.PostToolUse) {
    settings.hooks.PostToolUse = [];
  }
  const existingTrack = settings.hooks.PostToolUse.find(
    (h) => h.description?.startsWith(TEAMAI_HOOK_DESCRIPTION_PREFIX) && h.description?.includes('Track skill')
  );
  if (!existingTrack) {
    settings.hooks.PostToolUse.push(CLAUDE_POST_TOOL_USE_HOOK);
  } else {
    const currentTrackCmd = existingTrack.hooks?.[0]?.command;
    if (currentTrackCmd !== TEAMAI_TRACK_COMMAND) {
      existingTrack.hooks = CLAUDE_POST_TOOL_USE_HOOK.hooks;
      existingTrack.matcher = CLAUDE_POST_TOOL_USE_HOOK.matcher;
    }
  }

  await writeJson(expanded, settings);
  log.success(`Injected teamai hook into ${settingsPath}`);
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
  if (!hooksJson.hooks.sessionStart) {
    hooksJson.hooks.sessionStart = [];
  }

  // Check if teamai hook already exists (match by command prefix)
  const existingIdx = hooksJson.hooks.sessionStart.findIndex(
    (h) => h.command.includes('teamai pull')
  );
  if (existingIdx >= 0) {
    const existing = hooksJson.hooks.sessionStart[existingIdx];
    if (existing.command !== TEAMAI_PULL_COMMAND) {
      hooksJson.hooks.sessionStart[existingIdx] = CURSOR_SESSION_START_HOOK;
    }

    // Ensure stop hook for update check exists
    if (!hooksJson.hooks.stop) {
      hooksJson.hooks.stop = [];
    }
    const existingStopIdx = hooksJson.hooks.stop.findIndex(
      (h) => h.command.includes('teamai update')
    );
    if (existingStopIdx < 0) {
      hooksJson.hooks.stop.push(CURSOR_STOP_HOOK);
      await writeJson(expanded, hooksJson);
      log.success(`Injected teamai update hook into ${hooksPath}`);
    } else if (hooksJson.hooks.stop[existingStopIdx].command !== TEAMAI_UPDATE_COMMAND) {
      hooksJson.hooks.stop[existingStopIdx] = CURSOR_STOP_HOOK;
      await writeJson(expanded, hooksJson);
      log.success(`Updated teamai update hook in ${hooksPath}`);
    } else if (existing.command !== TEAMAI_PULL_COMMAND) {
      await writeJson(expanded, hooksJson);
      log.success(`Updated teamai hook in ${hooksPath}`);
    } else {
      log.debug(`teamai hooks already exist in ${hooksPath}`);
    }

    // Ensure postToolUse hook for skill usage tracking exists
    if (!hooksJson.hooks.postToolUse) {
      hooksJson.hooks.postToolUse = [];
    }
    const existingTrackIdx = hooksJson.hooks.postToolUse.findIndex(
      (h) => h.command.includes('teamai track')
    );
    if (existingTrackIdx < 0) {
      hooksJson.hooks.postToolUse.push(CURSOR_POST_TOOL_USE_HOOK);
      await writeJson(expanded, hooksJson);
      log.success(`Injected teamai track hook into ${hooksPath}`);
    } else if (
      hooksJson.hooks.postToolUse[existingTrackIdx].command !== TEAMAI_TRACK_COMMAND ||
      hooksJson.hooks.postToolUse[existingTrackIdx].matcher !== CURSOR_POST_TOOL_USE_HOOK.matcher
    ) {
      hooksJson.hooks.postToolUse[existingTrackIdx] = CURSOR_POST_TOOL_USE_HOOK;
      await writeJson(expanded, hooksJson);
      log.success(`Updated teamai track hook in ${hooksPath}`);
    }

    return;
  }

  hooksJson.hooks.sessionStart.push(CURSOR_SESSION_START_HOOK);

  // Inject stop hook for update check
  if (!hooksJson.hooks.stop) {
    hooksJson.hooks.stop = [];
  }
  const existingStopIdx = hooksJson.hooks.stop.findIndex(
    (h) => h.command.includes('teamai update')
  );
  if (existingStopIdx < 0) {
    hooksJson.hooks.stop.push(CURSOR_STOP_HOOK);
  } else if (hooksJson.hooks.stop[existingStopIdx].command !== TEAMAI_UPDATE_COMMAND) {
    hooksJson.hooks.stop[existingStopIdx] = CURSOR_STOP_HOOK;
  }

  // Inject postToolUse hook for skill usage tracking
  if (!hooksJson.hooks.postToolUse) {
    hooksJson.hooks.postToolUse = [];
  }
  const existingTrackIdx = hooksJson.hooks.postToolUse.findIndex(
    (h) => h.command.includes('teamai track')
  );
  if (existingTrackIdx < 0) {
    hooksJson.hooks.postToolUse.push(CURSOR_POST_TOOL_USE_HOOK);
  } else if (
    hooksJson.hooks.postToolUse[existingTrackIdx].command !== TEAMAI_TRACK_COMMAND ||
    hooksJson.hooks.postToolUse[existingTrackIdx].matcher !== CURSOR_POST_TOOL_USE_HOOK.matcher
  ) {
    hooksJson.hooks.postToolUse[existingTrackIdx] = CURSOR_POST_TOOL_USE_HOOK;
  }

  await writeJson(expanded, hooksJson);
  log.success(`Injected teamai hook into ${hooksPath}`);
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
  const format = detectFormat(tool ?? '');
  if (format === 'cursor') {
    await injectCursorHooks(settingsPath);
  } else {
    await injectClaudeHooks(settingsPath);
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
