/** The workflow protocol in process: the calls behind `workflow start`, `next`, `report`, `respond`, `retry` and `cancel`, for every driver. */
import { z } from 'zod';
import { sameDriver } from '../driver-identity.js';
import type { WorkflowEnv } from '../env-resolution.js';
import { scoringUnavailable } from '../scorers/home.js';
import { isJudgeTool, judgeToolLevel } from '../scorers/judge.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, loadWorkflowTree } from './cache.js';
import { describeWorkflow, type WorkflowDescription } from './describe.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reconcileRun, reportAttempt, startRun, withIgnored, type NextOptions, type ReportInput } from './engine.js';
import {
  abandonPlace, finishPlace, placeHeldBy, placeLeaseOf, placeRecorded, preparePlace, releasePlace, runPlaceSetup, type PlaceLease, type PlacePrepared, type StepEnd,
} from './place/place.js';
import { cancelRun, respondProvenance, respondToHitl, retryStep, type CallerProvenance } from './run-controls.js';
import { nextJudgeLease, parseJudgeRequest, runJudgeLease } from './scoring.js';
import { AttemptIdSchema, readRun, RunIdSchema, withRunLock, type AttemptId, type RunId, type RunLock } from './store.js';
import type { DriverCan } from './requirements.js';
import { isWorkflowError, type DriverIdentity, type WorkflowEnvelope, type WorkflowFailure } from './types.js';
import { headCommit } from './worktree.js';

/**
 * Who sent an answer: a process, with the driver UI its `--json` payload declares the person answered in, or the run's
 * skill driver, which carries the agent's answer.
 */
export type RespondVia =
  | { kind: 'process'; caller: CallerProvenance; json?: unknown }
  | { kind: 'skill'; driver: DriverIdentity };

/**
 * The protocol as one client, in process or through the built CLI. A report made with the run's `RunLock` does not take
 * the lock again; made without one, it takes the lock to finish the attempt's place.
 */
export interface WorkflowClient {
  /**
   * Describes workflow or alias `name` from the cache, with every workflow it runs, for the caller's driver, which
   * declares `can` and runs at most `ceiling` steps at once, as a run started from `checkout` would go. `tool` is the
   * tool of the caller's coding session, whose confined judge would judge the scored steps here.
   */
  describe: (name: string, options: { ceiling: number; can: DriverCan; checkout?: string; tool?: string }) => Promise<{ description: WorkflowDescription; judging: Judging } | { error: WorkflowFailure }>;
  /**
   * Prepares the place of `lease`, the lease `next` answered with, in the checkout the run started from. `busy` when
   * another attempt the run leased holds that place: `behind` is that attempt.
   */
  prepare(lock: RunLock, lease: unknown): Promise<PlacePrepared | { kind: 'busy'; behind: AttemptId }>;
  /** Runs the setup of the place `prepare` made for `attempt`, outside the run lock. Nothing for a place without setup. */
  setup(run: RunId, attempt: AttemptId): Promise<WorkflowFailure | undefined>;
  /** Starts `name` with `inputs`, from `checkout` when given: the run's workspaces start from its HEAD. */
  start(name: string, options?: { inputs?: unknown; checkout?: string }): Promise<WorkflowEnvelope>;
  /**
   * Asks the run what to do. With `prepare`, a lease comes with `cwd`, its place in the checkout the run started from,
   * made under the run's lock, and a prepare that fails settles the attempt `failed` with its own code.
   */
  next(runId: string, body: unknown, options?: { prepare?: NextPrepare }): Promise<WorkflowEnvelope>;
  /** Reports an attempt. A prepared one is finished first: its `changes` or `read` come from its place. */
  report(runId: string, body: unknown, options?: { lock?: RunLock }): Promise<WorkflowEnvelope>;
  /** Records an answer, with the provenance decided from the process or driver `via` names. */
  respond(runId: string, step: string, choice: string, options: { note?: string; pass?: number; via: RespondVia }): Promise<WorkflowEnvelope>;
  /** Reopens the target step's dependency cone. */
  retry(runId: string, step: string): Promise<WorkflowEnvelope>;
  /** Stops the run or the named step. */
  cancel(runId: string, step?: string): Promise<WorkflowEnvelope>;
  /** Takes or renews judge work, as `teamai score --next` does with `body` as its payload. */
  scoreNext(body: unknown): Promise<WorkflowEnvelope>;
  /**
   * Judges lease `ref` with the confined judge of the tool it was leased for, as `teamai score --lease <ref>` does with
   * `body` as its payload, and records the judge tool's process group in the directory `group`.
   */
  judge(ref: string, body: unknown, options: { group: string }): Promise<WorkflowEnvelope>;
}

/**
 * Who judges a run's scored steps as the skill driver drives it: no step is scored; the confined judge of `tool`, the
 * session's tool, here; or no judge here, for `reason`.
 */
export type Judging = { kind: 'none' } | { kind: 'here'; tool: string } | { kind: 'elsewhere'; reason: string };

/** Whether the confined judge of `tool` judges `description`'s scored steps on this machine. */
async function judgingOf(config: LocalConfig, description: WorkflowDescription, tool: string | undefined): Promise<Judging> {
  if (description.facts.scored.length === 0) return { kind: 'none' };
  const unavailable = scoringUnavailable(config);
  if (unavailable) return { kind: 'elsewhere', reason: unavailable };
  if (tool === undefined || !isJudgeTool(tool)) return { kind: 'elsewhere', reason: `The coding session's tool${tool === undefined ? '' : `, ${tool},`} has no confined judge teamai runs.` };
  const level = await judgeToolLevel(tool);
  if (level?.isolation !== 'verified') {
    return { kind: 'elsewhere', reason: level ? `${tool} ${level.version || '(version unknown)'} has no verified judge profile.` : `The ${tool} executable is not on PATH.` };
  }
  return { kind: 'here', tool };
}

/**
 * What `next` prepares: with `true`, the lease it answers with; else `attempt`, which the run already leased to the
 * caller, in a place TeamAI creates, or in the one the host made at `adopt`.
 */
export type NextPrepare = true | { attempt: AttemptId; adopt?: string };

/** The client whose calls run in this process, against `config`, masking with `env`. */
export function inProcessClient({ config, env }: { config: LocalConfig; env: WorkflowEnv }): WorkflowClient {
  return {
    describe: async (name, { ceiling, can, checkout, tool }) => {
      const cached = await loadCachedWorkflow(config, name);
      if (!cached) return { error: { code: 'workflow_not_found', message: `Workflow or alias ${name} has no unambiguous runnable version` } };
      const tree = await loadWorkflowTree(config, cached);
      if ('failed' in tree) return { error: tree.failed };
      const base = checkout === undefined ? undefined : (await headCommit(checkout))?.ref;
      const description = describeWorkflow({
        definition: cached.definition, workflows: tree.workflows, ceiling, can, allow: config.workflows?.allow ?? {}, env: env.facts, ...(base !== undefined ? { base } : {}),
      });
      return { description, judging: await judgingOf(config, description, tool) };
    },
    prepare: async (lock, raw) => {
      const lease = placeLeaseOf(raw);
      if (!lease) return { kind: 'failed', failure: { code: 'workspace_base', message: `Run ${lock.run} leased a place this teamai cannot read. Update teamai.` } };
      const run = await readRun(config, lock.run);
      if (typeof run !== 'object') return { kind: 'failed', failure: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${lease.attempt} has no place to run in` } };
      const leased = run.steps.find((step) => step.status === 'leased' && step.lease.attempt === lease.attempt);
      if (!leased) return { kind: 'failed', failure: { code: 'wrong_attempt', message: `Attempt ${lease.attempt} is not the leased attempt` } };
      if (run.checkout === undefined) return { kind: 'failed', failure: noCheckout(lock.run, lease.attempt) };
      const others = run.steps.flatMap((step) => {
        const other = step.status === 'leased' && step.lease.attempt !== lease.attempt ? AttemptIdSchema.safeParse(step.lease.attempt) : undefined;
        return other?.success ? [other.data] : [];
      });
      const behind = await placeHeldBy({ config, run: lock.run, root: run.checkout, lease, others });
      if (behind) return { kind: 'busy', behind };
      return preparePlace({ config, lock, root: run.checkout, lease: { ...lease, step: leased.id } });
    },
    setup: (run, attempt) => runPlaceSetup({ config, run, attempt, values: env.values }),
    start: async (name, options) => {
      const checkout = options?.checkout;
      const base = checkout === undefined ? undefined : await headCommit(checkout);
      return startRun(config, name, options?.inputs ?? {}, { secrets: env.secrets, ...(checkout !== undefined ? { checkout } : {}), ...(base ? { base } : {}) });
    },
    next: async (runId, body, options) => {
      const parsed = parseNextPayload(body);
      if (typeof parsed === 'string') return { error: { code: 'invalid_json', message: parsed } };
      const { driver, ...next } = parsed.request;
      const lease = (): Promise<WorkflowEnvelope> => leaseNext(config, runId, driver, { ...next, env });
      const run = RunIdSchema.safeParse(runId);
      const prepare = options?.prepare;
      if (prepare === undefined || !run.success) return withIgnored(await lease(), parsed.ignored);
      return withIgnored(await withRunLock(config, run.data, async (lock) => (prepare === true
        ? prepareLeased({ config, lock, driver, env, answer: await lease() })
        : prepareAttempt({ config, lock, driver, env, next, ...prepare })), { waitMs: 0 }), parsed.ignored);
    },
    report: async (runId, body, options) => {
      const parsed = parseReport(body);
      if (typeof parsed === 'string') return { error: { code: 'invalid_report', message: parsed } };
      return withIgnored(await managedReport({ config, runId, report: parsed.report, secrets: env.secrets, lock: options?.lock }), parsed.ignored);
    },
    respond: async (runId, step, choice, { via, ...answer }) => {
      if (via.kind === 'skill') return respondToHitl(config, runId, env.secrets, { step, choice, ...answer, provenance: respondProvenance(via) });
      const declared = via.json !== undefined ? parseResponsePayload(via.json) : undefined;
      if (typeof declared === 'string') return { error: { code: 'invalid_json', message: declared } };
      const provenance = respondProvenance(declared ? { kind: 'driver-json', driver: declared.driver, caller: via.caller } : { kind: 'terminal', caller: via.caller });
      return withIgnored(await respondToHitl(config, runId, env.secrets, { step, choice, ...answer, provenance }), declared?.ignored ?? []);
    },
    retry: (runId, step) => retryStep(config, runId, env.secrets, step),
    cancel: (runId, step) => cancelRun(config, runId, env.secrets, step),
    scoreNext: async (body) => {
      const request = parseJudgeRequest(body);
      return typeof request === 'string' ? { error: { code: 'invalid_json', message: request } } : nextJudgeLease(config, request);
    },
    judge: (ref, body, { group }) => runJudgeLease(config, ref, body, { group }),
  };
}

function noCheckout(run: string, attempt: string): WorkflowFailure {
  return { code: 'workspace_base', message: `Run ${run} records no checkout it started from, so attempt ${attempt} has no place to run in. Drive it with teamai workflow resume ${run}.` };
}

const LeasedSchema = z.object({ attempt: z.string(), revision: z.number() }).passthrough();

/**
 * Prepares `attempt`, which the run already leased to `driver`, holding the run's lock, as `prepareLeased` prepares a
 * new lease, in the place the host made at `adopt` when given. Every other lease of the run is listed as running, so
 * the engine hands this one back and leases nothing new. `wrong_attempt` when the run no longer leases it to `driver`.
 */
async function prepareAttempt(input: {
  config: LocalConfig; lock: RunLock; driver: DriverIdentity; env: WorkflowEnv; next: Omit<NextOptions, 'env'>; attempt: AttemptId; adopt?: string;
}): Promise<WorkflowEnvelope> {
  const { config, lock, driver, env, next, attempt, adopt } = input;
  const run = await readRun(config, lock.run);
  if (typeof run !== 'object') return { error: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${attempt} was not prepared` } };
  const running = run.steps.flatMap((step) => (step.status === 'leased' && step.lease.attempt !== attempt ? [step.lease.attempt] : []));
  const answer = await leaseNext(config, lock.run, driver, { ...next, env, running, canTakeLease: false });
  if (!('data' in answer) || answer.data.done !== undefined) return answer;
  const leased = LeasedSchema.safeParse(answer.data.lease);
  if (!leased.success || leased.data.attempt !== attempt) {
    return { error: { code: 'wrong_attempt', message: `Run ${lock.run} does not lease attempt ${attempt} to this driver, so it was not prepared. Prepare an attempt next leased this driver, or call next without --attempt.` } };
  }
  return prepareLeased({ config, lock, driver, env, answer, ...(adopt !== undefined ? { adopt } : {}) });
}

/**
 * Prepares the place of the lease `answer` carries, holding the run's lock: a lease with a workspace contract gets its
 * worktree set up, or adopts the place the host made at `adopt`. A prepare that fails reports the attempt `failed` with
 * its own code, and answers with that failure; an adopt the place does not pass answers `adopt_mismatch`, and the
 * attempt stays leased.
 */
async function prepareLeased(input: { config: LocalConfig; lock: RunLock; driver: DriverIdentity; env: WorkflowEnv; answer: WorkflowEnvelope; adopt?: string }): Promise<WorkflowEnvelope> {
  const { config, lock, driver, env, answer, adopt } = input;
  if (!('data' in answer) || answer.data.lease === undefined) return answer;
  const leased = LeasedSchema.safeParse(answer.data.lease);
  if (!leased.success) return { error: { code: 'run_unreadable', message: `Run ${lock.run} returned a lease this teamai cannot read` } };
  const lease = placeLeaseOf(leased.data);
  const placed: PlacePrepared = lease
    ? await prepareWithSetup({ config, lock, env, lease, ...(adopt !== undefined ? { adopt } : {}) })
    : { kind: 'failed', failure: { code: 'workspace_base', message: `Attempt ${leased.data.attempt} was leased a place this teamai cannot read. Update teamai.` } };
  if (placed.kind === 'refused') return { error: placed.failure };
  if (placed.kind === 'failed') {
    const { failure } = placed;
    await reportAttempt(config, lock.run, { attempt: leased.data.attempt, revision: leased.data.revision, driver, outcome: 'failed', message: failure.message, failure }, env.secrets);
    return { error: failure };
  }
  return { data: { ...answer.data, lease: { ...leased.data, cwd: placed.dir, ...(placed.prompt !== undefined ? { prompt: placed.prompt } : {}) } } };
}

async function prepareWithSetup(input: { config: LocalConfig; lock: RunLock; env: WorkflowEnv; lease: PlaceLease; adopt?: string }): Promise<PlacePrepared> {
  const { config, lock, env, lease, adopt } = input;
  const run = await readRun(config, lock.run);
  const checkout = typeof run === 'object' ? run.checkout : undefined;
  if (checkout === undefined) return { kind: 'failed', failure: noCheckout(lock.run, lease.attempt) };
  const placed = await preparePlace({ config, lock, root: checkout, lease, ...(adopt !== undefined ? { adopt } : {}) });
  if (placed.kind !== 'prepared') return placed;
  const failure = await runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, values: env.values });
  return failure ? { kind: 'failed', failure } : placed;
}

/**
 * Whether `report` is for an attempt the run still leases to its driver at its revision, once the deadlines that have
 * passed apply, so finishing its place does not commit for an attempt the run would refuse.
 */
async function reportable(config: LocalConfig, runId: string, report: ReportInput): Promise<boolean> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') return false;
  // Applied to this copy only; reportAttempt applies and saves them.
  reconcileRun(run, new Date().toISOString());
  if (run.cancelledAttempts?.includes(report.attempt)) return false;
  const step = run.steps.find((item) => item.status === 'leased' && item.lease.attempt === report.attempt);
  return step?.status === 'leased' && step.lease.revision === report.revision && sameDriver(step.lease.driver, report.driver);
}

/**
 * Reports an attempt, after finishing the place `prepare` gave it, under the run's lock. An attempt without a place is
 * reported as it is. A report the run would refuse is sent as it is, and a cancelled one leaves the place as prepare
 * found it; so does a `released` attempt.
 */
async function managedReport(input: { config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; lock: RunLock | undefined }): Promise<WorkflowEnvelope> {
  const { config, runId, report, secrets, lock } = input;
  const attempt = AttemptIdSchema.safeParse(report.attempt);
  const run = RunIdSchema.safeParse(runId);
  if (!attempt.success || !run.success) return reportAttempt(config, runId, report, secrets);
  if (!await placeRecorded({ config, run: run.data, attempt: attempt.data })) return reportAttempt(config, runId, report, secrets);
  const settle = (held: RunLock): Promise<WorkflowEnvelope> => settleManaged({ config, lock: held, attempt: attempt.data, report, secrets });
  return lock ? settle(lock) : withRunLock(config, run.data, settle, { waitMs: 0 });
}

async function settleManaged(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId; report: ReportInput; secrets: Record<string, string> }): Promise<WorkflowEnvelope> {
  const { config, lock, attempt, report, secrets } = input;
  if (!await reportable(config, lock.run, report)) {
    const answer = await reportAttempt(config, lock.run, report, secrets);
    if (isWorkflowError(answer) && answer.error.code === 'lease_cancelled') await abandonPlace({ config, lock, attempt });
    return answer;
  }
  if (report.changes || report.read) return { error: { code: 'invalid_report', message: 'Prepared workspace reports fill changes/read automatically; omit those fields' } };
  if (report.outcome === 'released') {
    await abandonPlace({ config, lock, attempt });
    return reportAttempt(config, lock.run, report, secrets);
  }
  const end: StepEnd = { outcome: report.outcome, ...(report.message !== undefined ? { message: report.message } : {}), ...(report.failure ? { failure: report.failure } : {}) };
  const finished = await finishPlace({ config, lock, attempt, end, secrets });
  const body = finished === 'unmanaged' ? report : { ...report, ...finished };
  const answer = await reportAttempt(config, lock.run, body, secrets);
  if ('data' in answer && answer.data.cleanup === true && body.outcome === 'success') await releasePlace({ config, lock, attempt });
  return answer;
}

/** The outputs a command step reports: its whole stdout, when that is JSON. */
export function commandOutputs(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}
