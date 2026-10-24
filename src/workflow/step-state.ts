import { z } from 'zod';
import { AgentObservationSchema, UsedSchema } from '../agent-observation.js';
import { DriverSchema } from '../driver-identity.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import { PrUrlSchema } from './pr-url.js';
import { UnenforcedSchema } from './requirements.js';
import type { RunState, StepLease, WorkflowFailure } from './types.js';
import type { WorkspaceMode } from './workspace.js';

const TokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cachedInput: z.number().optional(),
});

/**
 * Where a workflow's limits count from: when its timeout starts, and the tokens already spent under it, which its budget
 * does not count. A workflow step records it each time it starts; the run, when a retry reopens it.
 */
export const LimitsFromSchema = z.object({ at: z.string(), tokens: z.number() });
export type LimitsFrom = z.infer<typeof LimitsFromSchema>;

/** The tokens a released attempt spent, which a budget still counts once its step has nothing of the attempt. */
export const ReleasedTokensSchema = z.object({ step: z.string(), attempt: z.string(), tokens: TokenUsageSchema });
export type ReleasedTokens = z.infer<typeof ReleasedTokensSchema>;

/**
 * An attempt the engine stopped, whose driver may still report what it spent, whatever its step became since: the step,
 * the driver that held the lease, and when the engine stopped it, so a budget that started counting later does not pay.
 */
export const StoppedAttemptSchema = z.object({ attempt: z.string(), step: z.string(), driver: DriverSchema, stoppedAt: z.string() });
export type StoppedAttempt = z.infer<typeof StoppedAttemptSchema>;

const FailureSchema: z.ZodType<WorkflowFailure> = z.object({ code: z.string(), message: z.string() });

const SessionRefSchema = z.object({ tool: z.string().min(1), id: z.string().min(1) });

/** One entry of `RunState.sessionContinuations`: the session a step resumed, and the session it continued it in. */
export const SessionContinuationSchema = z.object({ from: SessionRefSchema, to: SessionRefSchema });
export type SessionContinuation = z.infer<typeof SessionContinuationSchema>;

const LeaseSessionSchema = SessionRefSchema.extend({ earlier: z.array(SessionRefSchema).optional() });

const LeaseSchema: z.ZodType<StepLease> = z.object({
  attempt: z.string(), revision: z.number(), driver: DriverSchema, session: LeaseSessionSchema.optional(),
  unenforced: z.array(UnenforcedSchema).optional(), expiresAt: z.string().optional(),
});

const ChangesSchema = z.object({
  branch: z.string(),
  base: z.string(),
  from: z.string(),
  to: z.string(),
  commits: z.array(z.string()),
});

/** What a read-only step inside a copy reports: the branch it ran on and the commit it read. It wrote nothing. */
export const ReadSchema = z.object({
  branch: z.string().min(1),
  base: z.string().min(1),
  commit: z.string().min(1),
});
export type StepRead = z.infer<typeof ReadSchema>;

/** What a driver reports about the attempt that settled a step. */
const report = {
  exitCode: z.number().optional(),
  message: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  tokens: TokenUsageSchema.optional(),
  changes: ChangesSchema.optional(),
  read: ReadSchema.optional(),
  /**
   * What the pass ran as (#1176), settled by the engine before it is saved. One this CLI cannot read, such as a newer
   * version's, reads as absent rather than making the run unreadable.
   */
  agent: AgentObservationSchema.optional().catch(undefined),
  /** The team skills the pass loaded, by name, as its driver reported them; absent when it reported none. */
  used: UsedSchema.optional().catch(undefined),
  /** The install whose `report` settled the attempt, so scoring knows which machine holds its session after a claim. */
  installId: z.string().optional(),
  /** The best-effort requirements the attempt's driver could not enforce. */
  unenforced: z.array(UnenforcedSchema).optional(),
};

export const OutcomeSchema = z.enum(['success', 'failed', 'timeout', 'skipped', 'cancelled']);
/** The outcome an expression reads of a settled step. */
export type VisibleOutcome = z.infer<typeof OutcomeSchema>;

const ResultsSchema = z.array(z.object({
  item: z.unknown(),
  outcome: OutcomeSchema,
  outputs: z.unknown().optional(),
  branch: z.string().optional(),
}));
export type ItemResult = z.infer<typeof ResultsSchema>[number];

const AnswerSchema = z.object({
  choice: z.string(),
  note: z.string().optional(),
  at: z.string(),
  channel: z.enum(['tty', 'cli', 'driver', 'dashboard', 'auto_approve', 'no_hitl']),
  agent: z.boolean(),
  /** Identity of the UI that carried the person's answer, kept locally. */
  driver: DriverSchema.optional(),
});
/** The answer and provenance retained for one pass of a step with HITL. */
export type HitlAnswer = z.infer<typeof AnswerSchema>;

/**
 * What a step that delivers hands to delivery once its agent succeeded: the branch, the commit that branch must hold on
 * origin, and a URL its driver reported and the engine kept. The target is not kept; it follows from the run.
 */
const DeliverySchema = z.object({ branch: z.string().min(1), head: z.string().min(1), reported: PrUrlSchema.optional() });
export type Delivery = z.infer<typeof DeliverySchema>;

/** One earlier pass of a step instance that a loop ran again. */
export const StepPassSchema = z.object({
  pass: z.number().int(),
  attempt: z.string().optional(),
  outcome: OutcomeSchema,
  outputs: z.unknown().optional(),
  end: z.string().optional(),
  results: ResultsSchema.optional(),
  failure: FailureSchema.optional(),
  ...report,
  /** What the pass delivered once its agent succeeded, so a pass whose delivery failed or was cancelled is still the agent's success. */
  delivery: DeliverySchema.optional(),
  /** The answer retained with this archived pass. */
  answer: AnswerSchema.optional(),
});
export type StepPass = z.infer<typeof StepPassSchema>;

/** A pass of a child or item instance that a loop removed from the run; `step` is its full path. */
export const ArchivedPassSchema = StepPassSchema.extend({
  step: z.string(),
  /** The step whose new pass archived this one, and that step's pass when it did. */
  within: z.object({ step: z.string(), pass: z.number().int() }).optional(),
});
export type ArchivedPass = z.infer<typeof ArchivedPassSchema>;

/**
 * What every step instance has. `id` is its path: a top-level step id, `<workflow step path>.<child step id>`
 * for a step inside a sub-workflow, such as `check.classify`, or `<id>[<n>]` for an item of a `for_each` step.
 */
const StepBaseSchema = z.object({
  id: z.string(),
  pass: z.number().int().optional(),
  passes: z.array(StepPassSchema).optional(),
  /** The current pass's answer, cleared only when that pass is replaced. */
  answer: AnswerSchema.optional(),
  item: z.unknown().optional(),
  /** The values `with` passed to the workflow this step runs, kept when that workflow declares inputs. */
  inputs: z.record(z.unknown()).optional(),
  iteration: z.number().int().optional(),
  round: z.number().int().optional(),
});
type StepBase = z.infer<typeof StepBaseSchema>;

/**
 * What a step that ran keeps. A file written before `settledAt` existed reads it as 0. `end` is the end the workflow
 * this step runs reached.
 */
const settledFields = {
  outputs: z.unknown().optional(),
  end: z.string().optional(),
  results: ResultsSchema.optional(),
  settledAt: z.number().int().default(0),
  attempt: z.string().optional(),
  /** Kept once the step settles, so a retry of a failed delivery delivers the same branch again. */
  delivery: DeliverySchema.optional(),
  ...report,
};

/**
 * One step instance. Unknown keys are dropped when a run file is read, so a step a 0.22.0 report released
 * reads as a clean `pending` step. That version wrote no `outcome` on a step the engine settled; it reads from `status`.
 * `waiting`: a ready HITL request with no answer, so nothing is leased yet.
 * `running`: a workflow step whose child steps are in the run and not all settled.
 */
const PendingSchema = StepBaseSchema.extend({ status: z.literal('pending') });
const WaitingSchema = StepBaseSchema.extend({ status: z.literal('waiting') });
/**
 * `expiresAt`: when the step's `timeout`, or that of the workflow file it runs, ends it. `limitsFrom`: where the budget of
 * the workflow it runs counts from. Both are set when it starts.
 */
const RunningSchema = StepBaseSchema.extend({ status: z.literal('running'), expiresAt: z.string().optional(), limitsFrom: LimitsFromSchema.optional() });
/** `delivering`: the agent succeeded and its work is on its branch; dependents wait until that branch has its pull request. */
const DeliveringSchema = StepBaseSchema.extend({ status: z.literal('delivering'), ...settledFields, delivery: DeliverySchema });
const SucceededSchema = StepBaseSchema.extend({
  status: z.literal('succeeded'), outcome: z.literal('success').default('success'), ...settledFields, loopFinal: z.boolean().optional(),
});
const FailedSchema = StepBaseSchema.extend({
  status: z.literal('failed'), outcome: z.literal('failed').default('failed'), ...settledFields, failure: FailureSchema.optional(),
});
const SkippedSchema = StepBaseSchema.extend({ status: z.literal('skipped'), settledAt: z.number().int().default(0) });
/** A step cancelled while it delivered keeps what its agent settled, as `delivering` holds it. */
const CancelledSchema = StepBaseSchema.extend({ status: z.literal('cancelled'), ...settledFields, failure: FailureSchema });

const LeasedSchema = StepBaseSchema.extend({ status: z.literal('leased'), attempt: z.string(), lease: LeaseSchema });
/**
 * A step as a run handed to another machine carries it. A leased step keeps its attempt and the kind of driver that
 * holds it, not that driver's machine or workspace, which mean nothing on the machine that takes the run.
 */
const HandedLeaseSchema = StepBaseSchema.extend({
  status: z.literal('leased'), attempt: z.string(), lease: z.object({ attempt: z.string(), revision: z.number(), driverKind: z.string() }),
});
/** Every status but `leased` is the same locally and in a snapshot, so a status added here reaches both unions. */
const SHARED_VARIANTS = [PendingSchema, WaitingSchema, RunningSchema, DeliveringSchema, SucceededSchema, FailedSchema, SkippedSchema, CancelledSchema] as const;

export const StepStateSchema = z.discriminatedUnion('status', [LeasedSchema, ...SHARED_VARIANTS]);
type ReadonlyId<T> = T extends unknown ? Omit<T, 'id'> & { readonly id: string } : never;
/** A step instance's `id` is read-only: the engine indexes instances by it, and every transition keeps it. */
export type StepState = ReadonlyId<z.infer<typeof StepStateSchema>>;

export const StepCheckpointSchema = z.discriminatedUnion('status', [HandedLeaseSchema, ...SHARED_VARIANTS]);
export type StepCheckpoint = ReadonlyId<z.infer<typeof StepCheckpointSchema>>;
/** A lease another machine held when the run was handed over. */
export type HandedLease = Extract<StepCheckpoint, { status: 'leased' }>;
type StepStatus = StepState['status'];

type StepIn<S extends StepStatus> = Extract<StepState, { status: S }>;
type PendingStep = StepIn<'pending'>;
export type LeasedStep = StepIn<'leased'>;
type RunningStep = StepIn<'running'>;
export type DeliveringStep = StepIn<'delivering'>;
type SucceededStep = StepIn<'succeeded'>;
type FailedStep = StepIn<'failed'>;
type SkippedStep = StepIn<'skipped'>;
type CancelledStep = StepIn<'cancelled'>;

type Settlement<T extends StepState> = Omit<T, keyof StepBase | 'status' | 'outcome'>;

const BASE_KEYS = Object.keys(StepBaseSchema.shape) as Array<keyof StepBase>;
const SETTLED_KEYS = Object.keys(settledFields) as Array<keyof typeof settledFields>;
const VISIBLE_OUTCOMES = { succeeded: 'success', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled' } as const;

/** The outcome expressions and records read of a settled step: a failure with code `timeout` reads as `timeout`. */
export function visibleOutcome(step: Extract<StepState, { status: keyof typeof VISIBLE_OUTCOMES }>): VisibleOutcome {
  return step.status === 'failed' && step.failure?.code === 'timeout' ? 'timeout' : VISIBLE_OUTCOMES[step.status];
}

/**
 * Replaces a step's fields in place with `next`, keeping the fields every step has, and returns it as its new variant.
 * In place, because `run.steps` holds the instance and the engine finds positions in it by identity.
 */
function become<T extends StepState>(state: StepState | HandedLease, next: Omit<T, keyof StepBase>): T {
  const fields = state as Record<string, unknown>;
  const kept = Object.fromEntries(BASE_KEYS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
  for (const key of Object.keys(fields)) delete fields[key];
  return Object.assign(fields, kept, next) as T;
}

/** A ready step with HITL waits without taking a lease. */
export function waitForAnswer(state: StepState): StepIn<'waiting'> {
  return become<StepIn<'waiting'>>(state, { status: 'waiting' });
}

/** Stores an answer and returns the step to pending so reconciliation can apply it. */
export function answerHitl(state: StepIn<'waiting'>, answer: HitlAnswer): PendingStep {
  return Object.assign(become<PendingStep>(state, { status: 'pending' }), { answer });
}

/** Reconsiders an unanswered waiting or skipped step in its current pass. */
export function resetPending(state: StepState): PendingStep {
  return become<PendingStep>(state, { status: 'pending' });
}

/** Restarts only the explicitly retried loop owner's iteration budget. */
export function resetIteration(state: StepState): void {
  delete state.iteration;
}

export function skip(state: StepState, settledAt: number): SkippedStep {
  return become<SkippedStep>(state, { status: 'skipped', settledAt });
}

/** A released lease returns the step to `pending` with nothing from the attempt. */
export function release(state: LeasedStep | HandedLease): PendingStep {
  return become<PendingStep>(state, { status: 'pending' });
}

export type UnleasedStep = Exclude<StepState, { status: 'leased' }>;

/**
 * A step of a run this machine takes over, which runs in workspace `mode`. A lease another machine held is released; one
 * that opened a copy of its own moves to its next pass, so it gets a new branch rather than the one that machine may have
 * pushed part of its work to. Every other step stays as it was.
 */
export function takeOver(step: StepCheckpoint, mode: WorkspaceMode | undefined): UnleasedStep {
  switch (step.status) {
    case 'leased':
      return mode === 'new' ? repend(release(step)) : release(step);
    case 'pending':
    case 'waiting':
    case 'running':
    case 'delivering':
    case 'succeeded':
    case 'failed':
    case 'skipped':
    case 'cancelled':
      return step;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

export function lease(state: StepState, held: StepLease): LeasedStep {
  return become<LeasedStep>(state, { status: 'leased', attempt: held.attempt, lease: held });
}

/**
 * A workflow step starts; `inputs` are the values its `with` passed, when that workflow declares inputs, and `limits`
 * when its timeout ends it and where its workflow's budget counts from.
 */
export function start(state: StepState, inputs?: Record<string, unknown>, limits: Pick<RunningStep, 'expiresAt' | 'limitsFrom'> = {}): RunningStep {
  const running = become<RunningStep>(state, { status: 'running', ...limits });
  if (inputs) running.inputs = inputs;
  return running;
}

export function succeed(state: StepState, settlement: Settlement<SucceededStep>): SucceededStep {
  return become<SucceededStep>(state, { status: 'succeeded', outcome: 'success', ...settlement });
}

/** The agent's work is settled and durable; the step succeeds once `delivery` has its pull request. */
export function startDelivery(state: StepState, settlement: Settlement<SucceededStep>, delivery: Delivery): DeliveringStep {
  return become<DeliveringStep>(state, { status: 'delivering', ...settlement, delivery });
}

/** A delivered step settles as its agent left it, at the revision the agent's report settled it. */
export function delivered(state: DeliveringStep): SucceededStep {
  const { id: _id, status: _status, ...settlement } = state;
  return succeed(state, settlement);
}

/** The failure codes only delivery gives a step, always after its agent succeeded. */
const DELIVERY_FAILURE_CODES = ['delivery_failed', 'protected_path'] as const;
export type DeliveryFailure = { code: (typeof DELIVERY_FAILURE_CODES)[number]; message: string };

/** A delivery that failed stops the step, keeping what its agent did and the branch a retry delivers again. */
export function deliveryFailed(state: DeliveringStep, failure: DeliveryFailure): FailedStep {
  const { id: _id, status: _status, ...settlement } = state;
  return fail(state, { ...settlement, message: failure.message, failure });
}

/** A failed delivery is retried in the same pass and attempt: the agent does not run again. */
export function redeliver(state: FailedStep, delivery: Delivery): DeliveringStep {
  const { id: _id, status: _status, outcome: _outcome, failure: _failure, message: _message, ...settlement } = state;
  return startDelivery(state, settlement, delivery);
}

export function fail(state: StepState, settlement: Settlement<FailedStep>): FailedStep {
  return become<FailedStep>(state, { status: 'failed', outcome: 'failed', ...settlement });
}

/** What a lease the engine stops leaves on its step: the invalidated attempt and what it did not enforce. */
function stoppedLease(state: StepState): { attempt?: string; unenforced?: StepLease['unenforced'] } {
  if (state.status !== 'leased') return {};
  return { attempt: state.attempt, ...(state.lease.unenforced ? { unenforced: state.lease.unenforced } : {}) };
}

/**
 * Stops the attempt of leased step `state` at `now`, before its step is cancelled or times out: a report of it is
 * answered `lease_cancelled`, and its own driver's tokens are still counted once (`countLateTokens`).
 */
export function stopAttempt(run: RunState, state: LeasedStep, now: string): void {
  (run.cancelledAttempts ??= []).push(state.attempt);
  (run.stoppedAttempts ??= []).push({ attempt: state.attempt, step: state.id, driver: state.lease.driver, stoppedAt: now });
}

/** A leased or running step whose deadline passed fails with `timeout`. */
export function timeOut(state: LeasedStep | RunningStep, failure: WorkflowFailure & { code: 'timeout' }, settledAt: number): FailedStep {
  return become<FailedStep>(state, { status: 'failed', outcome: 'failed', settledAt, ...stoppedLease(state), message: failure.message, failure });
}

/**
 * An open step is cancelled before it settles. A leased one keeps the attempt it no longer settles, and what it did not
 * enforce. A delivering one keeps what its agent settled, and what it delivered, since its agent succeeded whatever
 * becomes of the delivery.
 */
export function cancel(state: StepIn<'pending' | 'waiting' | 'leased' | 'running' | 'delivering'>, failure: WorkflowFailure, settledAt: number): CancelledStep {
  if (state.status === 'delivering') {
    const { id: _id, status: _status, ...settlement } = state;
    return become<CancelledStep>(state, { ...settlement, status: 'cancelled', failure });
  }
  return become<CancelledStep>(state, { status: 'cancelled', settledAt, ...stoppedLease(state), failure });
}

/** The current pass of a settled step, as `passes` keeps it once a loop runs the step again; undefined while it has not settled. */
export function passOf(state: StepState): StepPass | undefined {
  if (!settled(state)) return undefined;
  const outcome = visibleOutcome(state);
  return StepPassSchema.parse({ ...state, pass: state.pass ?? 1, outcome });
}

/**
 * The current pass of a step as its agent left it, which scorers judge: a step that delivers ran its agent to success,
 * so delivery never decides whether, or by which install, a pass is judged.
 */
export function agentPassOf(state: StepState): StepPass | undefined {
  return state.status === 'delivering' ? StepPassSchema.parse({ ...state, pass: state.pass ?? 1, outcome: 'success' }) : passOf(state);
}

/** Whether the agent of `pass` succeeded: it did, or only the delivery of what it wrote failed or was cancelled. */
export function agentSucceeded(pass: StepPass): boolean {
  const code: string | undefined = pass.failure?.code;
  return pass.outcome === 'success'
    || (pass.outcome === 'failed' && DELIVERY_FAILURE_CODES.some((delivery) => delivery === code))
    || (pass.outcome === 'cancelled' && pass.delivery !== undefined);
}

/**
 * A loop runs a settled step again: its current pass joins `passes`, and it waits as the next pass, with nothing of
 * the workflow it ran. `iteration` is the runs a loop owner has had so far.
 */
export function repend(state: StepState, iteration?: number): PendingStep {
  const current = passOf(state);
  const passes = [...state.passes ?? [], ...(current ? [current] : [])];
  const pass = (state.pass ?? 1) + 1;
  const pending = become<PendingStep>(state, { status: 'pending' });
  delete pending.inputs;
  delete pending.round;
  delete pending.answer;
  return Object.assign(pending, { pass, passes }, iteration !== undefined ? { iteration } : {});
}

/** A step whose looping workflow runs its next round. */
export function nextRound(state: RunningStep): RunningStep {
  return Object.assign(state, { round: (state.round ?? 1) + 1 });
}

/** A loop owner whose loop will not run again after `iteration` runs. */
export function endLoop(owner: SucceededStep, iteration: number): SucceededStep {
  return Object.assign(owner, { loopFinal: true, iteration });
}

/**
 * A loop owner that would run more than `max_iterations` times fails instead. One that just ran keeps what that run
 * reported; one that has not started takes the outputs of its latest pass.
 */
export function exhaust(state: SucceededStep | PendingStep, failure: WorkflowFailure, settledAt: number, iteration?: number): FailedStep {
  const latest = state.status === 'succeeded' ? state : state.passes?.at(-1);
  const ran = state.status === 'succeeded'
    ? Object.fromEntries(SETTLED_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]))
    : latest?.outputs !== undefined ? { outputs: latest.outputs } : {};
  const failed = fail(state, { ...ran, settledAt, message: failure.message, failure });
  return iteration === undefined ? failed : Object.assign(failed, { iteration });
}

/** A step that ran and did not succeed. */
export function stopped(step: StepState): boolean {
  switch (step.status) {
    case 'failed':
    case 'cancelled':
      return true;
    case 'pending':
    case 'waiting':
    case 'leased':
    case 'running':
    case 'delivering':
    case 'succeeded':
    case 'skipped':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

/** A step a driver or the engine is still working on, so its workflow waits rather than being stuck. */
export function inProgress(step: StepState): boolean {
  switch (step.status) {
    case 'waiting':
    case 'leased':
    case 'running':
    case 'delivering':
      return true;
    case 'pending':
    case 'succeeded':
    case 'failed':
    case 'skipped':
    case 'cancelled':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

/** A step `teamai workflow cancel` may stop: one that has not settled. */
export function cancellable(step: StepState): step is StepIn<'pending' | 'waiting' | 'leased' | 'running' | 'delivering'> {
  switch (step.status) {
    case 'pending':
    case 'waiting':
    case 'leased':
    case 'running':
    case 'delivering':
      return true;
    case 'succeeded':
    case 'failed':
    case 'skipped':
    case 'cancelled':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

/** A step that will not run again in this pass, so steps that need or read it can go on. */
export function settled(step: StepState | undefined): step is Extract<StepState, { status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' }> {
  if (!step) return false;
  switch (step.status) {
    case 'succeeded':
    case 'failed':
    case 'skipped':
    case 'cancelled':
      return true;
    case 'pending':
    case 'waiting':
    case 'leased':
    case 'running':
    case 'delivering':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

/**
 * Stops every open step whose path `under` matches, in sub-workflows too: a leased step is cancelled and its attempt
 * stopped at `now` (`stopAttempt`), a running workflow step is cancelled, and a pending or waiting step is skipped. Used
 * by an end or break, cancel and retry, each with its own failure. Returns the ids this walk changed.
 */
export function stopWhere(run: RunState, under: (id: string) => boolean, failure: WorkflowFailure, settledAt: number, now: string): string[] {
  const changed: string[] = [];
  for (const state of run.steps) {
    if (!under(state.id)) continue;
    if (!settled(state)) changed.push(state.id);
    switch (state.status) {
      case 'pending':
      case 'waiting':
        skip(state, settledAt);
        break;
      case 'running':
      case 'delivering':
        cancel(state, failure, settledAt);
        break;
      case 'leased':
        stopAttempt(run, state, now);
        cancel(state, failure, settledAt);
        break;
      case 'succeeded':
      case 'failed':
      case 'skipped':
      case 'cancelled':
        break;
      default: {
        const unknown: never = state;
        return unknown;
      }
    }
  }
  return changed;
}
