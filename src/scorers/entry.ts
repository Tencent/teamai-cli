/**
 * Open judge work is never stored. An entry is one (scorer, subject) the facts say should be judged, and its state is
 * computed from the labels and attempts that name it, on every read.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';
import type { AttemptRecord, JudgeFailureCode, LeasedAttempt } from './attempts.js';
import type { RunSubject, ScoreLabel } from './label.js';

/** `s` + 13 hex of sha256 over (scorer, subject): the same on every read and every machine. */
export function entryIdOf(scorer: string, subject: RunSubject): string {
  return `s${createHash('sha256').update(canonicalJson({ scorer, subject })).digest('hex').slice(0, 13)}`;
}

const LEASE_REF = /^(s[0-9a-f]{13})\/(a[0-9a-f]{8})$/;

/** Whether `value` is a judge lease ref, `<entryId>/<attemptId>`. */
export function isLeaseRef(value: string): boolean {
  return LEASE_REF.test(value);
}

export function parseLeaseRef(value: string): { entry: string; attempt: string } | undefined {
  const match = LEASE_REF.exec(value);
  return match?.[1] && match[2] ? { entry: match[1], attempt: match[2] } : undefined;
}

export function leaseRefOf(attempt: Pick<AttemptRecord, 'entry' | 'attempt'>): string {
  return `${attempt.entry}/${attempt.attempt}`;
}

/** An entry is not offered once its run has not changed for this long. */
export const ENTRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const LEASE_TTL_MS = 30 * 60 * 1000;
/** Leases that may lapse before the entry fails `lease_expired`: the fourth lapse fails it. */
export const LEASE_LAPSES_ALLOWED = 3;

export type EntryState =
  | { kind: 'open' }
  | { kind: 'leased'; attempt: LeasedAttempt }
  | { kind: 'labelled' }
  | { kind: 'failed'; code: JudgeFailureCode }
  | { kind: 'expired' };

/** Whether `attempt` is a lease whose time ran out. */
export function hasLapsed(attempt: AttemptRecord, now: string): boolean {
  return attempt.status === 'leased' && attempt.expiresAt <= now;
}

/**
 * The state of one entry, first match wins: a model label or a succeeded attempt, a live lease, a failed attempt, too
 * many lapsed leases, a run that last changed outside the window, else open. A hand label never closes a model entry.
 * A request (`requestedAt`) sets aside the labels and settled attempts before it, and opens a new window.
 */
export function entryState(facts: {
  labels: readonly ScoreLabel[];
  attempts: readonly AttemptRecord[];
  subjectChangedAt: string;
  requestedAt?: string;
  now: string;
}): EntryState {
  const { now, requestedAt = '' } = facts;
  const labels = facts.labels.filter((label) => label.scoredAt >= requestedAt);
  const attempts = facts.attempts.filter((attempt) => attempt.leasedAt >= requestedAt || (attempt.status === 'leased' && !hasLapsed(attempt, now)));
  if (labels.some((label) => label.judge.kind === 'model') || attempts.some((attempt) => attempt.status === 'succeeded')) {
    return { kind: 'labelled' };
  }
  const live = attempts.find((attempt): attempt is LeasedAttempt => attempt.status === 'leased' && !hasLapsed(attempt, now));
  if (live) return { kind: 'leased', attempt: live };
  const failed = attempts.find((attempt) => attempt.status === 'failed');
  if (failed?.status === 'failed') return { kind: 'failed', code: failed.code };
  if (attempts.filter((attempt) => hasLapsed(attempt, now)).length > LEASE_LAPSES_ALLOWED) return { kind: 'failed', code: 'lease_expired' };
  if (Math.max(Date.parse(facts.subjectChangedAt), Date.parse(requestedAt) || 0) + ENTRY_WINDOW_MS <= Date.parse(now)) return { kind: 'expired' };
  return { kind: 'open' };
}
