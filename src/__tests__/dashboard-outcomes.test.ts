import { describe, it, expect } from 'vitest';
import { SessionOutcomes } from '../session-outcomes.js';
import { WorkOutcomeSchema, type SessionOutcomeEvent } from '../outcomes.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const pr = WorkOutcomeSchema.parse({ kind: 'pr', url: 'https://github.com/acme/app/pull/42' });
const learning = WorkOutcomeSchema.parse({ kind: 'learning', id: 'retry-backoff-2026-10-24-p0x1za' });
const usage = { tokens: { input: 100, output: 20 }, interventions: 2 };

function counted(sessionId: string, daysAgo: number, extra: Partial<SessionOutcomeEvent> = {}): SessionOutcomeEvent {
  return {
    type: 'session_outcome', timestamp: new Date(NOW - daysAgo * DAY).toISOString(), sessionId, tool: 'claude', dataHomeKey: 'home-a',
    runMode: 'attended', outcomes: [], counted: usage, ...extra,
  };
}

describe('the dashboard summary of finished sessions (#1387)', () => {
  it('counts the scope\'s sessions the report counted in the last 30 days, and lists the latest first', () => {
    const summary = SessionOutcomes.summarize([
      counted('with-pr', 3, { outcomes: [pr, learning] }),
      counted('quiet', 1),
      counted('unattended', 2, { runMode: 'unattended', outcomes: [learning] }),
      counted('old', 31, { outcomes: [pr] }),
      counted('other-scope', 1, { dataHomeKey: 'home-b', outcomes: [pr] }),
      { type: 'session_outcome', timestamp: new Date(NOW).toISOString(), sessionId: 'live', dataHomeKey: 'home-a', outcomes: [learning] },
    ], { dataHomeKey: 'home-a', now: NOW });

    const row = { sessions: 1, ...usage };
    expect(summary).toEqual({
      sessions: 3,
      delivered: 2,
      rows: { attended: { pr: row, learning: row, none: row }, unattended: { learning: row } },
      recent: [
        { sessionId: 'quiet', tool: 'claude', runMode: 'attended', countedAt: new Date(NOW - DAY).toISOString(), outcomes: [], counted: usage },
        { sessionId: 'unattended', tool: 'claude', runMode: 'unattended', countedAt: new Date(NOW - 2 * DAY).toISOString(), outcomes: [learning], counted: usage },
        { sessionId: 'with-pr', tool: 'claude', runMode: 'attended', countedAt: new Date(NOW - 3 * DAY).toISOString(), outcomes: [pr, learning], counted: usage },
      ],
    });
  });

  it('counts every scope\'s sessions when no workspace is chosen', () => {
    const summary = SessionOutcomes.summarize([counted('a', 1), counted('b', 1, { dataHomeKey: 'home-b' })], { now: NOW });
    expect(summary.sessions).toBe(2);
  });
});
