import { describe, it, expect } from 'vitest';
import { computeInterventionDelta, mergeInterventionStats } from '../team-push.js';
import type { UserInterventionStats } from '../types.js';

type IvMap = Map<string, { interrupt: number; toolReject: number; correction: number }>;

function mapOf(entries: Record<string, { interrupt: number; toolReject: number; correction: number }>): IvMap {
  return new Map(Object.entries(entries));
}

describe('computeInterventionDelta', () => {
  it('counts a brand-new session fully and bumps the session count', () => {
    const current = mapOf({ s1: { interrupt: 2, toolReject: 1, correction: 0 } });
    const { delta, nextReported } = computeInterventionDelta(current, {});
    expect(delta).toEqual({ sessions: 1, interrupt: 2, toolReject: 1, correction: 0 });
    expect(nextReported).toEqual({ s1: { interrupt: 2, toolReject: 1, correction: 0 } });
  });

  it('reports zero delta when nothing changed (idempotent)', () => {
    const snap = { s1: { interrupt: 2, toolReject: 1, correction: 0 } };
    const { delta } = computeInterventionDelta(mapOf(snap), snap);
    expect(delta).toEqual({ sessions: 0, interrupt: 0, toolReject: 0, correction: 0 });
  });

  it('reports only the positive change since last report', () => {
    const current = mapOf({ s1: { interrupt: 5, toolReject: 2, correction: 3 } });
    const reported = { s1: { interrupt: 2, toolReject: 2, correction: 1 } };
    const { delta } = computeInterventionDelta(current, reported);
    expect(delta).toEqual({ sessions: 0, interrupt: 3, toolReject: 0, correction: 2 });
  });

  it('never produces negative deltas if a snapshot shrinks', () => {
    const current = mapOf({ s1: { interrupt: 1, toolReject: 0, correction: 0 } });
    const reported = { s1: { interrupt: 3, toolReject: 0, correction: 0 } };
    const { delta } = computeInterventionDelta(current, reported);
    expect(delta.interrupt).toBe(0);
  });

  it('next snapshot keeps only sessions still present in events', () => {
    const current = mapOf({ s2: { interrupt: 1, toolReject: 0, correction: 0 } });
    const reported = { s1: { interrupt: 9, toolReject: 9, correction: 9 } };
    const { delta, nextReported } = computeInterventionDelta(current, reported);
    // s1 already compacted away — not re-counted, dropped from snapshot
    expect(delta.sessions).toBe(1);
    expect(nextReported).toEqual({ s2: { interrupt: 1, toolReject: 0, correction: 0 } });
  });
});

describe('mergeInterventionStats', () => {
  it('initializes from undefined existing', () => {
    const delta: UserInterventionStats = { sessions: 2, interrupt: 1, toolReject: 0, correction: 3 };
    expect(mergeInterventionStats(undefined, delta)).toEqual(delta);
  });

  it('accumulates onto existing totals', () => {
    const existing: UserInterventionStats = { sessions: 5, interrupt: 4, toolReject: 2, correction: 1 };
    const delta: UserInterventionStats = { sessions: 1, interrupt: 0, toolReject: 3, correction: 2 };
    expect(mergeInterventionStats(existing, delta)).toEqual({
      sessions: 6, interrupt: 4, toolReject: 5, correction: 3,
    });
  });
});
