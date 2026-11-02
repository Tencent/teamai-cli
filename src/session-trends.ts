import { z } from 'zod';

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
  requestDaily: Record<string, RequestCostMetrics>;
  /** Session-level cache tokens, straight from the transcript (pricing-independent),
   *  so cache-read share works even when the model can't be priced. */
  sessionCacheReadTokens?: number;
  sessionCacheEligibleTokens?: number;
  /** Legacy fields retained while previously reported snapshots are upgraded. */
  pricedRequests?: number;
  costMicros?: number;
  cacheReadTokens?: number;
  cacheEligibleInputTokens?: number;
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

function latestRequestDaily(events: DashboardEvent[]): Record<string, RequestCostMetrics> {
  let latest: DashboardEvent | undefined;

  for (const event of events) {
    if (!event.requestDaily && !event.requestMetrics) continue;

    if (!latest || Date.parse(event.timestamp) >= Date.parse(latest.timestamp)) latest = event;
  }

  if (!latest) return {};

  if (latest.requestDaily) return latest.requestDaily;

  return latest.requestMetrics ? { [latest.timestamp.slice(0, 10)]: latest.requestMetrics } : {};
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

    // A Codex rollout's costs restart with it: the session sums its rollouts.
    const requestDaily = metric.segments
      ? Object.values(metric.segments).reduce((sum, segment) => addRequestDaily(sum, segment.requestDaily), {})
      : latestRequestDaily(own);

    const corrected = metric.correction > 0 ? 1 : 0;
    result.set(sessionId, {
      date: firstStop.timestamp.slice(0, 10),
      prompts: metric.prompts,
      durationMs,
      succeeded: !hasError && metric.interrupt === 0 && corrected === 0 ? 1 : 0,
      corrected,
      requestDaily,
      sessionCacheReadTokens: metric.tokens.cacheRead,
      sessionCacheEligibleTokens: metric.tokens.input + metric.tokens.cacheRead + metric.tokens.cacheCreation,
    });
  }

  return result;
}

function positiveDelta(current: number, previous: number | undefined): number {
  return Math.max(0, current - (previous ?? 0));
}

/** A count a snapshot file holds, 0 for what is not a number. */
export const SnapshotCountSchema = z.number().catch(0);

/** A day's request costs read from a file, 0 (or no price version) for each field it does not hold. */
const RequestCostEntrySchema = z.object({
  pricedRequests: SnapshotCountSchema,
  costMicros: SnapshotCountSchema,
  cacheReadTokens: SnapshotCountSchema,
  cacheEligibleInputTokens: SnapshotCountSchema,
  priceVersion: z.string().catch(''),
});

/** Request costs per day read from a file, without the days that are not objects; empty for what is not one. */
const RequestDailySchema = z.record(z.string(), RequestCostEntrySchema.optional().catch(undefined))
  .transform((days) => Object.fromEntries(Object.entries(days).flatMap(([date, request]) => (request ? [[date, request]] : []))))
  .catch({});

/** Request costs per day read from a file; empty for what is not one. */
export const parseRequestDaily = RequestDailySchema.parse;

/** Request costs per day summed, `a`'s price version where both hold a day. */
export function addRequestDaily(
  a: Record<string, RequestCostMetrics>,
  b: Record<string, RequestCostMetrics>,
) {
  const sum = { ...a };

  for (const [date, request] of Object.entries(b)) {
    const own = sum[date];
    sum[date] = own ? {
      pricedRequests: own.pricedRequests + request.pricedRequests, costMicros: own.costMicros + request.costMicros,
      cacheReadTokens: own.cacheReadTokens + request.cacheReadTokens,
      cacheEligibleInputTokens: own.cacheEligibleInputTokens + request.cacheEligibleInputTokens, priceVersion: own.priceVersion,
    } : request;
  }

  return sum;
}

/**
 * A daily snapshot entry read from a file: one with a string `date` and numeric `prompts` and `durationMs`. A
 * snapshot from before costs were kept per day holds them as session fields (`pricedRequests` and the rest).
 */
const DailySnapshotEntrySchema = z.object({
  date: z.string(),
  prompts: z.number(),
  durationMs: z.number(),
  succeeded: z.unknown().optional(),
  corrected: z.unknown().optional(),
  requestDaily: RequestDailySchema.optional(),
  sessionCacheReadTokens: z.number().optional().catch(undefined),
  sessionCacheEligibleTokens: z.number().optional().catch(undefined),
  ...RequestCostEntrySchema.shape,
}).transform((value): DailySessionSnapshot => {
  // A snapshot from before costs were kept per day: read its session fields as
  // the costs of the session's day, as the delta does.
  const { pricedRequests, costMicros, cacheReadTokens, cacheEligibleInputTokens, priceVersion } = value;

  const requestDaily = value.requestDaily
    ?? (pricedRequests || costMicros || cacheReadTokens || cacheEligibleInputTokens
      ? { [value.date]: { pricedRequests, costMicros, cacheReadTokens, cacheEligibleInputTokens, priceVersion } }
      : {});

  const snapshot: DailySessionSnapshot = {
    date: value.date, prompts: value.prompts, durationMs: value.durationMs,
    succeeded: value.succeeded === 1 ? 1 : 0,
    corrected: value.corrected === 1 ? 1 : 0,
    requestDaily,
  };

  if (value.sessionCacheReadTokens !== undefined) snapshot.sessionCacheReadTokens = value.sessionCacheReadTokens;

  if (value.sessionCacheEligibleTokens !== undefined) snapshot.sessionCacheEligibleTokens = value.sessionCacheEligibleTokens;

  return snapshot;
});

/** A daily snapshot entry read from a file, or undefined when it is not one. */
export const parseDailySnapshot = DailySnapshotEntrySchema.optional().catch(undefined).parse;

/** A reported snapshot's request costs per day, from its session-level fields if it predates them. */
function reportedRequestDaily(previous: DailySessionSnapshot | undefined): Record<string, RequestCostMetrics> {
  return previous?.requestDaily ?? (
    previous?.pricedRequests || previous?.costMicros || previous?.cacheReadTokens || previous?.cacheEligibleInputTokens
      ? { [previous.date]: {
        pricedRequests: previous.pricedRequests ?? 0,
        costMicros: previous.costMicros ?? 0,
        cacheReadTokens: previous.cacheReadTokens ?? 0,
        cacheEligibleInputTokens: previous.cacheEligibleInputTokens ?? 0,
        priceVersion: previous.priceVersion ?? '',
      } }
      : {}
  );
}

interface SessionCacheTokens {
  read: number;
  eligible: number;
}

/**
 * A reported snapshot's session cache tokens. A session reported under the old
 * code has no sessionCache* fields but does have requestDaily cache: summed as
 * the baseline, so the first post-upgrade report doesn't re-add counted tokens.
 */
function reportedSessionCache(
  previous: DailySessionSnapshot | undefined,
  requestDaily: Record<string, RequestCostMetrics>,
): SessionCacheTokens {
  return {
    read: previous?.sessionCacheReadTokens ?? Object.values(requestDaily).reduce((sum, r) => sum + r.cacheReadTokens, 0),
    eligible: previous?.sessionCacheEligibleTokens
      ?? Object.values(requestDaily).reduce((sum, r) => sum + r.cacheEligibleInputTokens, 0),
  };
}

/** A run's share of a snapshot, and what remains of it for the other runs. */
export interface DailySessionSplit {
  taken: DailySessionSnapshot;
  left: DailySessionSnapshot;
}

/**
 * `run`'s share of `left`, what remains of the snapshot an earlier release kept
 * for all the runs of one session ID: each counter up to the run's own. The
 * sum's success and correction flags are not any one run's (a successful run
 * and an interrupted one sum to unsuccessful), so each run takes its own and
 * reports no status change: that release already counted the sum's.
 */
export function takeDailySession(
  run: DailySessionSnapshot,
  left: DailySessionSnapshot,
): DailySessionSplit {
  const upTo = (own: number, rest: number) => Math.max(0, Math.min(own, rest));
  const leftDaily = reportedRequestDaily(left);
  const leftCache = reportedSessionCache(left, leftDaily);
  const takenDaily: Record<string, RequestCostMetrics> = {};
  const restDaily = { ...leftDaily };

  for (const [date, request] of Object.entries(run.requestDaily)) {
    const rest = leftDaily[date];

    if (!rest) continue;

    const taken: RequestCostMetrics = {
      pricedRequests: upTo(request.pricedRequests, rest.pricedRequests),
      costMicros: upTo(request.costMicros, rest.costMicros),
      cacheReadTokens: upTo(request.cacheReadTokens, rest.cacheReadTokens),
      cacheEligibleInputTokens: upTo(request.cacheEligibleInputTokens, rest.cacheEligibleInputTokens),
      priceVersion: rest.priceVersion,
    };

    takenDaily[date] = taken;
    restDaily[date] = {
      pricedRequests: rest.pricedRequests - taken.pricedRequests,
      costMicros: rest.costMicros - taken.costMicros,
      cacheReadTokens: rest.cacheReadTokens - taken.cacheReadTokens,
      cacheEligibleInputTokens: rest.cacheEligibleInputTokens - taken.cacheEligibleInputTokens,
      priceVersion: rest.priceVersion,
    };
  }

  const prompts = upTo(run.prompts, left.prompts);
  const durationMs = upTo(run.durationMs, left.durationMs);
  const cacheRead = upTo(run.sessionCacheReadTokens ?? 0, leftCache.read);
  const cacheEligible = upTo(run.sessionCacheEligibleTokens ?? 0, leftCache.eligible);

  return {
    taken: {
      date: run.date, prompts, durationMs, succeeded: run.succeeded, corrected: run.corrected,
      requestDaily: takenDaily, sessionCacheReadTokens: cacheRead, sessionCacheEligibleTokens: cacheEligible,
    },
    left: {
      date: left.date, prompts: left.prompts - prompts, durationMs: left.durationMs - durationMs,
      succeeded: left.succeeded, corrected: left.corrected, requestDaily: restDaily,
      sessionCacheReadTokens: leftCache.read - cacheRead, sessionCacheEligibleTokens: leftCache.eligible - cacheEligible,
    },
  };
}

/** The daily stats a report adds, and the snapshots it reported them from. */
export interface DailyStatsDelta {
  delta: Record<string, DailyUserStats>;
  nextReported: ReportedDailySessions;
}

/** Compute idempotent daily deltas while keeping resumed work on the first Stop day. */
export function computeDailyStatsDelta(
  current: Map<string, DailySessionSnapshot>,
  reported: ReportedDailySessions,
): DailyStatsDelta {
  const delta: Record<string, DailyUserStats> = {};
  const nextReported: ReportedDailySessions = {};

  for (const [sessionId, snapshot] of current) {
    const previous = reported[sessionId];
    const date = previous?.date ?? snapshot.date;
    const bucket = delta[date] ?? emptyDaily();

    if (!previous) {
      bucket.sessionsEnded += 1;
    }

    // Signed, not positiveDelta: unlike the monotonic counters below, a
    // session can flip from succeeded to failed on a later report (resumed
    // after an interruption/correction), and that must claw back the earlier
    // sessionsSucceeded increment, not just skip adding a new one (#473).
    bucket.sessionsSucceeded += snapshot.succeeded - (previous?.succeeded ?? 0);
    bucket.promptTurns += positiveDelta(snapshot.prompts, previous?.prompts);
    bucket.durationMs += positiveDelta(snapshot.durationMs, previous?.durationMs);
    bucket.sessionsCorrected += positiveDelta(snapshot.corrected, previous?.corrected);
    delta[date] = bucket;

    const previousDaily = reportedRequestDaily(previous);
    // Cache-read share is pricing-independent: fold session-level cache tokens onto
    // the firstStop day (like prompts/duration), so it works even when the model
    // can't be priced.
    const prevCache = reportedSessionCache(previous, previousDaily);
    bucket.cacheReadTokens += positiveDelta(snapshot.sessionCacheReadTokens ?? 0, prevCache.read);
    bucket.cacheEligibleInputTokens += positiveDelta(snapshot.sessionCacheEligibleTokens ?? 0, prevCache.eligible);
    delta[date] = bucket;

    // Cost stays per-requestDate from pricing; cache no longer flows through here.
    for (const [requestDate, request] of Object.entries(snapshot.requestDaily)) {
      const previousRequest = previousDaily[requestDate];
      const requestBucket = delta[requestDate] ?? emptyDaily();
      requestBucket.pricedRequests += positiveDelta(request.pricedRequests, previousRequest?.pricedRequests);
      requestBucket.costMicros += positiveDelta(request.costMicros, previousRequest?.costMicros);
      requestBucket.priceVersion = request.priceVersion;
      delta[requestDate] = requestBucket;
    }

    nextReported[sessionId] = { ...snapshot, date };
  }

  return { delta, nextReported };
}

export function mergeDailyStats(
  existing: Record<string, DailyUserStats> | undefined,
  delta: Record<string, DailyUserStats>,
) {
  const merged = { ...existing };

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

/** The trend of the last seven days, and of the seven before them. */
export interface TrendWindow {
  current: TrendPeriod;
  previous: TrendPeriod;
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
): TrendWindow {
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

/** A period's average session cost, over the sessions with priced requests. */
export interface SessionCostPeriod {
  avgSessionCostMicros: number | null;
  pricedSessions: number;
}

/** The session costs of the last seven days, and of the seven before them. */
export interface SessionCostWindow {
  current: SessionCostPeriod;
  previous: SessionCostPeriod;
}

/** Session-cost cohorts use the first Stop day, including the session's known request costs.
 * Sessions with no priced requests are excluded, rather than treated as free.
 * Kept separate from request-day digest totals for backwards compatibility.
 */
export function summarizeSessionCosts(sessions: Map<string, DailySessionSnapshot>, now = new Date()): SessionCostWindow {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
  const currentStart = end - 7 * 86_400_000;
  const previousStart = currentStart - 7 * 86_400_000;
  const totals = { current: { cost: 0, count: 0 }, previous: { cost: 0, count: 0 } };

  for (const session of sessions.values()) {
    const day = Date.parse(`${session.date}T00:00:00Z`);

    if (!Number.isFinite(day) || day < previousStart || day >= end) continue;
    const requests = Object.values(session.requestDaily);
    const priced = requests.reduce((sum, request) => sum + request.pricedRequests, 0);

    if (priced <= 0) continue;
    const period = day >= currentStart ? totals.current : totals.previous;
    period.count++;
    period.cost += requests.reduce((sum, request) => sum + request.costMicros, 0);
  }

  const summarize = (period: { cost: number; count: number }) => ({
    avgSessionCostMicros: period.count ? period.cost / period.count : null,
    pricedSessions: period.count,
  });

  return { current: summarize(totals.current), previous: summarize(totals.previous) };
}
