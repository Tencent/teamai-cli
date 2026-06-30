import { describe, it, expect } from 'vitest';
import { summarizeInterventions } from '../digest.js';
import type { UserStats } from '../types.js';

function user(username: string, iv?: UserStats['interventions']): UserStats {
  return { username, updatedAt: '2026-06-24T00:00:00Z', skills: {}, interventions: iv };
}

describe('summarizeInterventions', () => {
  it('returns null when no user has reported interventions', () => {
    expect(summarizeInterventions([user('a'), user('b')])).toBeNull();
  });

  it('ignores users with zero reported sessions', () => {
    const stats = [user('a', { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 })];
    expect(summarizeInterventions(stats)).toBeNull();
  });

  it('aggregates totals and team average across users', () => {
    const stats = [
      user('alice', { sessions: 10, interrupt: 2, toolReject: 1, correction: 1 }), // total 4, rate 0.4
      user('bob', { sessions: 5, interrupt: 5, toolReject: 0, correction: 5 }),     // total 10, rate 2.0
    ];
    const s = summarizeInterventions(stats)!;
    expect(s.totalSessions).toBe(15);
    expect(s.totalInterventions).toBe(14);
    expect(s.interrupt).toBe(7);
    expect(s.toolReject).toBe(1);
    expect(s.correction).toBe(6);
    expect(s.avgPerSession).toBeCloseTo(14 / 15);
  });

  it('ranks users by intervention rate descending', () => {
    const stats = [
      user('alice', { sessions: 10, interrupt: 2, toolReject: 1, correction: 1 }), // rate 0.4
      user('bob', { sessions: 5, interrupt: 5, toolReject: 0, correction: 5 }),     // rate 2.0
    ];
    const s = summarizeInterventions(stats)!;
    expect(s.ranked[0].username).toBe('bob');
    expect(s.ranked[0].rate).toBeCloseTo(2.0);
    expect(s.ranked[1].username).toBe('alice');
  });
});
