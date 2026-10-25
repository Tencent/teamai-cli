/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { AttemptRecord, LeasedAttempt } from '../scorers/attempts.js';
import type { SessionLabelContext } from '../scorers/label.js';

const base = {
  attempt: 'a00000000', entry: 's0000000000000', scorer: 'review', rubric: { sourceHash: 'h' },
  driver: { kind: 'local', machine: 'm', workspace: '/w' },
  judge: { tool: 'claude', by: 'scorer', isolation: 'verified', access: 'read' },
  leasedAt: '2026-10-25T00:00:00.000Z', expiresAt: '2026-10-25T00:30:00.000Z',
} as const;
const run = { runId: 'r', step: 's', pass: 1 };
const session = { platform: 'claude-code', sessionId: 'x' };
const context: SessionLabelContext = { used: { skills: [] }, prompt: 'Add retries' };
const settled = { settledAt: base.leasedAt };

export const leasedSession: LeasedAttempt = { ...base, status: 'leased', source: 'session', subject: session, session: context };

// @ts-expect-error a session lease carries the label context it was taken with
export const leasedWithoutContext: LeasedAttempt = { ...base, status: 'leased', source: 'session', subject: session };

// @ts-expect-error a succeeded session attempt carries the context its label was built from
export const succeededWithoutContext: AttemptRecord = { ...base, ...settled, status: 'succeeded', source: 'session', subject: session, labelId: 'l', verdict: { label: 'good', score: 1, passed: true, version: 'v' } };

// @ts-expect-error a run attempt never carries session context
export const runWithContext: LeasedAttempt = { ...base, status: 'leased', source: 'workflow', subject: run, session: context };

// @ts-expect-error a session attempt cannot name a run subject
export const sessionWithRunSubject: LeasedAttempt = { ...base, status: 'leased', source: 'session', subject: run, session: context };

/** The one place a context may be absent: a session that could not be read before its lease. */
export const unreadable: AttemptRecord = { ...base, ...settled, status: 'failed', code: 'evidence_empty', source: 'session', subject: session };

// @ts-expect-error a session judge that failed had a lease, so it kept the context
export const judgeFailedWithoutContext: AttemptRecord = { ...base, ...settled, status: 'failed', code: 'judge_failed', source: 'session', subject: session };
