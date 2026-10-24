import { z } from 'zod';
import { AgentObservationSchema, UsedSchema } from '../agent-observation.js';
import { DriverSchema } from '../driver-identity.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { StepLease, WorkflowFailure } from './types.js';
import type { WorkspaceMode } from './workspace.js';

const TokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cachedInput: z.number().optional(),
});

const FailureSchema: z.ZodType<WorkflowFailure> = z.object({ code: z.string(), message: z.string() });

const SessionRefSchema = z.object({ tool: z.string().min(1), id: z.string().min(1) });

/** One entry of `RunState.sessionContinuations`: the session a step resumed, and the session it continued it in. */
export const SessionContinuationSchema = z.object({ from: SessionRefSchema, to: SessionRefSchema });
export type SessionContinuation = z.infer<typeof SessionContinuationSchema>;

const LeaseSessionSchema = SessionRefSchema.extend({ earlier: z.array(SessionRefSchema).optional() });

const LeaseSchema: z.ZodType<StepLease> = z.object({
  attempt: z.string(), revision: z.number(), driver: DriverSchema, session: LeaseSessionSchema.optional(),
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
};

export const OutcomeSchema = z.enum(['success', 'failed', 'skipped', 'cancelled']);
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
const RunningSchema = StepBaseSchema.extend({ status: z.literal('running') });
const SucceededSchema = StepBaseSchema.extend({
  status: z.literal('succeeded'), outcome: z.literal('success').default('success'), ...settledFields, loopFinal: z.boolean().optional(),
});
const FailedSchema = StepBaseSchema.extend({ status: z.literal('failed'), outcome: z.literal('failed').default('failed'), ...settledFields, failure: FailureSchema.optional() });
const SkippedSchema = StepBaseSchema.extend({ status: z.literal('skipped'), settledAt: z.number().int().default(0) });
const CancelledSchema = StepBaseSchema.extend({ status: z.literal('cancelled'), settledAt: z.number().int().default(0), attempt: z.string().optional(), failure: FailureSchema });

export const StepStateSchema = z.discriminatedUnion('status', [
  PendingSchema,
  WaitingSchema,
  StepBaseSchema.extend({ status: z.literal('leased'), attempt: z.string(), lease: LeaseSchema }),
  RunningSchema,
  SucceededSchema,
  FailedSchema,
  SkippedSchema,
  CancelledSchema,
]);
type ReadonlyId<T> = T extends unknown ? Omit<T, 'id'> & { readonly id: string } : never;
/** A step instance's `id` is read-only: the engine indexes instances by it, and every transition keeps it. */
export type StepState = ReadonlyId<z.infer<typeof StepStateSchema>>;

/**
 * A step as a run handed to another machine carries it. A leased step keeps its attempt and the kind of driver that
 * holds it, not that driver's machine or workspace, which mean nothing on the machine that takes the run.
 */
export const StepCheckpointSchema = z.discriminatedUnion('status', [
  PendingSchema,
  WaitingSchema,
  StepBaseSchema.extend({
    status: z.literal('leased'), attempt: z.string(), lease: z.object({ attempt: z.string(), revision: z.number(), driverKind: z.string() }),
  }),
  RunningSchema,
  SucceededSchema,
  FailedSchema,
  SkippedSchema,
  CancelledSchema,
]);
export type StepCheckpoint = ReadonlyId<z.infer<typeof StepCheckpointSchema>>;
/** A lease another machine held when the run was handed over. */
export type HandedLease = Extract<StepCheckpoint, { status: 'leased' }>;
type StepStatus = StepState['status'];

type StepIn<S extends StepStatus> = Extract<StepState, { status: S }>;
type PendingStep = StepIn<'pending'>;
export type LeasedStep = StepIn<'leased'>;
type RunningStep = StepIn<'running'>;
type SucceededStep = StepIn<'succeeded'>;
type FailedStep = StepIn<'failed'>;
type SkippedStep = StepIn<'skipped'>;
type CancelledStep = StepIn<'cancelled'>;

type Settlement<T extends StepState> = Omit<T, keyof StepBase | 'status' | 'outcome'>;

const BASE_KEYS = Object.keys(StepBaseSchema.shape) as Array<keyof StepBase>;
const SETTLED_KEYS = Object.keys(settledFields) as Array<keyof typeof settledFields>;
export const VISIBLE_OUTCOMES = { succeeded: 'success', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled' } as const;

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

/** A workflow step starts; `inputs` are the values its `with` passed, when that workflow declares inputs. */
export function start(state: StepState, inputs?: Record<string, unknown>): RunningStep {
  const running = become<RunningStep>(state, { status: 'running' });
  if (inputs) running.inputs = inputs;
  return running;
}

export function succeed(state: StepState, settlement: Settlement<SucceededStep>): SucceededStep {
  return become<SucceededStep>(state, { status: 'succeeded', outcome: 'success', ...settlement });
}

export function fail(state: StepState, settlement: Settlement<FailedStep>): FailedStep {
  return become<FailedStep>(state, { status: 'failed', outcome: 'failed', ...settlement });
}

/** An open step is cancelled before it settles. A leased one keeps its invalidated attempt. */
export function cancel(state: StepIn<'pending' | 'waiting' | 'leased' | 'running'>, failure: WorkflowFailure, settledAt: number): CancelledStep {
  return become<CancelledStep>(state, { status: 'cancelled', settledAt, ...(state.status === 'leased' ? { attempt: state.attempt } : {}), failure });
}

/** The current pass of a settled step, as `passes` keeps it once a loop runs the step again; undefined while it has not settled. */
export function passOf(state: StepState): StepPass | undefined {
  if (!settled(state)) return undefined;
  const outcome = VISIBLE_OUTCOMES[state.status];
  return StepPassSchema.parse({ ...state, pass: state.pass ?? 1, outcome });
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
    case 'succeeded':
    case 'skipped':
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
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}
