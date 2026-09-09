import {
  DASHBOARD_IDLE_TIMEOUT_MS,
  type DailyUserStats,
  type DashboardEvent,
  type RequestCostMetrics,
} from './types.js';
import { aggregateSessionMetrics } from './dashboard-collector.js';

export interface DailySessionSnapshot {
  date: string;
  prompts: number;
  durationMs: number;
  succeeded: 0 | 1;
  corrected: 0 | 1;
  pricedRequests: number;
  costMicros: number;
  cacheReadTokens: number;
  cacheEligibleInputTokens: number;
  priceVersion?: string;
}

export type ReportedDailySessions = Record<string, DailySessionSnapshot>;

function emptyDaily(): DailyUserStats {
  return {
    sessionsEnded: 0,
    sessionsSucceeded: 0,
    promptTurns: 0,
    durationMs: 0,
    sessionsCorrected: 0,
    pricedRequests: 0,
    costMicros: 0,
    cacheReadTokens: 0,
    cacheEligibleInputTokens: 0,
  };
}

function latestRequestMetrics(events: DashboardEvent[]): RequestCostMetrics | undefined {
  let latest: DashboardEvent | undefined;
  for (const event of events) {
    if (!event.requestMetrics) continue;
    if (!latest || Date.parse(event.timestamp) >= Date.parse(latest.timestamp)) latest = event;
  }
  return latest?.requestMetrics;
}

/** Fold local events into one cumulative snapshot per session. */
export function aggregateDailySessions(events: DashboardEvent[]): Map<string, DailySessionSnapshot> {
  const grouped = new Map<string, DashboardEvent[]>();
  for (const event of events) {
    const own = grouped.get(event.sessionId) ?? [];
    own.push(event);
    grouped.set(event.sessionId, own);
  }
  const metrics = aggregateSessionMetrics(events);
  const result = new Map<string, DailySessionSnapshot>();

  for (const [sessionId, ownUnsorted] of grouped) {
    const own = [...ownUnsorted].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const firstStop = own.find((event) => event.type === 'stop');
    if (!firstStop) continue;
    const metric = metrics.get(sessionId);
    if (!metric) continue;

    let durationMs = 0;
    for (let i = 1; i < own.length; i++) {
      const gap = Date.parse(own[i].timestamp) - Date.parse(own[i - 1].timestamp);
      if (Number.isFinite(gap) && gap >= 0 && gap <= DASHBOARD_IDLE_TIMEOUT_MS) durationMs += gap;
    }

    const hasError = own.some((event) => event.status === 'error');
    const request = latestRequestMetrics(own);
    const corrected = metric.correction > 0 ? 1 : 0;
    result.set(sessionId, {
      date: firstStop.timestamp.slice(0, 10),
      prompts: metric.prompts,
      durationMs,
      succeeded: !hasError && metric.interrupt === 0 && corrected === 0 ? 1 : 0,
      corrected,
      pricedRequests: request?.pricedRequests ?? 0,
      costMicros: request?.costMicros ?? 0,
      cacheReadTokens: request?.cacheReadTokens ?? 0,
      cacheEligibleInputTokens: request?.cacheEligibleInputTokens ?? 0,
      priceVersion: request?.priceVersion,
    });
  }
  return result;
}

function positiveDelta(current: number, previous: number | undefined): number {
  return Math.max(0, current - (previous ?? 0));
}

/** Compute idempotent daily deltas while keeping resumed work on the first Stop day. */
export function computeDailyStatsDelta(
  current: Map<string, DailySessionSnapshot>,
  reported: ReportedDailySessions,
): { delta: Record<string, DailyUserStats>; nextReported: ReportedDailySessions } {
  const delta: Record<string, DailyUserStats> = {};
  const nextReported: ReportedDailySessions = {};
  for (const [sessionId, snapshot] of current) {
    const previous = reported[sessionId];
    const date = previous?.date ?? snapshot.date;
    const bucket = delta[date] ?? emptyDaily();
    if (!previous) {
      bucket.sessionsEnded += 1;
      bucket.sessionsSucceeded += snapshot.succeeded;
    }
    bucket.promptTurns += positiveDelta(snapshot.prompts, previous?.prompts);
    bucket.durationMs += positiveDelta(snapshot.durationMs, previous?.durationMs);
    bucket.sessionsCorrected += positiveDelta(snapshot.corrected, previous?.corrected);
    bucket.pricedRequests += positiveDelta(snapshot.pricedRequests, previous?.pricedRequests);
    bucket.costMicros += positiveDelta(snapshot.costMicros, previous?.costMicros);
    bucket.cacheReadTokens += positiveDelta(snapshot.cacheReadTokens, previous?.cacheReadTokens);
    bucket.cacheEligibleInputTokens += positiveDelta(snapshot.cacheEligibleInputTokens, previous?.cacheEligibleInputTokens);
    if (snapshot.priceVersion) bucket.priceVersion = snapshot.priceVersion;
    delta[date] = bucket;
    nextReported[sessionId] = { ...snapshot, date };
  }
  return { delta, nextReported };
}

export function mergeDailyStats(
  existing: Record<string, DailyUserStats> | undefined,
  delta: Record<string, DailyUserStats>,
): Record<string, DailyUserStats> {
  const merged: Record<string, DailyUserStats> = { ...(existing ?? {}) };
  for (const [date, increment] of Object.entries(delta)) {
    const current = merged[date] ?? emptyDaily();
    merged[date] = {
      sessionsEnded: current.sessionsEnded + increment.sessionsEnded,
      sessionsSucceeded: current.sessionsSucceeded + increment.sessionsSucceeded,
      promptTurns: current.promptTurns + increment.promptTurns,
      durationMs: current.durationMs + increment.durationMs,
      sessionsCorrected: current.sessionsCorrected + increment.sessionsCorrected,
      pricedRequests: current.pricedRequests + increment.pricedRequests,
      costMicros: current.costMicros + increment.costMicros,
      cacheReadTokens: current.cacheReadTokens + increment.cacheReadTokens,
      cacheEligibleInputTokens: current.cacheEligibleInputTokens + increment.cacheEligibleInputTokens,
      priceVersion: increment.priceVersion ?? current.priceVersion,
    };
  }
  return merged;
}

export interface TrendPeriod {
  sessionsEnded: number;
  successRate: number | null;
  avgPrompts: number | null;
  avgDurationMs: number | null;
  avgRequestCostMicros: number | null;
  cacheReadShare: number | null;
  correctionRate: number | null;
}

function summarizePeriod(buckets: DailyUserStats[]): TrendPeriod {
  const totals = buckets.reduce((sum, value) => ({
    sessionsEnded: sum.sessionsEnded + value.sessionsEnded,
    sessionsSucceeded: sum.sessionsSucceeded + value.sessionsSucceeded,
    promptTurns: sum.promptTurns + value.promptTurns,
    durationMs: sum.durationMs + value.durationMs,
    sessionsCorrected: sum.sessionsCorrected + value.sessionsCorrected,
    pricedRequests: sum.pricedRequests + value.pricedRequests,
    costMicros: sum.costMicros + value.costMicros,
    cacheReadTokens: sum.cacheReadTokens + value.cacheReadTokens,
    cacheEligibleInputTokens: sum.cacheEligibleInputTokens + value.cacheEligibleInputTokens,
  }), { ...emptyDaily() });
  return {
    sessionsEnded: totals.sessionsEnded,
    successRate: totals.sessionsEnded ? totals.sessionsSucceeded / totals.sessionsEnded : null,
    avgPrompts: totals.sessionsEnded ? totals.promptTurns / totals.sessionsEnded : null,
    avgDurationMs: totals.sessionsEnded ? totals.durationMs / totals.sessionsEnded : null,
    avgRequestCostMicros: totals.pricedRequests ? totals.costMicros / totals.pricedRequests : null,
    cacheReadShare: totals.cacheEligibleInputTokens ? totals.cacheReadTokens / totals.cacheEligibleInputTokens : null,
    correctionRate: totals.sessionsEnded ? totals.sessionsCorrected / totals.sessionsEnded : null,
  };
}

export function summarizeTrendWindow(
  daily: Record<string, DailyUserStats>,
  now = new Date(),
): { current: TrendPeriod; previous: TrendPeriod } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const currentStart = end - 6 * 86_400_000;
  const previousStart = currentStart - 7 * 86_400_000;
  const current: DailyUserStats[] = [];
  const previous: DailyUserStats[] = [];
  for (const [date, bucket] of Object.entries(daily)) {
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (timestamp >= currentStart && timestamp <= end) current.push(bucket);
    else if (timestamp >= previousStart && timestamp < currentStart) previous.push(bucket);
  }
  return { current: summarizePeriod(current), previous: summarizePeriod(previous) };
}
