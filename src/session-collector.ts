/**
 * Session collector — implements Feature 1 ("session tool-usage record") from
 * docs/designs/team-intelligence-platform.md.
 *
 * The dashboard already collects a rich per-session event stream in
 * ~/.teamai/dashboard/events.jsonl (tool sequence, prompt turns, interventions,
 * tokens). Historically that stream never left the machine and was dropped by
 * dashboard compaction. This module folds one session's events into a compact,
 * privacy-scrubbed markdown summary and appends it to a monthly log, so the
 * record survives and (via `teamai session save --push`) can seed the team
 * digest's "Session Highlights".
 *
 * Design decisions honored:
 *   - Collect-then-summarize (no LLM call here). (Decision 1)
 *   - Monthly aggregated markdown files. (Decision 3)
 *   - "Valuable" sessions are the ones showing tool misuse / retries / user
 *     intervention — the core signal the platform wants to surface. (Decision 7/8)
 *   - Counts and tool names only; any free text is run through redact(). (Security)
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './utils/fs.js';
import { redactWithEnv } from './utils/redact.js';
import { aggregateSessionMetrics } from './dashboard-collector.js';
import { emptyTokenUsage } from './types.js';
import type { DashboardEvent, SessionMetrics } from './types.js';

/** A folded, human-readable summary of a single session. */
export interface SessionSummary {
  sessionId: string;
  tool: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  /** Tool-name → invocation count, from tool_use events. */
  toolCounts: Record<string, number>;
  /** Total tool invocations. */
  toolTotal: number;
  /** Distinct tool names used. */
  distinctTools: number;
  interventions: { interrupt: number; toolReject: number; correction: number };
  interventionCount: number;
  prompts: number;
  /** First user prompt, redacted and truncated. Empty when unavailable. */
  firstPrompt: string;
  /** Whether this session is worth surfacing to the team (see isValuable). */
  valuable: boolean;
}

/** Max characters kept from the first prompt in a summary. */
const FIRST_PROMPT_MAX_CHARS = 160;
/** A session touching at least this many distinct tools is considered substantial. */
const SUBSTANTIAL_TOOL_COUNT = 3;

/**
 * A session is "valuable" (worth surfacing to the team) when it shows signs of
 * friction — a user interrupt, a tool rejection, or a re-prompt correction —
 * or when it exercised a substantial number of distinct tools. Pure chatter and
 * trivial one-tool sessions are filtered out. (Design Decision 8.)
 */
export function isValuable(summary: Pick<SessionSummary, 'interventionCount' | 'distinctTools'>): boolean {
  return summary.interventionCount > 0 || summary.distinctTools >= SUBSTANTIAL_TOOL_COUNT;
}

/**
 * Fold every event for a single session id into a {@link SessionSummary}.
 * Returns null when the session has no events (unknown id).
 */
export function collectSession(sessionId: string, events: DashboardEvent[]): SessionSummary | null {
  const own = events.filter((e) => e.sessionId === sessionId);
  if (own.length === 0) return null;

  const toolCounts: Record<string, number> = {};
  let tool = own[0].tool;
  let cwd = '';
  let firstPromptRaw = '';
  let startedAt = own[0].timestamp;
  let endedAt = own[0].timestamp;

  for (const e of own) {
    if (e.tool) tool = e.tool;
    if (e.cwd) cwd = e.cwd;
    if (e.timestamp < startedAt) startedAt = e.timestamp;
    if (e.timestamp > endedAt) endedAt = e.timestamp;
    if (e.type === 'tool_use' && e.toolName) {
      toolCounts[e.toolName] = (toolCounts[e.toolName] ?? 0) + 1;
    }
    if (!firstPromptRaw && e.type === 'prompt_submit' && e.promptSummary) {
      firstPromptRaw = e.promptSummary;
    }
  }

  const metrics: SessionMetrics =
    aggregateSessionMetrics(own).get(sessionId) ??
    { interrupt: 0, toolReject: 0, correction: 0, prompts: 0, tokens: emptyTokenUsage() };

  const interventions = {
    interrupt: metrics.interrupt,
    toolReject: metrics.toolReject,
    correction: metrics.correction,
  };
  const interventionCount = interventions.interrupt + interventions.toolReject + interventions.correction;
  const toolTotal = Object.values(toolCounts).reduce((s, n) => s + n, 0);
  const distinctTools = Object.keys(toolCounts).length;
  const firstPrompt = firstPromptRaw
    ? redactWithEnv(firstPromptRaw).replace(/\s+/g, ' ').trim().slice(0, FIRST_PROMPT_MAX_CHARS)
    : '';

  return {
    sessionId,
    tool,
    cwd,
    startedAt,
    endedAt,
    toolCounts,
    toolTotal,
    distinctTools,
    interventions,
    interventionCount,
    prompts: metrics.prompts,
    firstPrompt,
    valuable: isValuable({ interventionCount, distinctTools }),
  };
}

/** Short, stable id fragment for headings (first segment of a UUID). */
function shortId(sessionId: string): string {
  return sessionId.split('-')[0].slice(0, 8) || sessionId.slice(0, 8);
}

export interface RenderOptions {
  /**
   * Include the (redacted) first-prompt line. Off by default so the team-pushed
   * summary stays counts-and-tools only; `redact()` is best-effort, so prompt
   * text is opt-in even after scrubbing. Local logs pass this on.
   */
  includePrompt?: boolean;
}

/** Render a single session as a self-contained markdown block. */
export function renderSessionMarkdown(summary: SessionSummary, options: RenderOptions = {}): string {
  const date = summary.endedAt.slice(0, 10);
  const topTools = Object.entries(summary.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
  const iv = summary.interventions;
  const lines = [
    // Stable, collision-proof idempotency key: the full session id, in an HTML
    // comment so it never renders. The heading below still shows the short id
    // for humans. `appendMonthlyLog` dedups on this marker.
    `<!-- teamai:session ${summary.sessionId} -->`,
    `### ${date} · ${shortId(summary.sessionId)} · ${summary.tool}`,
    '',
    `- Project: \`${summary.cwd || 'unknown'}\``,
    `- Prompts: ${summary.prompts} · Tools: ${summary.toolTotal} (${summary.distinctTools} distinct)`,
    `- Interventions: interrupt ${iv.interrupt}, toolReject ${iv.toolReject}, correction ${iv.correction}`,
  ];
  if (topTools) lines.push(`- Top tools: ${topTools}`);
  if (options.includePrompt && summary.firstPrompt) lines.push(`- First ask: ${summary.firstPrompt}`);
  lines.push('');
  return lines.join('\n');
}

/** `YYYY-MM` bucket for a session, from its end timestamp. */
export function monthKey(summary: SessionSummary): string {
  return summary.endedAt.slice(0, 7);
}

/**
 * Append a session's markdown to its monthly log file, idempotently: a session
 * already present (matched by its full-session-id `<!-- teamai:session … -->`
 * marker) is not appended again. Returns the file path written, or null when the
 * session was already recorded. Creates the directory and a month header on first
 * write.
 */
export async function appendMonthlyLog(
  dir: string,
  summary: SessionSummary,
  options: RenderOptions = {},
): Promise<string | null> {
  await ensureDir(dir);
  const month = monthKey(summary);
  const file = path.join(dir, `${month}.md`);
  const block = renderSessionMarkdown(summary, options);
  const marker = `<!-- teamai:session ${summary.sessionId} -->`;

  let existing = '';
  try {
    existing = await fs.promises.readFile(file, 'utf-8');
  } catch {
    // New month.
  }

  if (existing.includes(marker)) return null;

  const header = existing ? '' : `# Session log — ${month}\n\n`;
  await fs.promises.writeFile(file, existing + header + block, 'utf-8');
  return file;
}

/**
 * Delete monthly log files whose month is older than `retentionDays` (Feature 5
 * retention). Returns the list of removed file basenames. Best-effort: unreadable
 * entries are skipped.
 */
export async function pruneMonthlyLogs(
  dir: string,
  now: Date,
  retentionDays = 90,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const removed: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^(\d{4})-(\d{2})\.md$/);
    if (!m) continue;
    // Compare against the *end* of that month so the current month is never pruned.
    const monthEnd = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0, 23, 59, 59));
    if (monthEnd.getTime() < cutoff) {
      try {
        await fs.promises.unlink(path.join(dir, entry));
        removed.push(entry);
      } catch {
        // Skip files we can't remove.
      }
    }
  }
  return removed;
}
