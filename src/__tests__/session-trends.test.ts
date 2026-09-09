import { describe, expect, it } from 'vitest';

import {
  aggregateDailySessions,
  computeDailyStatsDelta,
  mergeDailyStats,
  summarizeTrendWindow,
} from '../session-trends.js';
import type { DashboardEvent, DailyUserStats } from '../types.js';

describe('daily session trends', () => {
  it('freezes a session into its first Stop UTC day and uses active time only', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: '2026-09-01T23:58:00Z', sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: '2026-09-01T23:59:00Z', sessionId: 's1', tool: 'claude' },
      {
        type: 'stop', timestamp: '2026-09-02T00:01:00Z', sessionId: 's1', tool: 'claude',
        prompts: 1,
        tokens: { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 },
        requestMetrics: { pricedRequests: 1, costMicros: 530, cacheReadTokens: 300, cacheEligibleInputTokens: 440, priceVersion: 'test' },
      },
      // A resumed event after a long idle gap adds no active duration.
      { type: 'tool_use', timestamp: '2026-09-02T01:00:00Z', sessionId: 's1', tool: 'claude' },
    ];

    const sessions = aggregateDailySessions(events);
    expect(sessions.get('s1')).toMatchObject({
      date: '2026-09-02',
      prompts: 1,
      durationMs: 3 * 60_000,
      succeeded: 1,
      corrected: 0,
      pricedRequests: 1,
      costMicros: 530,
    });
  });

  it('reports monotonic deltas and keeps resumed work on the original day', () => {
    const first = new Map([
      ['s1', { date: '2026-09-02', prompts: 1, durationMs: 60_000, succeeded: 1 as const, corrected: 0 as const, pricedRequests: 1, costMicros: 100, cacheReadTokens: 20, cacheEligibleInputTokens: 100, priceVersion: 'v1' }],
    ]);
    const initial = computeDailyStatsDelta(first, {});
    expect(initial.delta['2026-09-02']).toMatchObject({ sessionsEnded: 1, sessionsSucceeded: 1, promptTurns: 1 });

    const resumed = new Map([
      ['s1', { ...first.get('s1')!, prompts: 3, durationMs: 180_000, pricedRequests: 2, costMicros: 250 }],
    ]);
    const second = computeDailyStatsDelta(resumed, initial.nextReported);
    expect(second.delta['2026-09-02']).toMatchObject({
      sessionsEnded: 0,
      sessionsSucceeded: 0,
      promptTurns: 2,
      durationMs: 120_000,
      pricedRequests: 1,
      costMicros: 150,
    });
  });

  it('compares the latest seven UTC days with the prior seven days', () => {
    const daily: Record<string, DailyUserStats> = {
      '2026-08-27': { sessionsEnded: 10, sessionsSucceeded: 5, promptTurns: 80, durationMs: 600_000, sessionsCorrected: 4, pricedRequests: 10, costMicros: 1_000_000, cacheReadTokens: 20, cacheEligibleInputTokens: 100 },
      '2026-09-03': { sessionsEnded: 10, sessionsSucceeded: 8, promptTurns: 50, durationMs: 300_000, sessionsCorrected: 2, pricedRequests: 10, costMicros: 500_000, cacheReadTokens: 60, cacheEligibleInputTokens: 100 },
    };

    const summary = summarizeTrendWindow(daily, new Date('2026-09-09T12:00:00Z'));
    expect(summary.current.successRate).toBe(0.8);
    expect(summary.previous.successRate).toBe(0.5);
    expect(summary.current.avgPrompts).toBe(5);
    expect(summary.current.avgRequestCostMicros).toBe(50_000);
    expect(summary.current.cacheReadShare).toBe(0.6);
    expect(summary.current.correctionRate).toBe(0.2);
  });

  it('merges daily deltas without dropping existing dates', () => {
    const merged = mergeDailyStats(
      { '2026-09-01': { sessionsEnded: 1, sessionsSucceeded: 1, promptTurns: 1, durationMs: 1, sessionsCorrected: 0, pricedRequests: 0, costMicros: 0, cacheReadTokens: 0, cacheEligibleInputTokens: 0 } },
      { '2026-09-02': { sessionsEnded: 1, sessionsSucceeded: 0, promptTurns: 2, durationMs: 2, sessionsCorrected: 1, pricedRequests: 0, costMicros: 0, cacheReadTokens: 0, cacheEligibleInputTokens: 0 } },
    );
    expect(Object.keys(merged)).toEqual(['2026-09-01', '2026-09-02']);
  });
});
