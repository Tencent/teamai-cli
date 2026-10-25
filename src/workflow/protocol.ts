/** The workflow protocol in process: the calls behind `workflow start`, `next`, `report`, `respond`, `retry` and `cancel`, for every driver. */
import path from 'node:path';
import type { WorkflowEnv } from '../env-resolution.js';
import { scoringUnavailable } from '../scorers/home.js';
import { isJudgeTool, judgeToolLevel } from '../scorers/judge.js';
import { resolveRunMode, type RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { nestedWorkflowError, type AgentEvidence } from './attempt-marker.js';
import { loadCachedWorkflow, loadWorkflowTree } from './cache.js';
import { describeWorkflow, type WorkflowDescription } from './describe.js';
import { LeaseIdSchema, LeaseWireSchema } from './lease-wire.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportable, reportAttempt, startRun, withIgnored, type NextOptions, type ReportInput } from './engine.js';
import {
  abandonPlace, adoptedPlaceOf, finishPlace, placeHeldBy, placeLeaseOf, placeOf, placeRecorded, preparePlace, releasePlace, runPlaceSetup, type PlaceLease, type PlacePrepared,
  type StepEnd,
} from './place/place.js';
import { cancelRun, respondProvenance, respondToHitl, retryStep, type CallerProvenance, type Via } from './run-controls.js';
import { nextJudgeLease, parseJudgeRequest, runJudgeLease } from './scoring.js';
import { AttemptIdSchema, readRun, RunIdSchema, withRunLock, type AttemptId, type RunId, type RunLock } from './store.js';
import type { DriverCan } from './requirements.js';
import { isWorkflowError, type DriverIdentity, type RunState, type WorkflowDefinition, type WorkflowEnvelope, type WorkflowFailure } from './types.js';
import { deliveryProblem } from './workspace.js';
import { headCommit } from './worktree.js';

/**
 * Who sent an answer: a process, with the driver UI its `--json` payload declares the person answered in, or the run's
 * skill driver, which carries the agent's answer.
 */
export type RespondVia =
  | { kind: 'process'; caller: CallerProvenance; json?: unknown }
  | Extract<Via, { kind: 'skill' }>;

/**
 * The protocol as one client, in process or through the built CLI. A report made with the run's `RunLock` does not take
 * the lock again; made without one, it takes the lock to finish the attempt's place.
 */
export interface WorkflowClient {
  /**
   * Describes workflow or alias `name` from the cache, with every workflow it runs, for the caller's driver, which
   * declares `can` and runs at most `ceiling` steps at once, as a run started from `checkout` would go. `tool` is the
   * tool of the caller's coding session, whose confined judge would judge the scored steps here. `undeliverable`: why
   * a start from `checkout` would be refused for its delivery (`deliveryProblem`).
   */
  describe: (name: string, options: { ceiling: number; can: DriverCan; checkout?: string; tool?: string }) => Promise<{ description: WorkflowDescription; judging: Judging; undeliverable?: WorkflowFailure } | { error: WorkflowFailure }>;
  /**
   * Prepares the place of `lease`, the lease `next` answered with, in the checkout the run started from. `busy` when
   * another attempt the run leased holds that place: `behind` is that attempt.
   */
  prepare(lock: RunLock, lease: unknown): Promise<PlacePrepared | { kind: 'busy'; behind: AttemptId }>;
  /**
   * Prepares the place of `lease` in a place its host made, when the lease commits to a branch, and as `prepare` does
   * when it does not. `host` asks for the place the last attempt to finish on the branch was prepared in, while it
   * passes the adopt checks, and is `busy` while another open attempt holds it. `adopt` asks for the place at `dir`.
   */
  prepareHostPlace(lock: RunLock, lease: unknown, request: HostPlaceRequest): Promise<HostPlacePrepared>;
  /**
   * Runs the setup of the place `prepare` made for `attempt`, outside the run lock, in the run's `mode`. Nothing for a
   * place without setup.
   */
  setup(run: RunId, attempt: AttemptId, mode: RunMode): Promise<WorkflowFailure | undefined>;
  /**
   * Starts `name` with `inputs`, from `checkout` when given: the run's workspaces start from its HEAD. A `caller`
   * inside a workflow attempt starts none, `nested_workflow`, and an agent one only a workflow whose `invoke` lets it:
   * `invoke_denied` for `deny`, and `confirm_needed` for `ask` without `confirmed`.
   */
  start(name: string, options: { inputs?: unknown; checkout?: string; caller: StartCaller }): Promise<WorkflowEnvelope>;
  /**
   * Asks the run what to do. With `prepare`, a lease comes with `cwd`, its place in the checkout the run started from,
   * made under the run's lock, and a prepare that fails settles the attempt `failed` with its own code.
   */
  next(runId: string, body: unknown, options?: { prepare?: NextPrepare }): Promise<WorkflowEnvelope>;
  /** Reports an attempt. A prepared one is finished first: its `changes` or `read` come from its place. */
  report(runId: string, body: unknown, options?: { lock?: RunLock }): Promise<WorkflowEnvelope>;
  /** Records an answer, with the provenance decided from the process or driver `via` names. A process inside a workflow attempt answers none: `nested_workflow`. */
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
 * The process that asks to start a run: the evidence it carries that an agent runs it, and whether it passed
 * `--confirmed`, an agent's word that the person agreed to start the run, which teamai cannot verify.
 */
export interface StartCaller {
  evidence: AgentEvidence;
  confirmed: boolean;
}

/** What shows an agent runs the calling process, as the clause the `invoke` refusals end their first sentence with. */
function agentClause(evidence: Exclude<AgentEvidence, { kind: 'none' }>): string {
  switch (evidence.kind) {
    case 'session':
      return `this command runs inside an agent session (${evidence.variable} is set)`;
    case 'attempt':
      return `this command runs inside workflow attempt ${evidence.attempt}`;
    case 'skill-driver':
      return 'this start uses --driver skill, which only a coding agent drives';
    default: {
      const unhandled: never = evidence;
      return unhandled;
    }
  }
}

/** Why an agent, as `evidence` shows it, may not start workflow `name`, whose definition has `invoke: deny`. */
export function invokeDeniedMessage(name: string, evidence: Exclude<AgentEvidence, { kind: 'none' }>): string {
  return `Workflow "${name}" has invoke: deny, so no coding agent starts it, with any driver, and ${agentClause(evidence)}. The person can start it from their own terminal with teamai workflow start ${name} --driver local. To let agents start it, the team sets invoke: allow, or invoke: ask for a start after the person agrees, in workflows/${name}.yaml.`;
}

/**
 * Why `caller` may not start `definition`: inside a workflow attempt nothing starts, and from an agent session
 * `invoke: deny` refuses every start, and `invoke: ask` one without the person's yes. Undefined for a process without
 * agent evidence, such as the person's terminal or CI, and for a session's start of a workflow the cache lacks, which
 * the start answers.
 */
function startRefusal(definition: WorkflowDefinition | undefined, caller: StartCaller): WorkflowFailure | undefined {
  const { evidence } = caller;
  switch (evidence.kind) {
    case 'none':
      return undefined;
    case 'attempt':
      return nestedWorkflowError({ kind: 'marker', attempt: evidence.attempt });
    case 'session':
    case 'skill-driver': {
      if (definition === undefined) return undefined;
      const { name } = definition;
      const invoke = definition.invoke ?? 'deny';
      if (invoke === 'allow' || (invoke === 'ask' && caller.confirmed)) return undefined;
      return invoke === 'deny'
        ? { code: 'invoke_denied', message: invokeDeniedMessage(name, evidence) }
        : { code: 'confirm_needed', message: `Workflow "${name}" has invoke: ask, so a coding agent starts it only after the person agrees, and ${agentClause(evidence)}. Ask the person whether to start ${name}; once they agree, run the same command with --confirmed.` };
    }
    default: {
      const unhandled: never = evidence;
      return unhandled;
    }
  }
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

/** Where the host made the place of a lease: `host`, the place an earlier attempt adopted for its branch; `adopt`, `dir`. */
export type HostPlaceRequest = { kind: 'host' } | { kind: 'adopt'; dir: string };

/**
 * `needs-place` when the host must make the place: a worktree of the checkout's repository named `name`, on `branch`
 * from commit `start`. `refused` says why the place the request named was not prepared.
 */
export type HostPlacePrepared =
  | Exclude<PlacePrepared, { kind: 'refused' }>
  | { kind: 'busy'; behind: AttemptId }
  | { kind: 'needs-place'; name: string; branch: string; start: string; refused?: string };

/** The lease `raw` names, as the run leases it now, with the checkout its place goes in and the run's other leased attempts. */
async function leasedPlace(config: LocalConfig, lock: RunLock, raw: unknown): Promise<{ lease: PlaceLease; root: string; others: AttemptId[] } | { kind: 'failed'; failure: WorkflowFailure }> {
  const wire = LeaseWireSchema.safeParse(raw);
  if (!wire.success) return { kind: 'failed', failure: { code: 'workspace_base', message: `Run ${lock.run} leased a place this teamai cannot read. Update teamai.` } };
  const lease = placeLeaseOf(wire.data);
  const run = await readRun(config, lock.run);
  if (typeof run !== 'object') return { kind: 'failed', failure: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${lease.attempt} has no place to run in` } };
  const leased = run.steps.find((step) => step.status === 'leased' && step.lease.attempt === lease.attempt);
  if (!leased) return { kind: 'failed', failure: { code: 'wrong_attempt', message: `Attempt ${lease.attempt} is not the leased attempt` } };
  if (run.checkout === undefined) return { kind: 'failed', failure: noCheckout(lock.run, lease.attempt) };
  return { lease: { ...lease, step: leased.id }, root: run.checkout, others: otherLeases(run, lease.attempt) };
}

/** The attempts `run` leases besides `attempt`. */
function otherLeases(run: RunState, attempt: AttemptId): AttemptId[] {
  return run.steps.flatMap((step) => {
    const other = step.status === 'leased' && step.lease.attempt !== attempt ? AttemptIdSchema.safeParse(step.lease.attempt) : undefined;
    return other?.success ? [other.data] : [];
  });
}

/** Why `attempt` was not prepared in `dir`, the place of `behind`, another open attempt of `run`: as every adopt refuses it. */
function heldPlaceRefusal(input: { dir: string; behind: AttemptId; run: RunId; attempt: AttemptId }): string {
  return `${input.dir} is the place of attempt ${input.behind} of run ${input.run}, which is still open, so attempt ${input.attempt} was not prepared there. Make another place for it, then adopt that one.`;
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
      const head = checkout === undefined ? undefined : await headCommit(checkout);
      const description = describeWorkflow({
        definition: cached.definition, workflows: tree.workflows, ceiling, can, allow: config.workflows?.allow ?? {}, env: env.facts, ...(head?.ref !== undefined ? { base: head.ref } : {}),
      });
      const undeliverable = deliveryProblem(cached.definition, tree.workflows, head);
      return { description, judging: await judgingOf(config, description, tool), ...(undeliverable ? { undeliverable } : {}) };
    },
    prepare: async (lock, raw) => {
      const leased = await leasedPlace(config, lock, raw);
      if ('kind' in leased) return leased;
      const { lease, root, others } = leased;
      const behind = await placeHeldBy({ config, run: lock.run, root, lease, others });
      if (behind) return { kind: 'busy', behind };
      return preparePlace({ config, lock, root, lease });
    },
    prepareHostPlace: async (lock, raw, request) => {
      const leased = await leasedPlace(config, lock, raw);
      if ('kind' in leased) return leased;
      const { lease, root, others } = leased;
      const { workspace } = lease;
      const writes = workspace?.mode === 'new' || workspace?.mode === 'continue';
      const adopt = !writes ? undefined : request.kind === 'adopt' ? request.dir : await adoptedPlaceOf({ config, run: lock.run, branch: workspace.branch });
      const ask = writes ? { kind: 'needs-place' as const, name: path.basename(placeOf(lease, root)), branch: workspace.branch, start: workspace.start.commit } : undefined;
      if (ask && adopt === undefined) return ask;
      const behind = await placeHeldBy({ config, run: lock.run, root, lease, others, ...(adopt !== undefined ? { adopt } : {}) });
      if (behind && ask && request.kind === 'adopt') {
        return { ...ask, refused: heldPlaceRefusal({ dir: request.dir, behind, run: lock.run, attempt: lease.attempt }) };
      }
      if (behind) return { kind: 'busy', behind };
      const placed = await preparePlace({ config, lock, root, lease, ...(adopt !== undefined ? { adopt } : {}) });
      if (placed.kind !== 'refused') return placed;
      // The place an earlier attempt adopted no longer passes the checks, so the host makes another.
      if (ask) return request.kind === 'adopt' ? { ...ask, refused: placed.failure.message } : ask;
      return { kind: 'failed', failure: placed.failure };
    },
    setup: (run, attempt, mode) => runPlaceSetup({ config, run, attempt, mode, values: env.values }),
    start: async (name, { inputs, checkout, caller }) => {
      const cached = await loadCachedWorkflow(config, name);
      const refused = startRefusal(cached?.definition, caller);
      if (refused) return { error: refused };
      const base = checkout === undefined ? undefined : await headCommit(checkout);
      return startRun(config, name, inputs ?? {}, { secrets: env.secrets, ...(checkout !== undefined ? { checkout } : {}), ...(base ? { base } : {}) });
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
      const { evidence } = via.caller;
      if (evidence.kind === 'attempt') return { error: nestedWorkflowError({ kind: 'marker', attempt: evidence.attempt }) };
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

/**
 * Prepares `attempt`, which the run already leased to `driver`, holding the run's lock, as `prepareLeased` prepares a
 * new lease, in the place the host made at `adopt` when given. Every other lease of the run is listed as running, so
 * the engine hands this one back and leases nothing new. `wrong_attempt` when the run no longer leases it to `driver`;
 * `adopt_mismatch`, with the attempt still leased, when another open attempt of the run holds `adopt`.
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
  const leased = LeaseIdSchema.safeParse(answer.data.lease);
  if (!leased.success || leased.data.attempt !== attempt) {
    return { error: { code: 'wrong_attempt', message: `Run ${lock.run} does not lease attempt ${attempt} to this driver, so it was not prepared. Prepare an attempt next leased this driver, or call next without --attempt.` } };
  }
  if (adopt !== undefined) {
    const place = await leasedPlace(config, lock, answer.data.lease);
    const behind = 'kind' in place ? undefined : await placeHeldBy({ config, run: lock.run, ...place, adopt });
    if (behind) return { error: { code: 'adopt_mismatch', message: heldPlaceRefusal({ dir: adopt, behind, run: lock.run, attempt }) } };
  }
  return prepareLeased({ config, lock, driver, env, answer, ...(adopt !== undefined ? { adopt } : {}) });
}

/**
 * Prepares the place of the lease `answer` carries, holding the run's lock: a lease with a workspace contract gets its
 * worktree set up, or adopts the place the host made at `adopt`. A prepare that fails reports the attempt `failed` with
 * its own code, and answers with that failure; an adopt the place does not pass answers `adopt_mismatch`, and a place
 * another open attempt holds answers `busy`, and the attempt stays leased.
 */
async function prepareLeased(input: { config: LocalConfig; lock: RunLock; driver: DriverIdentity; env: WorkflowEnv; answer: WorkflowEnvelope; adopt?: string }): Promise<WorkflowEnvelope> {
  const { config, lock, driver, env, answer, adopt } = input;
  if (!('data' in answer) || answer.data.lease === undefined) return answer;
  // What names the lease is read first, so a lease whose place this teamai cannot read is still reported.
  const leased = LeaseIdSchema.passthrough().safeParse(answer.data.lease);
  if (!leased.success) return { error: { code: 'run_unreadable', message: `Run ${lock.run} returned a lease this teamai cannot read` } };
  const wire = LeaseWireSchema.safeParse(answer.data.lease);
  const lease = wire.success ? placeLeaseOf(wire.data) : undefined;
  const placed: Awaited<ReturnType<typeof prepareWithSetup>> = lease
    ? await prepareWithSetup({ config, lock, env, lease, ...(adopt !== undefined ? { adopt } : {}) })
    : { kind: 'failed', failure: { code: 'workspace_base', message: `Attempt ${leased.data.attempt} was leased a place this teamai cannot read. Update teamai.` } };
  if (placed.kind === 'refused') return { error: placed.failure };
  if (placed.kind === 'busy') {
    const { attempt } = leased.data;
    return { error: { code: 'busy', message: `Attempt ${attempt} of run ${lock.run} runs in ${placed.dir}, the place of attempt ${placed.behind}, which is still open, so it was not prepared. Report attempt ${placed.behind}, then prepare this one with next --prepare --attempt ${attempt}.` } };
  }
  if (placed.kind === 'failed') {
    const { failure } = placed;
    await reportAttempt(config, lock.run, { attempt: leased.data.attempt, revision: leased.data.revision, driver, outcome: 'failed', message: failure.message, failure }, env.secrets);
    return { error: failure };
  }
  return { data: { ...answer.data, lease: { ...leased.data, cwd: placed.dir, ...(placed.prompt !== undefined ? { prompt: placed.prompt } : {}) } } };
}

async function prepareWithSetup(input: {
  config: LocalConfig; lock: RunLock; env: WorkflowEnv; lease: PlaceLease; adopt?: string;
}): Promise<PlacePrepared | { kind: 'busy'; dir: string; behind: AttemptId }> {
  const { config, lock, env, lease, adopt } = input;
  const run = await readRun(config, lock.run);
  if (typeof run !== 'object' || run.checkout === undefined) return { kind: 'failed', failure: noCheckout(lock.run, lease.attempt) };
  const { checkout } = run;
  // As the local and skill drivers' prepare does; prepareAttempt checked an adopt against the place the host made.
  const behind = adopt === undefined ? await placeHeldBy({ config, run: lock.run, root: checkout, lease, others: otherLeases(run, lease.attempt) }) : undefined;
  if (behind) return { kind: 'busy', dir: placeOf(lease, checkout), behind };
  const placed = await preparePlace({ config, lock, root: checkout, lease, ...(adopt !== undefined ? { adopt } : {}) });
  if (placed.kind !== 'prepared') return placed;
  // A --json driver's run keeps no mode, so its setup runs in the mode of the process that prepares it.
  const failure = await runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode: resolveRunMode(process.env), values: env.values });
  return failure ? { kind: 'failed', failure } : placed;
}

/**
 * Reports an attempt, after finishing the place `prepare` gave it, under the run's lock, and removes that place once the
 * engine answers `cleanup`. Every driver reports through it. An attempt without a place is reported as it is. A report
 * the run would refuse is sent as it is, and a cancelled one leaves the place as prepare found it; so does a
 * `released` attempt.
 */
export async function managedReport(input: { config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; lock: RunLock | undefined }): Promise<WorkflowEnvelope> {
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
  // Checked first, so finishing the place does not commit for an attempt the run would refuse.
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
  if ('data' in answer && answer.data.cleanup === true) await releasePlace({ config, lock, attempt });
  return answer;
}

/**
 * What a command step reports once it exited: `success` on status 0, else `failed` with its status and the start of
 * its stderr; and its whole stdout as its outputs, when that is JSON.
 */
export function commandEnd(result: { exitCode: number; stdout: string; stderr: string }): { outcome: 'success' | 'failed'; exitCode: number; message?: string; outputs?: unknown } {
  const { exitCode } = result;
  const outputs = commandOutputs(result.stdout);
  const snippet = result.stderr.trim().slice(0, 400);
  return {
    outcome: exitCode === 0 ? 'success' : 'failed', exitCode,
    ...(exitCode !== 0 ? { message: snippet === '' ? `command exited with status ${exitCode}` : `command exited with status ${exitCode}: ${snippet}` } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
  };
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
