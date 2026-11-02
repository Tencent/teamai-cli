/**
 * Open judge work is never stored. An entry is one (scorer, subject) the facts say should be judged, and its state is
 * computed from the labels and attempts that name it, on every read.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../utils/canonical-json.js';
import { JUDGE_FAILURES, type AttemptRecord, type JudgeFailureCode, type LeasedAttempt, type LeasedSessionAttempt } from './attempts.js';
import type { RunSubject, ScoreLabel, SessionSubject } from './label.js';

/** `s` + 13 hex of sha256 over (scorer, subject): the same on every read and every machine. */
export function entryIdOf(scorer: string, subject: RunSubject): string {
  return `s${createHash('sha256').update(canonicalJson({ scorer, subject })).digest('hex').slice(0, 13)}`;
}

/** `s` + 13 hex of sha256 over (scorer, rubric, session): a new rubric of the scorer is a new key, tried once of its own. */
export function sessionEntryIdOf(scorer: string, sourceHash: string, subject: SessionSubject): string {
  return `s${createHash('sha256').update(canonicalJson({ scorer, sourceHash, subject })).digest('hex').slice(0, 13)}`;
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
  /** `verdict`: the newest model label or succeeded attempt since the entry was last asked for. */
  | { kind: 'labelled'; verdict: { label: string; passed: boolean } }
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
  const answers = [
    ...labels.filter((label) => label.judge.kind === 'model').map(({ scoredAt, label, passed }) => ({ at: scoredAt, label, passed })),
    ...attempts.flatMap((attempt) => (attempt.status === 'succeeded' ? [{ at: attempt.settledAt, ...attempt.verdict }] : [])),
  ];
  const newest = answers.sort((left, right) => right.at.localeCompare(left.at))[0];
  if (newest) return { kind: 'labelled', verdict: { label: newest.label, passed: newest.passed } };
  const live = attempts.find((attempt): attempt is LeasedAttempt => attempt.status === 'leased' && !hasLapsed(attempt, now));
  if (live) return { kind: 'leased', attempt: live };
  const failed = attempts.find((attempt) => attempt.status === 'failed');
  if (failed?.status === 'failed') return { kind: 'failed', code: failed.code };
  if (attempts.filter((attempt) => hasLapsed(attempt, now)).length > LEASE_LAPSES_ALLOWED) return { kind: 'failed', code: 'lease_expired' };
  if (Math.max(Date.parse(facts.subjectChangedAt), Date.parse(requestedAt) || 0) + ENTRY_WINDOW_MS <= Date.parse(now)) return { kind: 'expired' };
  return { kind: 'open' };
}

export type SessionEntryState =
  | { kind: 'open' }
  | { kind: 'leased'; attempt: LeasedSessionAttempt }
  | { kind: 'labelled' }
  | { kind: 'tried' };

/**
 * The state of one session key, first match wins: a model label or a succeeded attempt, a live lease, any other attempt,
 * else open. A session is judged once: a release, a lapse or a failure never opens it again.
 */
export function sessionEntryState(facts: { labels: readonly ScoreLabel[]; attempts: readonly AttemptRecord[]; now: string }): SessionEntryState {
  const { attempts, now } = facts;
  if (facts.labels.some((label) => label.judge.kind === 'model') || attempts.some((attempt) => attempt.status === 'succeeded')) return { kind: 'labelled' };
  const live = liveSessionLease(attempts, now);
  if (live) return { kind: 'leased', attempt: live };
  return attempts.length > 0 ? { kind: 'tried' } : { kind: 'open' };
}

/** The live lease among a session key's `attempts` at `now`, when one holds the key. */
export function liveSessionLease(attempts: readonly AttemptRecord[], now: string): LeasedSessionAttempt | undefined {
  return attempts.find((attempt): attempt is LeasedSessionAttempt => attempt.source === 'session' && attempt.status === 'leased' && !hasLapsed(attempt, now));
}

/**
 * An entry of a run's `sampling: all` scorers as it stood when its steps ended, kept on the run (`run.verdicts`) so its
 * record is computed from the run alone. Here rather than beside the code that freezes it: the run store parses it on
 * load.
 */
export const EntryVerdictSchema = z.object({
  scorer: z.string().min(1),
  step: z.string().min(1),
  pass: z.number().int().positive(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('labelled'), label: z.string().min(1), passed: z.boolean() }).strict(),
    /** No label: the judge failed (its attempt's code), the entry expired, or the run ended first (`run_ended`). */
    z.object({ kind: z.literal('unscored'), because: z.enum([...JUDGE_FAILURES, 'expired', 'run_ended']) }).strict(),
  ]),
  /** What this install's attempts on the entry stated they cost, failed ones included; `complete: false` when one stated none. */
  scoringCost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).strict().optional(),
}).strict();
export type EntryVerdict = z.infer<typeof EntryVerdictSchema>;
