/**
 * Derived session analytics for `teamai stats` — per-repo breakdown and
 * time-of-day patterns, computed from the local dashboard event stream.
 *
 * Ports the shape of claude-cloud-sync's stats.json analytics (by_repo,
 * timeline_by_hour, active_minutes, night-owl ratio), adapted to the data
 * teamai-cli already collects: attribution is at session granularity (one cwd
 * per session) rather than the sync's per-turn cost splitting.
 */

import { aggregateSessionMetrics } from './dashboard-collector.js';
import { emptyTokenUsage, addTokenUsage, totalTokens } from './types.js';
import { attributeRepo } from './utils/repo-attribution.js';
import type { DashboardEvent, TokenUsage } from './types.js';

export interface RepoStat {
  repo: string;
  sessions: number;
  prompts: number;
  tools: number;
  interventions: number;
  tokens: TokenUsage;
}

/**
 * Roll usage up per repo. Each session is attributed to the project of its cwd;
 * its prompts/interventions/tokens (from aggregateSessionMetrics) and tool count
 * are added to that repo's totals. Sorted by total tokens, then session count.
 */
export function attributeByRepo(events: DashboardEvent[]): RepoStat[] {
  const sessionCwd = new Map<string, string>();
  const sessionTools = new Map<string, number>();
  const sessionIds = new Set<string>();

  for (const e of events) {
    sessionIds.add(e.sessionId);
    if (e.cwd) sessionCwd.set(e.sessionId, e.cwd);
    if (e.type === 'tool_use') {
      sessionTools.set(e.sessionId, (sessionTools.get(e.sessionId) ?? 0) + 1);
    }
  }

  const metrics = aggregateSessionMetrics(events);
  const byRepo = new Map<string, RepoStat>();

  for (const sid of sessionIds) {
    const repo = attributeRepo(sessionCwd.get(sid));
    let r = byRepo.get(repo);
    if (!r) {
      r = { repo, sessions: 0, prompts: 0, tools: 0, interventions: 0, tokens: emptyTokenUsage() };
      byRepo.set(repo, r);
    }
    r.sessions += 1;
    r.tools += sessionTools.get(sid) ?? 0;
    const m = metrics.get(sid);
    if (m) {
      r.prompts += m.prompts;
      r.interventions += m.interrupt + m.toolReject + m.correction;
      r.tokens = addTokenUsage(r.tokens, m.tokens);
    }
  }

  return Array.from(byRepo.values()).sort(
    (a, b) => totalTokens(b.tokens) - totalTokens(a.tokens) || b.sessions - a.sessions,
  );
}

export interface TimeAnalytics {
  /** Activity-event counts indexed by local hour of day (0–23). */
  byHour: number[];
  /** Hour of day with the most activity (0–23); -1 when there is no data. */
  peakHour: number;
  /** Share of activity between 00:00 and 05:59 local time (0–1). */
  nightOwlRatio: number;
  /** Sum, across sessions, of consecutive event gaps under the idle threshold. */
  activeMinutes: number;
  /** Total activity events considered. */
  totalEvents: number;
}

/** Gaps shorter than this count as continuous active time (matches dashboard idle). */
const ACTIVE_GAP_MS = 5 * 60_000;

/**
 * Compute time-of-day activity patterns and active minutes from the event
 * stream. Hours use the local timezone of the machine running the command.
 */
export function timeAnalytics(events: DashboardEvent[]): TimeAnalytics {
  const byHour = new Array(24).fill(0) as number[];
  let nightOwl = 0;
  let total = 0;

  // Per-session sorted timestamps for active-minute accumulation.
  const perSession = new Map<string, number[]>();

  for (const e of events) {
    const t = new Date(e.timestamp);
    const ms = t.getTime();
    if (Number.isNaN(ms)) continue;
    const hour = t.getHours();
    byHour[hour] += 1;
    if (hour < 6) nightOwl += 1;
    total += 1;
    const arr = perSession.get(e.sessionId);
    if (arr) arr.push(ms);
    else perSession.set(e.sessionId, [ms]);
  }

  let activeMs = 0;
  for (const times of perSession.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap > 0 && gap < ACTIVE_GAP_MS) activeMs += gap;
    }
  }

  let peakHour = -1;
  let peakCount = -1;
  for (let h = 0; h < 24; h++) {
    if (byHour[h] > peakCount) {
      peakCount = byHour[h];
      peakHour = h;
    }
  }

  return {
    byHour,
    peakHour: total > 0 ? peakHour : -1,
    nightOwlRatio: total > 0 ? nightOwl / total : 0,
    activeMinutes: Math.round(activeMs / 60_000),
    totalEvents: total,
  };
}

/**
 * Render a compact 24-hour sparkline for a byHour histogram. Empty hours render
 * as `·` so idle hours are visually distinct from low-but-nonzero activity
 * (which is at least `▁`).
 */
export function renderHourSparkline(byHour: number[]): string {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...byHour, 1);
  return byHour
    .map((c) => (c === 0 ? '·' : bars[Math.min(bars.length - 1, Math.round((c / max) * (bars.length - 1)))]))
    .join('');
}
