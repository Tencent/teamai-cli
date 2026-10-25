import { describe, expect, it } from 'vitest';
import type { RunAttempt } from '../scorers/attempts.js';
import { entryIdOf, entryState, isLeaseRef, leaseRefOf, parseLeaseRef } from '../scorers/entry.js';
import type { ScoreLabel } from '../scorers/label.js';
import { isSampled } from '../scorers/sampling.js';

const subject = { runId: 'r0123456789abcdef', step: 'review', pass: 1 };
const now = '2026-10-22T12:00:00.000Z';
const minutes = (count: number): string => new Date(Date.parse(now) + count * 60_000).toISOString();
const days = (count: number): string => new Date(Date.parse(now) + count * 24 * 3_600_000).toISOString();

function leased(attempt: string, expiresAt: string): RunAttempt {
  return {
    status: 'leased', attempt, entry: entryIdOf('q', subject), scorer: 'q', rubric: { sourceHash: 'h' }, subject,
    driver: { kind: 't3', machine: 'm', workspace: '/w' }, judge: { tool: 'claude', by: 'tool_default', isolation: 'verified', access: 'read' },
    leasedAt: minutes(-60), expiresAt,
  };
}

function label(kind: 'model' | 'human'): ScoreLabel {
  return {
    scorer: 'q', rubric: { sourceHash: 'h' }, label: 'good', score: 1, passed: true, source: 'workflow', subject,
    judge: kind === 'model' ? { kind, tool: 'claude', isolation: 'verified', access: 'read' } : { kind },
    scoredAt: now,
  };
}

describe('sampling', () => {
  it('gives the same answer for the same scorer and pass, never at 0 and always at 100', () => {
    const passes = Array.from({ length: 400 }, (_, index) => ({ ...subject, pass: index + 1 }));
    expect(passes.map((pass) => isSampled('q', pass, 25))).toEqual(passes.map((pass) => isSampled('q', pass, 25)));
    expect(passes.filter((pass) => isSampled('q', pass, 0))).toEqual([]);
    expect(passes.filter((pass) => isSampled('q', pass, 100))).toHaveLength(400);
    const sampled = passes.filter((pass) => isSampled('q', pass, 25)).length;
    expect(sampled).toBeGreaterThan(60);
    expect(sampled).toBeLessThan(140);
  });

  it('samples each scorer on its own', () => {
    const passes = Array.from({ length: 200 }, (_, index) => ({ ...subject, pass: index + 1 }));
    expect(passes.map((pass) => isSampled('a', pass, 50))).not.toEqual(passes.map((pass) => isSampled('b', pass, 50)));
  });
});

describe('entry ids and lease refs', () => {
  it('names an entry by scorer and subject alone', () => {
    expect(entryIdOf('q', subject)).toMatch(/^s[0-9a-f]{13}$/);
    expect(entryIdOf('q', { ...subject })).toBe(entryIdOf('q', subject));
    expect(entryIdOf('q', { ...subject, pass: 2 })).not.toBe(entryIdOf('q', subject));
    const ref = leaseRefOf({ entry: entryIdOf('q', subject), attempt: 'a0123abcd' });
    expect(isLeaseRef(ref)).toBe(true);
    expect(parseLeaseRef(ref)).toEqual({ entry: entryIdOf('q', subject), attempt: 'a0123abcd' });
    expect(isLeaseRef('a0123abcd')).toBe(false);
  });
});

describe('entryState', () => {
  const facts = { labels: [], attempts: [], subjectChangedAt: now, now };

  it.each([
    ['open with no facts', facts, 'open'],
    ['labelled by a model label', { ...facts, labels: [label('model')] }, 'labelled'],
    ['open beside a hand label, which never closes model work', { ...facts, labels: [label('human')] }, 'open'],
    ['leased while a lease is live', { ...facts, attempts: [leased('a00000001', minutes(10))] }, 'leased'],
    ['open again after three lapsed leases', { ...facts, attempts: ['a00000001', 'a00000002', 'a00000003'].map((id) => leased(id, minutes(-1))) }, 'open'],
    ['failed on the fourth lapse', { ...facts, attempts: ['a00000001', 'a00000002', 'a00000003', 'a00000004'].map((id) => leased(id, minutes(-1))) }, 'failed'],
    ['open 13 days after the run last changed', { ...facts, subjectChangedAt: days(-13) }, 'open'],
    ['expired 14 days after the run last changed', { ...facts, subjectChangedAt: days(-14) }, 'expired'],
    ['open when asked after a model label', { ...facts, labels: [label('model')], requestedAt: minutes(1), now: minutes(2) }, 'open'],
    ['open when asked after a failed attempt', { ...facts, attempts: [{ ...leased('a00000001', minutes(-30)), status: 'failed', settledAt: minutes(-40), code: 'judge_failed' }], requestedAt: minutes(-1) }, 'open'],
    ['open when asked 14 days after the run last changed', { ...facts, subjectChangedAt: days(-14), requestedAt: minutes(-1) }, 'open'],
    ['leased when asked while a lease is live', { ...facts, attempts: [leased('a00000001', minutes(10))], requestedAt: minutes(-1) }, 'leased'],
  ] as const)('is %s', (_name, input, kind) => {
    expect(entryState(input).kind).toBe(kind);
  });

  it('fails the fourth lapse as lease_expired', () => {
    const attempts = ['a00000001', 'a00000002', 'a00000003', 'a00000004'].map((id) => leased(id, minutes(-1)));
    expect(entryState({ ...facts, attempts })).toEqual({ kind: 'failed', code: 'lease_expired' });
  });
});
