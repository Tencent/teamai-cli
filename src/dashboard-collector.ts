import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { ensureDir } from './utils/fs.js';
import {
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENTS_DIR,
  DASHBOARD_COMPACTION_THRESHOLD,
  DASHBOARD_IDLE_TIMEOUT_MS,
  DASHBOARD_STALE_TIMEOUT_MS,
  type DashboardEvent,
  type DashboardEventType,
  type DashboardSession,
  type DashboardSessionStatus,
} from './types.js';

// ─── Event collection data flow ─────────────────────────
//
//  Hook STDIN JSON (varies by event type)
//      │
//      ▼
//  parseHookEvent(raw, tool)
//      │ extract: session_id / cwd / tool_name / prompt
//      ▼
//  DashboardEvent
//      │
//      ▼
//  appendEvent(event) → events.jsonl
//

// ─── STDIN parsing ──────────────────────────────────────

/** Read STDIN fully. Returns empty string if STDIN is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Derive session ID from hook data.
 * Priority: session_id field > CLAUDE_SESSION_ID env > PID+cwd composite.
 */
function deriveSessionId(hookData: Record<string, unknown>): string {
  // 1. Explicit session_id from hook STDIN
  if (typeof hookData.session_id === 'string' && hookData.session_id) {
    return hookData.session_id;
  }
  // 2. Environment variable (Claude Code sets this)
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }
  // 3. Fallback: PID + cwd composite
  const cwd = typeof hookData.cwd === 'string' ? hookData.cwd : process.cwd();
  const ppid = process.ppid ?? process.pid;
  return `pid-${ppid}-${cwd}`;
}

/**
 * Map Claude Code hook event names to dashboard event types.
 */
function mapEventType(hookEventName: string): DashboardEventType | null {
  switch (hookEventName) {
    case 'SessionStart':
      return 'session_start';
    case 'PostToolUse':
      return 'tool_use';
    case 'UserPromptSubmit':
      return 'prompt_submit';
    case 'Stop':
      return 'stop';
    default:
      return null;
  }
}

/**
 * Parse a hook STDIN JSON payload into a DashboardEvent.
 * Returns null if the payload is invalid or irrelevant.
 */
export function parseHookEvent(
  raw: string,
  tool: string,
): DashboardEvent | null {
  if (!raw.trim()) return null;

  let hookData: Record<string, unknown>;
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('dashboard-collector: failed to parse STDIN JSON');
    return null;
  }

  // Determine event type from hook_event_name field
  const hookEventName = typeof hookData.hook_event_name === 'string'
    ? hookData.hook_event_name
    : '';
  const eventType = mapEventType(hookEventName);
  if (!eventType) {
    log.debug(`dashboard-collector: unknown hook event: ${hookEventName}`);
    return null;
  }

  const sessionId = deriveSessionId(hookData);
  const cwd = typeof hookData.cwd === 'string' ? hookData.cwd : undefined;

  const event: DashboardEvent = {
    type: eventType,
    timestamp: new Date().toISOString(),
    sessionId,
    tool,
    cwd,
  };

  // Extract tool name from PostToolUse
  if (eventType === 'tool_use' && typeof hookData.tool_name === 'string') {
    event.toolName = hookData.tool_name;
  }

  // Extract prompt summary from UserPromptSubmit
  if (eventType === 'prompt_submit' && typeof hookData.prompt === 'string') {
    // Keep first 200 chars of the prompt as summary
    event.promptSummary = hookData.prompt.slice(0, 200);
  }

  return event;
}

// ─── JSONL persistence ──────────────────────────────────

/** Get events path (evaluated at call time). */
function getEventsPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'dashboard', 'events.jsonl');
}

/**
 * Append a DashboardEvent to the events JSONL file.
 * Silently fails on I/O errors to avoid disrupting the AI session.
 */
export async function appendEvent(event: DashboardEvent): Promise<void> {
  try {
    const eventsPath = getEventsPath();
    await ensureDir(path.dirname(eventsPath));
    const line = JSON.stringify(event) + '\n';
    await fs.promises.appendFile(eventsPath, line, 'utf-8');
    log.debug(`dashboard: recorded ${event.type} for session ${event.sessionId.slice(0, 16)}`);
  } catch (e) {
    log.error(`dashboard: failed to write event: ${(e as Error).message}`);
  }
}

/**
 * Read all events from the JSONL file. Skips corrupted lines.
 */
export async function readEvents(eventsPath?: string): Promise<DashboardEvent[]> {
  const filePath = eventsPath ?? getEventsPath();
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const events: DashboardEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as DashboardEvent;
        if (parsed.type && parsed.sessionId && parsed.timestamp) {
          events.push(parsed);
        }
      } catch {
        // Skip corrupted lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

// ─── Session state rebuild ──────────────────────────────
//
//  events.jsonl (append-only)
//      │
//      ▼
//  rebuildSessions(events)
//      │ fold events into session map
//      │ apply idle/stale timeouts
//      ▼
//  DashboardSession[]
//

/**
 * Rebuild current session states from a list of events.
 * This is the core "event sourcing" logic:
 * - session_start → create session
 * - tool_use → update lastActivity + lastTool
 * - prompt_submit → capture first prompt, mark as running
 * - stop → mark session as stopped
 * Then apply timeouts: idle after 5 min, remove after 30 min.
 */
export function rebuildSessions(events: DashboardEvent[]): DashboardSession[] {
  const sessions = new Map<string, DashboardSession>();
  const now = Date.now();

  for (const event of events) {
    let session = sessions.get(event.sessionId);

    if (!session) {
      session = {
        sessionId: event.sessionId,
        tool: event.tool,
        status: 'running',
        cwd: event.cwd ?? '',
        promptSummary: '',
        lastActivity: event.timestamp,
        startedAt: event.timestamp,
        lastTool: '',
      };
      sessions.set(event.sessionId, session);
    }

    // Update common fields
    session.lastActivity = event.timestamp;
    if (event.cwd) session.cwd = event.cwd;

    switch (event.type) {
      case 'session_start':
        session.status = 'running';
        session.startedAt = event.timestamp;
        break;
      case 'tool_use':
        session.status = 'running';
        if (event.toolName) session.lastTool = event.toolName;
        break;
      case 'prompt_submit':
        session.status = 'running';
        // Capture the first prompt as summary
        if (!session.promptSummary && event.promptSummary) {
          session.promptSummary = event.promptSummary;
        }
        break;
      case 'stop':
        session.status = 'stopped';
        break;
    }
  }

  // Apply timeouts
  const result: DashboardSession[] = [];
  for (const session of sessions.values()) {
    if (session.status === 'stopped') continue;

    const lastActivityMs = new Date(session.lastActivity).getTime();
    const elapsed = now - lastActivityMs;

    // Remove stale sessions (> 30 min)
    if (elapsed > DASHBOARD_STALE_TIMEOUT_MS) continue;

    // Mark idle sessions (> 5 min)
    if (elapsed > DASHBOARD_IDLE_TIMEOUT_MS) {
      session.status = 'idle';
    }

    result.push(session);
  }

  // Sort by lastActivity descending (most recent first)
  result.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return result;
}

// ─── JSONL compaction ───────────────────────────────────

/**
 * Compact events.jsonl by keeping only events for active sessions.
 * Active = not stopped and last activity within STALE_TIMEOUT.
 * Called when file exceeds COMPACTION_THRESHOLD lines.
 */
export async function compactEvents(eventsPath?: string): Promise<void> {
  const filePath = eventsPath ?? getEventsPath();
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length < DASHBOARD_COMPACTION_THRESHOLD) return;

    const events = await readEvents(filePath);
    const activeSessions = rebuildSessions(events);
    const activeIds = new Set(activeSessions.map(s => s.sessionId));

    // Keep only events for active sessions
    const kept = events.filter(e => activeIds.has(e.sessionId));
    const compacted = kept.map(e => JSON.stringify(e)).join('\n') + '\n';

    // Atomic write: write to temp, then rename
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, compacted, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);

    log.debug(`dashboard: compacted ${lines.length} → ${kept.length} events`);
  } catch (e) {
    log.error(`dashboard: compaction failed: ${(e as Error).message}`);
  }
}

// ─── CLI entry point ────────────────────────────────────

/**
 * Handle `teamai dashboard-report --stdin --tool <name>`.
 * Called by dashboard hooks in Claude Code / other AI tools.
 */
export async function dashboardReport(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('dashboard-report: no STDIN data');
    return;
  }

  const event = parseHookEvent(raw, toolArg ?? 'claude');
  if (!event) return;

  await appendEvent(event);

  // Trigger compaction check (non-blocking)
  compactEvents().catch(() => {});
}
