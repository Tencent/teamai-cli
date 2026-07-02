/**
 * Hook Handler Registry — maps event+matcher to concrete handler implementations.
 *
 * Each handler wraps an existing teamai subcommand function but accepts pre-parsed
 * STDIN data instead of reading from process.stdin directly. This enables the
 * dispatcher to read STDIN once and fan out to all handlers.
 *
 * Existing standalone subcommands (`teamai pull`, `teamai track --stdin`, etc.)
 * remain unchanged for backward compatibility during migration.
 */

import type { HookHandler } from './hook-dispatch.js';
import { deriveSessionId } from './utils/session-id.js';
import { normalizeToolName } from './utils/tool-names.js';

// ─── Public types ───────────────────────────────────────

export interface HandlerRegistration {
  event: string;
  matcher: string;
  handler: HookHandler;
  timeoutMs: number;
}

// ─── Timeout constants ──────────────────────────────────

/** Pull involves git network ops — generous timeout. */
const PULL_TIMEOUT_MS = 60_000;
/** Update checks npm registry — cap at 10s to avoid blocking session shutdown. */
const UPDATE_TIMEOUT_MS = 10_000;
/** Track/track-slash is a local file append — very fast. */
const TRACK_TIMEOUT_MS = 5_000;
/** Dashboard-report is a local file append — very fast. */
const DASHBOARD_TIMEOUT_MS = 5_000;
/** Contribute-check reads local state + events.jsonl — generally fast. */
const CONTRIBUTE_CHECK_TIMEOUT_MS = 10_000;
/** TodoWrite hint is a local dedup-cache check — very fast. */
const TODOWRITE_HINT_TIMEOUT_MS = 5_000;
/** MR-hint queries a remote MR/PR API — allow a network round-trip. */
const MR_HINT_TIMEOUT_MS = 10_000;
/** Status reporter does report/sync/ack + skill commands — allow network + download. */
const STATUS_REPORT_TIMEOUT_MS = 30_000;

// ─── Handler implementations ────────────────────────────
//
// Each handler is a thin adapter that:
//   1. Receives pre-parsed STDIN (Record<string, unknown>)
//   2. Delegates to the actual subcommand logic
//   3. Returns output string or null
//
// IMPORTANT: These use dynamic imports to keep module loading lazy.
// The dispatcher only loads the modules that actually need to run.

const pullHandler: HookHandler = {
  name: 'pull',
  async execute(_stdin, _tool) {
    const { pull } = await import('./pull.js');
    await pull({ silent: true });
    return null;
  },
};

const updateHandler: HookHandler = {
  name: 'update',
  async execute(_stdin, _tool) {
    const { doUpdate } = await import('./update.js');
    await doUpdate();
    return null;
  },
};

const dashboardReportHandler: HookHandler = {
  name: 'dashboard-report',
  async execute(stdin, tool) {
    const { parseHookEvent, appendEvent, compactEvents } = await import('./dashboard-collector.js');
    const raw = JSON.stringify(stdin);
    const event = await parseHookEvent(raw, tool);
    if (event) {
      await appendEvent(event);
      // Non-blocking compaction
      compactEvents().catch(() => {});
    }
    return null;
  },
};

const trackHandler: HookHandler = {
  name: 'track',
  async execute(stdin, tool) {
    const { extractSkillName, isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

    const rawToolName = stdin.tool_name;
    if (typeof rawToolName !== 'string') return null;
    const toolName = normalizeToolName(rawToolName);

    const toolInput = stdin.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return null;

    // Only track Skill (Claude/CodeBuddy) or Read+SKILL.md (Cursor)
    let skillName: string | null = null;
    let toolSource = tool;

    if (toolName === 'Skill') {
      skillName = extractSkillName(toolInput as Record<string, unknown>);
    } else if (toolName === 'Read') {
      const input = toolInput as Record<string, unknown>;
      const filePath =
        (typeof input.file_path === 'string' ? input.file_path : null) ??
        (typeof input.filePath === 'string' ? input.filePath : null) ??
        (typeof input.path === 'string' ? input.path : null);
      if (typeof filePath === 'string' && /\/SKILL\.md$/i.test(filePath)) {
        skillName = extractSkillName({ skill: filePath });
        toolSource = 'cursor';
      }
    } else {
      return null;
    }

    if (!skillName || !isValidSkillName(skillName)) return null;

    await appendUsageEvent({ skill: skillName, timestamp: new Date().toISOString(), tool: toolSource });
    await updateKnownSkills(skillName);
    return null;
  },
};

const trackSlashHandler: HookHandler = {
  name: 'track-slash',
  async execute(stdin, tool) {
    const { extractSkillName, isValidSkillName, appendUsageEvent, updateKnownSkills } = await import('./usage-tracker.js');

    const prompt = stdin.prompt;
    if (typeof prompt !== 'string' || !prompt.startsWith('/')) return null;

    // Extract skill name: first word after "/"
    const match = prompt.match(/^\/([\w-]+)/);
    if (!match) return null;

    const skillName = match[1];
    if (!isValidSkillName(skillName)) return null;

    await appendUsageEvent({ skill: skillName, timestamp: new Date().toISOString(), tool });
    await updateKnownSkills(skillName);
    return null;
  },
};

const contributeCheckHandler: HookHandler = {
  name: 'contribute-check',
  async execute(stdin, tool) {
    const { contributeCheckForSession } = await import('./contribute-check.js');
    const { formatStopHookOutput } = await import('./utils/hook-output.js');

    const sessionId = typeof stdin.session_id === 'string' ? stdin.session_id : null;
    if (!sessionId) return null;

    const cwd = typeof stdin.cwd === 'string' ? stdin.cwd : undefined;
    const { hint } = await contributeCheckForSession(sessionId, cwd);
    if (hint) {
      return formatStopHookOutput(hint, tool);
    }
    return null;
  },
};

const todowriteHintHandler: HookHandler = {
  name: 'todowrite-hint',
  async execute(stdin, _tool) {
    if (process.env.TEAMAI_RECALL_DISABLED === '1') return null;

    const toolName = normalizeToolName(typeof stdin.tool_name === 'string' ? stdin.tool_name : '');
    if (toolName !== 'TodoWrite') return null;

    const { shouldSkipTodoWriteHint, buildHintMessage } = await import('./todowrite-hint.js');

    if (shouldSkipTodoWriteHint(deriveSessionId(stdin))) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildHintMessage(),
      },
    });
  },
};

const mrHintHandler: HookHandler = {
  name: 'mr-hint',
  async execute(_stdin, _tool) {
    const { computeMrHintOutput } = await import('./mr-hint.js');
    return computeMrHintOutput();
  },
};

/** SessionStart: report + sync (→ commands → ack). Never blocks the agent. */
const statusReportSessionHandler: HookHandler = {
  name: 'status-report-session',
  async execute(stdin, tool) {
    const { runStatusReport } = await import('./status-report.js');
    await runStatusReport({ stdin, tool, phase: 'session' });
    return null;
  },
};

/** UserPromptSubmit: sync only (→ commands → ack). */
const statusReportMessageHandler: HookHandler = {
  name: 'status-report-message',
  async execute(stdin, tool) {
    const { runStatusReport } = await import('./status-report.js');
    await runStatusReport({ stdin, tool, phase: 'message' });
    return null;
  },
};

// ─── Registry builder ───────────────────────────────────

/**
 * Build the complete handler registry for the hook dispatcher.
 * Returns all handler registrations with their event, matcher, timeout, and implementation.
 */
export function buildHandlerRegistry(): HandlerRegistration[] {
  return [
    // ─── SessionStart ─────────────────────────────────
    { event: 'session-start', matcher: '*', handler: pullHandler, timeoutMs: PULL_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: dashboardReportHandler, timeoutMs: DASHBOARD_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: mrHintHandler, timeoutMs: MR_HINT_TIMEOUT_MS },
    { event: 'session-start', matcher: '*', handler: statusReportSessionHandler, timeoutMs: STATUS_REPORT_TIMEOUT_MS },

    // ─── Stop ─────────────────────────────────────────
    { event: 'stop', matcher: '*', handler: updateHandler, timeoutMs: UPDATE_TIMEOUT_MS },
    { event: 'stop', matcher: '*', handler: contributeCheckHandler, timeoutMs: CONTRIBUTE_CHECK_TIMEOUT_MS },
    { event: 'stop', matcher: '*', handler: dashboardReportHandler, timeoutMs: DASHBOARD_TIMEOUT_MS },

    // ─── PostToolUse ──────────────────────────────────
    { event: 'post-tool-use', matcher: '*', handler: dashboardReportHandler, timeoutMs: DASHBOARD_TIMEOUT_MS },
    { event: 'post-tool-use', matcher: 'Skill', handler: trackHandler, timeoutMs: TRACK_TIMEOUT_MS },
    { event: 'post-tool-use', matcher: 'TodoWrite', handler: todowriteHintHandler, timeoutMs: TODOWRITE_HINT_TIMEOUT_MS },

    // ─── UserPromptSubmit ─────────────────────────────
    { event: 'prompt-submit', matcher: '*', handler: trackSlashHandler, timeoutMs: TRACK_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: dashboardReportHandler, timeoutMs: DASHBOARD_TIMEOUT_MS },
    { event: 'prompt-submit', matcher: '*', handler: statusReportMessageHandler, timeoutMs: STATUS_REPORT_TIMEOUT_MS },
  ];
}
