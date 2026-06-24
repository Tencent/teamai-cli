import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { log } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';
import { ensureDir } from './utils/fs.js';
import { resolveMonitorPid } from './pid-monitor.js';
import { normalizeToolName } from './utils/tool-names.js';
import {
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENTS_DIR,
  DASHBOARD_COMPACTION_THRESHOLD,
  DASHBOARD_IDLE_TIMEOUT_MS,
  DASHBOARD_STALE_TIMEOUT_MS,
  DASHBOARD_STOPPED_DISPLAY_MS,
  CORRECTION_WINDOW_MS,
  CORRECTION_KEYWORDS,
  INTERVENTION_SCAN_MAX_BYTES,
  TRANSCRIPT_INTERRUPT_PREFIX,
  TRANSCRIPT_REJECT_MARKERS,
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

// ─── Transcript reading ─────────────────────────────────

/** Maximum bytes to read from the end of a transcript file. */
const TRANSCRIPT_TAIL_BYTES = 10240;
/** Maximum characters for stoppedOutput. */
const STOPPED_OUTPUT_MAX_CHARS = 500;

/**
 * Read the last assistant message from a Claude Code transcript file.
 * Uses tail-read (last 10KB) to avoid loading the entire file into memory.
 * Returns empty string on any error (file missing, permission denied, etc.).
 */
export async function readLastAssistantOutput(transcriptPath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    const fileSize = stat.size;
    if (fileSize === 0) return '';

    const readSize = Math.min(fileSize, TRANSCRIPT_TAIL_BYTES);
    const offset = Math.max(0, fileSize - readSize);

    const fh = await fs.promises.open(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, offset);
      const tail = buffer.toString('utf-8');

      // Parse JSONL lines from the tail, find the last assistant message
      const lines = tail.split('\n').filter(l => l.trim());
      let lastAssistantText = '';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Claude Code transcript format: {type: "assistant", message: {content: [{type: "text", text: "..."}]}}
          if (entry.type === 'assistant' && entry.message?.content) {
            const textParts = (entry.message.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text);
            if (textParts.length > 0) {
              lastAssistantText = textParts.join('\n');
            }
          }
        } catch {
          // Skip malformed lines (expected when tail starts mid-line)
        }
      }

      return lastAssistantText.slice(0, STOPPED_OUTPUT_MAX_CHARS);
    } finally {
      await fh.close();
    }
  } catch (e) {
    log.warn(`dashboard: failed to read transcript: ${(e as Error).message}`);
    return '';
  }
}

/**
 * Scan a full transcript and count cumulative human-intervention signals:
 * - interrupt:  user message whose text starts with "[Request interrupted by user"
 * - toolReject: tool_result with is_error=true marked as a user rejection
 *
 * Uses a streaming line reader so large transcripts don't load fully into memory.
 * Returns zero counts on any error (file missing, too large, permission denied).
 */
export async function countInterventions(
  transcriptPath: string,
): Promise<{ interrupt: number; toolReject: number }> {
  let interrupt = 0;
  let toolReject = 0;

  try {
    const stat = await fs.promises.stat(transcriptPath);
    if (stat.size === 0) return { interrupt, toolReject };
    if (stat.size > INTERVENTION_SCAN_MAX_BYTES) {
      log.warn(`dashboard: transcript too large to scan for interventions (${stat.size} bytes)`);
      return { interrupt, toolReject };
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(transcriptPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      // Cheap pre-filter: intervention signals only ever live in `user` entries,
      // so skip JSON.parse on the (vast majority of) other lines.
      if (!trimmed || !trimmed.includes('"user"')) continue;

      let entry: { type?: string; message?: { content?: unknown } };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.type !== 'user' || !Array.isArray(entry.message?.content)) continue;

      for (const item of entry.message.content as Array<Record<string, unknown>>) {
        if (item?.type === 'text' && typeof item.text === 'string'
          && item.text.startsWith(TRANSCRIPT_INTERRUPT_PREFIX)) {
          interrupt++;
        } else if (item?.type === 'tool_result' && item.is_error === true) {
          const text = typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? (item.content as Array<{ text?: string }>)
                .map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
              : '';
          if (TRANSCRIPT_REJECT_MARKERS.some((m) => text.includes(m))) {
            toolReject++;
          }
        }
      }
    }
  } catch (e) {
    log.warn(`dashboard: failed to scan interventions: ${(e as Error).message}`);
  }

  return { interrupt, toolReject };
}

/** True when a prompt looks like a course-correction (vs. a fresh task). */
function isCorrectionPrompt(text?: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CORRECTION_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Map hook event names to dashboard event types.
 * Supports Claude Code (PascalCase), Cursor and CodeBuddy (camelCase) formats.
 */
function mapEventType(hookEventName: string): DashboardEventType | null {
  switch (hookEventName) {
    case 'SessionStart':
    case 'sessionStart':
      return 'session_start';
    case 'PostToolUse':
    case 'postToolUse':
      return 'tool_use';
    case 'UserPromptSubmit':
    case 'userPromptSubmit':
    case 'beforeSubmitPrompt':
      return 'prompt_submit';
    case 'Stop':
    case 'stop':
      return 'stop';
    default:
      return null;
  }
}

/**
 * Parse a hook STDIN JSON payload into a DashboardEvent.
 * Returns null if the payload is invalid or irrelevant.
 * For stop events, reads the transcript file to capture AI output.
 */
export async function parseHookEvent(
  raw: string,
  tool: string,
): Promise<DashboardEvent | null> {
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

  const sessionId = deriveSessionId(hookData, { includeCwd: true });
  const cwd = typeof hookData.cwd === 'string' ? hookData.cwd : undefined;

  const event: DashboardEvent = {
    type: eventType,
    timestamp: new Date().toISOString(),
    sessionId,
    tool,
    cwd,
  };

  // Extract tool name from PostToolUse (normalize IDE-style names)
  if (eventType === 'tool_use' && typeof hookData.tool_name === 'string') {
    event.toolName = normalizeToolName(hookData.tool_name);
  }

  // Resolve AI tool PID for liveness monitoring on session start
  if (eventType === 'session_start') {
    const ppid = process.ppid ?? process.pid;
    if (ppid > 1) {
      try {
        event.monitorPid = resolveMonitorPid(ppid);
      } catch {
        // PID resolution failed — fall back to ppid
        event.monitorPid = ppid;
      }
    }
  }

  // Extract prompt summary from UserPromptSubmit
  if (eventType === 'prompt_submit' && typeof hookData.prompt === 'string') {
    // Keep first 200 chars of the prompt as summary
    event.promptSummary = hookData.prompt.slice(0, 200);
  }

  // Extract transcript path, AI output and intervention counts from Stop event
  if (eventType === 'stop' && typeof hookData.transcript_path === 'string') {
    event.transcriptPath = hookData.transcript_path;
    const output = await readLastAssistantOutput(hookData.transcript_path);
    if (output) {
      event.stoppedOutput = output;
    }
    // Full-transcript snapshot of interrupt/tool_reject counts (idempotent).
    const iv = await countInterventions(hookData.transcript_path);
    if (iv.interrupt > 0 || iv.toolReject > 0) {
      event.interventions = iv;
    }
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
    const detail = event.toolName
      ? ` [tool=${event.toolName}]`
      : event.promptSummary
        ? ` [prompt=${event.promptSummary.slice(0, 60)}]`
        : '';
    log.debug(`dashboard: recorded ${event.type} for session ${event.sessionId.slice(0, 16)}${detail}`);
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
 * - session_start → create session, record monitorPid
 * - tool_use → update lastActivity + lastTool, mark running
 * - prompt_submit → capture prompt, mark running
 * - stop → mark as waiting_for_input (LLM finished, user still in session)
 * - process_exit → mark as stopped (process truly exited)
 * Then apply timeouts: idle after 5 min, remove stale after 30 min.
 * Stopped sessions are kept for 30 seconds before removal.
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
        prompts: [],
        stoppedOutput: '',
        stoppedAt: '',
        interventions: { interrupt: 0, toolReject: 0, correction: 0 },
        interventionCount: 0,
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
        if (event.monitorPid) session.monitorPid = event.monitorPid;
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
        // Collect all prompts
        if (event.promptSummary) {
          session.prompts.push(event.promptSummary);
        }
        break;
      case 'stop':
        // Stop = LLM finished responding, but the user is still in the session.
        // Mark as waiting_for_input instead of stopped. The session will return
        // to 'running' when the next prompt_submit or tool_use arrives.
        session.status = 'waiting_for_input';
        if (event.stoppedOutput) {
          session.stoppedOutput = event.stoppedOutput;
        }
        break;
      case 'process_exit':
        // The AI tool process has truly exited (detected by PID liveness monitor).
        // This is the real "session ended" signal.
        session.status = 'stopped';
        session.stoppedAt = event.timestamp;
        break;
    }
  }

  // Fill per-session intervention counts (single source of truth: aggregate fold)
  const interventionMap = aggregateSessionInterventions(events);
  for (const session of sessions.values()) {
    const iv = interventionMap.get(session.sessionId);
    if (iv) {
      session.interventions = iv;
      session.interventionCount = iv.interrupt + iv.toolReject + iv.correction;
    }
  }

  // Apply timeouts
  const result: DashboardSession[] = [];
  for (const session of sessions.values()) {
    const lastActivityMs = new Date(session.lastActivity).getTime();
    const elapsed = now - lastActivityMs;

    if (session.status === 'stopped') {
      // Keep stopped sessions for 30 seconds, then remove
      const stoppedAtMs = session.stoppedAt
        ? new Date(session.stoppedAt).getTime()
        : lastActivityMs;
      const stoppedElapsed = now - stoppedAtMs;
      if (stoppedElapsed > DASHBOARD_STOPPED_DISPLAY_MS) continue;
      result.push(session);
      continue;
    }

    // Remove stale sessions (> 30 min)
    if (elapsed > DASHBOARD_STALE_TIMEOUT_MS) continue;

    // Mark idle sessions (> 5 min)
    if (elapsed > DASHBOARD_IDLE_TIMEOUT_MS) {
      session.status = 'idle';
    }

    result.push(session);
  }

  // Sort: active sessions first, stopped last; within each group by total runtime descending
  result.sort((a, b) => {
    if (a.status === 'stopped' && b.status !== 'stopped') return 1;
    if (a.status !== 'stopped' && b.status === 'stopped') return -1;
    // Sort by total runtime descending (longest-running first) for stable card positions
    const sortNow = Date.now();
    const aEnd = a.stoppedAt ? new Date(a.stoppedAt).getTime() : sortNow;
    const bEnd = b.stoppedAt ? new Date(b.stoppedAt).getTime() : sortNow;
    const aRuntime = aEnd - new Date(a.startedAt).getTime();
    const bRuntime = bEnd - new Date(b.startedAt).getTime();
    return bRuntime - aRuntime;
  });
  return result;
}

/**
 * Aggregate per-session intervention counts from raw events (no timeout filtering).
 *
 * - interrupt / toolReject: taken from the latest Stop event's snapshot (idempotent —
 *   a later Stop overrides an earlier one, so re-scanning never double-counts).
 * - correction: a prompt_submit arriving within CORRECTION_WINDOW_MS of a Stop AND
 *   matching a correction keyword. Each Stop is consumed by the next prompt only once.
 *
 * Used both by rebuildSessions (live dashboard) and by the team-stats reporter.
 */
export function aggregateSessionInterventions(
  events: DashboardEvent[],
): Map<string, { interrupt: number; toolReject: number; correction: number }> {
  const map = new Map<string, { interrupt: number; toolReject: number; correction: number }>();
  const lastStopAt = new Map<string, number>();

  for (const event of events) {
    let iv = map.get(event.sessionId);
    if (!iv) {
      iv = { interrupt: 0, toolReject: 0, correction: 0 };
      map.set(event.sessionId, iv);
    }

    if (event.type === 'stop') {
      if (event.interventions) {
        iv.interrupt = event.interventions.interrupt;
        iv.toolReject = event.interventions.toolReject;
      }
      lastStopAt.set(event.sessionId, new Date(event.timestamp).getTime());
    } else if (event.type === 'prompt_submit') {
      const stopAt = lastStopAt.get(event.sessionId);
      if (stopAt !== undefined) {
        const gap = new Date(event.timestamp).getTime() - stopAt;
        if (gap >= 0 && gap <= CORRECTION_WINDOW_MS && isCorrectionPrompt(event.promptSummary)) {
          iv.correction++;
        }
        // Each stop is consumed once — a later prompt is a new task, not a correction.
        lastStopAt.delete(event.sessionId);
      }
    }
  }

  return map;
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

  const event = await parseHookEvent(raw, toolArg ?? 'claude');
  if (!event) return;

  await appendEvent(event);

  // Trigger compaction check (non-blocking)
  compactEvents().catch(() => {});
}
