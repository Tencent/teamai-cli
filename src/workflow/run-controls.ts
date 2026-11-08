import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadTeamConfig } from '../config.js';
import { isJsonObject, type JsonValue, type LocalConfig } from '../types.js';
import { shellQuoteValue } from '../utils/shell-profile.js';
import { agentEvidence, type AgentEvidence } from './attempt-marker.js';
import {
  error, finishRun, locateStep, ok, parseReads, reconcileRun, respondCommand, restartQueued, retryCommand, runData, withRun, workflowLabel,
  type RunReads, type WorkflowResult,
} from './engine.js';
import { evaluateExpression, isRecord, isTruthy, pathValue } from './expression.js';
import { isItem, itemsAfter, itemsOf, keptResults } from './fan-out.js';
import { publishRunEnd } from './handoff.js';
import { cleanUpSucceededRun, restoreRecordedBranches } from './leftovers.js';
import { archiveUnder, isUnder } from './loop.js';
import { spentTokens, startLimits } from './limits.js';
import { publishRunRecords, removeQueuedEndRecord } from './records.js';
import { resolveRetention, runRetainedUntil, type ResolvedRetention } from './retention.js';
import { contextOf, localId, statesIn, type Scope } from './scope.js';
import { isRunId, readRun, runScratchDir, withCleanupLock } from './store.js';
import { answerHitl, cancel, cancellable, redeliver, repend, resetIteration, resetPending, settled, start, stopAttempt, stopWhere, stopped, type HitlAnswer, type StepState } from './step-state.js';
import { parseTemplate, templatePaths, templatedTexts } from './template.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from './types.js';
import { isIsolated } from './workspace.js';

async function controlRun(
  config: LocalConfig,
  runId: string,
  secrets: Record<string, string>,
  operation: (run: RunState, now: string, finish: (result: WorkflowResult) => Promise<void>) => Promise<WorkflowEnvelope>,
  { reopen }: { reopen?: { busy: WorkflowEnvelope; prepare: () => Promise<WorkflowEnvelope | undefined> } } = {},
): Promise<WorkflowEnvelope> {
  let queued = false;
  let runSettled = false;
  let checkout = process.cwd();

  const change = () => withRun(config, runId, secrets, async (run, now) => {
    const before = JSON.stringify(run);
    checkout = run.driver?.workspace ?? run.checkout ?? checkout;

    const finish = async (result: WorkflowResult): Promise<void> => {
      const finished = await finishRun(config, run, now, result, secrets, run.driver);

      if (finished.kind === 'finalizing') return;
      runSettled = true;
      queued = finished.queued;
    };

    const opEnvelope = await operation(run, now, finish);

    return { envelope: opEnvelope, save: JSON.stringify(run) !== before };
  });

  // A reopen holds the run's cleanup lock while it prepares and changes the run, so no cleanup deletes a branch the
  // reopened run needs. `prepare` makes network calls, which the run lock never holds; its answer refuses the control.
  let envelope: WorkflowEnvelope;

  if (reopen === undefined) envelope = await change();
  else {
    const locked = await withCleanupLock(config, runId, async () => await reopen.prepare() ?? change());

    if (locked.kind === 'busy') return reopen.busy;
    envelope = locked.value;
  }

  // Not on a control that only found a run already ended: its answer is an error, and the end was published before.
  // A control that settled the run answers with an error too, and still publishes its end.
  const notPublished = 'data' in envelope || runSettled ? await publishRunEnd(config, runId, checkout) : undefined;

  if (queued) await publishRunRecords(config);

  if (notPublished && 'data' in envelope) envelope.data.notPublished = notPublished;

  if (runSettled) await cleanUpSucceededRun(config, { runId, checkout, secrets, notPublished });

  return envelope;
}

function settledRunError(run: RunState): WorkflowEnvelope {
  return error('run_settled', `Run ${run.id} already settled with outcome ${run.status}`);
}

function missingStepError(run: RunState, step: string): WorkflowEnvelope {
  return error('step_not_found', `Step "${step}" is not in run ${run.id}. A step inside a sub-workflow exists only after that workflow starts.`);
}

/** What is known about the process that sent an answer. Read once from that process by `callerProvenance`. */
export interface CallerProvenance {
  tty: boolean;
  evidence: AgentEvidence;
}

export function callerProvenance(env: NodeJS.ProcessEnv, stdin: { isTTY?: boolean }): CallerProvenance {
  return { tty: stdin.isTTY === true, evidence: agentEvidence(env) };
}

/** Where an answer came in, with what is known about the process that sent it. */
export type Via =
  | { kind: 'terminal'; caller: CallerProvenance }
  /** The dashboard's server process sent it. */
  | { kind: 'dashboard'; caller: CallerProvenance }
  /** `respond --json {driver}`: an external driver's UI. */
  | { kind: 'driver-json'; driver: DriverIdentity; caller: CallerProvenance }
  /** `respond --driver skill`: the run's skill driver carries the agent's answer. */
  | { kind: 'skill'; driver: DriverIdentity };

/** Why an agent may have sent an answer. */
type AgentCause = Exclude<AgentEvidence, { kind: 'none' }> | { kind: 'no-terminal' } | { kind: 'skill-driver' };

/**
 * The HITL provenance `respondToHitl` records. The class is not exported, so `respondProvenance` is its only
 * constructor and a hand-written `{ channel: 'dashboard', agent: false }` does not compile.
 */
class Provenance {
  /** An ES private field makes the class nominal: an object literal of the same shape is not a Provenance. */
  readonly #agentCause: AgentCause | undefined;

  private constructor(
    readonly channel: 'tty' | 'cli' | 'driver' | 'dashboard',
    readonly driver: DriverIdentity | undefined,
    agentCause: AgentCause | undefined,
  ) {
    this.#agentCause = agentCause;
  }

  /** Evidence, not proof: an agent can unset its variable and allocate a terminal. */
  static decide(via: Via): Provenance {
    switch (via.kind) {
      case 'terminal': {
        const cause = agentHere(via.caller) ?? (via.caller.tty ? undefined : { kind: 'no-terminal' });

        return new Provenance(via.caller.tty ? 'tty' : 'cli', undefined, cause);
      }

      case 'dashboard':
        return new Provenance('dashboard', undefined, agentHere(via.caller));
      case 'driver-json':
        return new Provenance('driver', via.driver, agentHere(via.caller));
      case 'skill':
        return new Provenance('driver', via.driver, { kind: 'skill-driver' });
      default: {
        const unhandled: never = via;

        return unhandled;
      }
    }
  }

  /** Whether an agent may have sent the answer. */
  get agent(): boolean {
    return this.#agentCause !== undefined;
  }

  get agentCause(): AgentCause | undefined {
    return this.#agentCause;
  }
}

function agentHere(caller: CallerProvenance): AgentCause | undefined {
  return caller.evidence.kind === 'none' ? undefined : caller.evidence;
}

export type { Provenance };

/** Decides the provenance of an answer from where it came in: the only way to make a `Provenance`. */
export const respondProvenance = Provenance.decide;

/** An answer tied to one HITL request pass and the provenance decided for it. */
export interface ResponseInput {
  /** Full path of the waiting step. */
  step: string;
  /** One of the HITL request's declared options. */
  choice: string;
  /** Free text kept locally with the answer. */
  note?: string;
  /** The expected HITL pass, when the caller observed one. */
  pass?: number;
  /** A required gate refuses an answer an agent may have sent. */
  provenance: Provenance;
  /** As `next`'s `queued`: the open leases of the driver that sent the answer that it holds but has not started, whose own timeout counts from this answer. */
  queued?: { driver: DriverIdentity; attempts: readonly string[] };
}

function agentInPath(run: RunState, state: StepState, options: readonly string[], cause: AgentCause): WorkflowEnvelope {
  const command = respondCommand(run.id, state.id, `<${options.join('|')}>`, state.pass ?? 1);

  switch (cause.kind) {
    case 'session':
      return error('agent_in_path', `Step "${state.id}" needs an answer from the person, and the process that sent this one runs inside an agent session (${cause.variable} is set). The person runs ${command} in their own terminal, or answers in a teamai dashboard started there.`);
    case 'attempt':
      return error('agent_in_path', `Step "${state.id}" needs an answer from the person, and the process that sent this one runs inside workflow attempt ${cause.attempt}. The person runs ${command} in their own terminal, or answers in a teamai dashboard started there.`);
    case 'no-terminal':
      return error('agent_in_path', `Step "${state.id}" needs an answer from the person, and this command has no terminal, so an agent may have sent it. The person runs ${command} in their own terminal, or answers in a teamai dashboard started there.`);
    case 'skill-driver':
      return error('agent_in_path', `Step "${state.id}" needs an answer from the person, and respond --driver skill carries an agent's answer. The person runs ${command} in their own terminal, or answers in a teamai dashboard started there.`);
    default: {
      const unhandled: never = cause;

      return unhandled;
    }
  }
}

/** Records a HITL request answer under the run lock and settles any work it enables. */
export async function respondToHitl(config: LocalConfig, runId: string, secrets: Record<string, string>, input: ResponseInput): Promise<WorkflowEnvelope> {
  return controlRun(config, runId, secrets, async (run, now, finish) => {
    if (run.status !== 'running') return settledRunError(run);

    if (input.queued) restartQueued(run, input.queued.driver, new Set(input.queued.attempts), now);
    const result = reconcileRun(run, now);

    if ('unreadable' in result) return error('run_unreadable', result.unreadable);

    if ('outcome' in result) {
      await finish(result);

      return settledRunError(run);
    }

    const state = run.steps.find((step) => step.id === input.step);

    if (!state) return missingStepError(run, input.step);
    const hitl = locateStep(run, state.id)?.step.hitl;

    if (input.pass !== undefined && input.pass !== (state.pass ?? 1)) {
      const current = state.status === 'waiting' ? `now waits at pass ${state.pass ?? 1}` : `is now at pass ${state.pass ?? 1} (status: ${state.status})`;

      return error('stale_response', `The HITL request of pass ${input.pass} was answered or replaced; step ${state.id} ${current}`);
    }

    if (state.status !== 'waiting') {
      if (state.answer) return error('repeated_response', `Step "${state.id}" was already answered "${state.answer.choice}" through ${state.answer.channel} in this pass`);

      if (!hitl) return error('not_hitl', `Step "${state.id}" has no approve or choose HITL request`);

      return error('not_waiting', `Step "${state.id}" is ${state.status}, not waiting for an answer`);
    }

    if (!hitl) return error('not_hitl', `Step "${state.id}" has no approve or choose HITL request`);

    if (!hitl.options.includes(input.choice)) return error('invalid_choice', `Step "${state.id}" accepts these choices: ${hitl.options.join(', ')}`);
    const { channel, driver, agentCause } = input.provenance;

    if (hitl.required && agentCause) return agentInPath(run, state, hitl.options, agentCause);
    const agent = agentCause !== undefined;
    const answered = { step: state.id, pass: state.pass ?? 1, choice: input.choice, channel, agent };
    const noted: Pick<HitlAnswer, 'note'> = {};

    if (input.note !== undefined) noted.note = input.note;
    const answer: HitlAnswer = { choice: input.choice, ...noted, at: now, channel, agent };

    if (driver) answer.driver = driver;
    answerHitl(state, answer);
    const reconciled = reconcileRun(run, now);

    if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);

    if ('outcome' in reconciled) await finish(reconciled);

    return ok({ answered, run: runData(run) });
  });
}

/** Stops a whole run or one open step and invalidates the attempts it cancelled. */
export async function cancelRun(config: LocalConfig, runId: string, secrets: Record<string, string>, step?: string, message = 'Cancelled by teamai workflow cancel'): Promise<WorkflowEnvelope> {
  return controlRun(config, runId, secrets, async (run, now, finish) => {
    if (run.status !== 'running') return settledRunError(run);
    const failure = { code: 'cancelled', message };

    if (step !== undefined) {
      const reconciled = reconcileRun(run, now);

      if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);

      if ('outcome' in reconciled) {
        await finish(reconciled);

        if (run.status !== 'running') return settledRunError(run);
      }
    }

    let changed: string[];
    const attemptsBefore = run.cancelledAttempts?.length ?? 0;

    if (step === undefined) {
      changed = stopWhere(run, () => true, failure, run.revision, now);
      await finish({ outcome: 'cancelled', settledAt: run.revision });
    } else {
      const state = run.steps.find((s) => s.id === step);

      if (!state) return missingStepError(run, step);

      if (!cancellable(state)) return error('not_cancellable', `Step "${state.id}" is ${state.status}; only pending, waiting, leased, running or delivering steps can be cancelled`);
      const located = locateStep(run, step);

      if (!located) return missingStepError(run, step);
      changed = state.status === 'running' ? stopWhere(run, isUnder(state.id), failure, run.revision, now) : [];
      changed.push(state.id);

      if (state.status === 'leased') stopAttempt(run, state, now);
      cancel(state, failure, run.revision, keptResults(run, state, located.step));
      const reconciled = reconcileRun(run, now);

      if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);

      if ('outcome' in reconciled) await finish(reconciled);
    }

    return ok({ cancelled: { steps: changed, attempts: run.cancelledAttempts?.slice(attemptsBefore) ?? [] }, run: runData(run) });
  });
}

interface RetryContainer {
  child: StepState;
  states: StepState[];
  cone: Set<StepState>;
  runner?: StepState;
  resetStops: boolean;
  /**
   * Whether `child`, the workflow step a step that runs again is inside, runs again itself: a step of this workflow it
   * reads a gone run-dir path from runs again, and its own steps must wait until that one wrote the path again.
   */
  rerunsChild: boolean;
}

/**
 * The steps `state` needs when it is confined, or when it is one of those itself (`isWriter`): together they write the
 * confined directory under `$TEAMAI_RUN_DIR`, from files the earlier ones left there. None for another step.
 */
function confinedWriters(input: { scope: Scope; states: StepState[]; state: StepState; isWriter: boolean }): StepState[] {
  const { scope, states, state, isWriter } = input;
  const definition = scope.definition.steps.find((step) => step.id === localId(scope, state));

  if (!isWriter && !(definition?.workspace instanceof Object && 'confined' in definition.workspace)) return [];
  const needs = new Set(definition?.needs);

  return states.filter((other) => needs.has(localId(scope, other)));
}

/**
 * Whether `value`, or a string inside it, is an absolute path inside `dir` that is gone. Compared as written: `dir` may
 * be removed, so it has no real path to resolve.
 */
function holdsGonePathIn(value: JsonValue | undefined, dir: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => holdsGonePathIn(entry, dir));

  if (isJsonObject(value)) return Object.values(value).some((entry) => holdsGonePathIn(entry, dir));
  const text = z.string().safeParse(value).data;

  if (text === undefined || !path.isAbsolute(text)) return false;
  const relative = path.relative(dir, text);

  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !fs.existsSync(text);
}

/** The fields of a step that carry what it produced: its outputs, and those of each fan-out item or pass. */
const PRODUCED_FIELDS: ReadonlySet<string> = new Set(['outputs', 'results', 'passes']);

/** The producers of gone run-dir paths a step reads: the steps of its own workflow, and the ids of those around it. */
interface RunDirProducers {
  here: StepState[];
  enclosing: string[];
}

/**
 * The steps whose outputs, results or passes `state`'s templates render where they hold a path inside `runDir`, the run's
 * `$TEAMAI_RUN_DIR`, that is gone: its run's end removed it, and a step that ran since a retry reopened the run brought
 * back only its own. A read only in `if` renders nothing, so it brings no step. `here` are those of `state`'s own
 * workflow; `enclosing`, by id, those of the workflows around it.
 */
function runDirProducers(input: { scope: Scope; states: StepState[]; state: StepState; runDir: string }): RunDirProducers {
  const { scope, states, state, runDir } = input;
  const id = localId(scope, state);
  const definition = scope.definition.steps.find((step) => step.id === id);

  if (!definition) return { here: [], enclosing: [] };
  const bindsItem = Object.hasOwn(scope, 'item') || definition.forEach !== undefined;
  const context = contextOf(scope, states, state);

  const reads = templatedTexts(definition).flatMap(({ text }) => {
    const template = parseTemplate(text, bindsItem);

    return template.ok ? templatePaths(template.template) : [];
  });

  const producers = new Set(reads.flatMap((read) => (
    read.root === 'steps' && PRODUCED_FIELDS.has(read.field) && read.step !== id && holdsGonePathIn(pathValue(read, context), runDir) ? [read.step] : []
  )));

  const here = states.filter((other) => producers.has(localId(scope, other)));
  const own = new Set(here.map((other) => localId(scope, other)));

  return { here, enclosing: [...producers].filter((producer) => !own.has(producer)) };
}

/**
 * The containers a retry of `target` resets, innermost first, each with the steps that run again in it. A step that runs
 * again takes the steps whose outputs its templates read as paths in the run's `$TEAMAI_RUN_DIR` that are gone, and
 * theirs, with it; once the run dir is gone, or such a path is, a confined step that runs again takes the steps it needs.
 */
function retryContainers(run: RunState, target: StepState, runDir: { path: string; isGone: boolean }): RetryContainer[] | WorkflowEnvelope {
  const containers: RetryContainer[] = [];
  let child = target;
  // The ids of the steps of the workflows around this one that a step running again reads gone run-dir paths from.
  const enclosing = new Set<string>();

  for (;;) {
    const located = locateStep(run, child.id);

    if (!located) return missingStepError(run, child.id);
    const { scope } = located;
    let states: StepState[];
    let runner: StepState | undefined;
    let dependencies: (state: StepState) => StepState[];
    let writers: (state: StepState, isWriter: boolean) => StepState[] = () => [];
    let reads: RunReads | undefined;

    if (isItem(child)) {
      runner = run.steps.find((state) => state.id === `${scope.prefix}${located.step.id}`);

      if (!runner) return missingStepError(run, child.id);
      states = itemsOf(run, runner);
      const after = itemsAfter(runner.id, states.map((state) => state.item));

      if (!Array.isArray(after)) return error('run_unreadable', after.message);
      dependencies = (state) => (after[states.indexOf(state)] ?? []).map((index) => states[index]!);
    } else {
      states = statesIn(run, scope);
      runner = scope.runner;
      const parsed = parseReads(run, scope);

      if (!(parsed instanceof Object)) return error('run_unreadable', parsed);
      reads = parsed;
      dependencies = (state) => {
        const id = localId(scope, state);
        const definition = scope.definition.steps.find((step) => step.id === id);
        const ids = new Set([...definition?.needs ?? [], ...parsed.reads.get(id) ?? [], ...parsed.waits.get(id) ?? []]);

        return states.filter((other) => ids.has(localId(scope, other)));
      };

      writers = (state, isWriter) => {
        const producers = runDirProducers({ scope, states, state, runDir: runDir.path });

        for (const id of producers.enclosing) enclosing.add(id);

        return [...runDir.isGone || isWriter || producers.here.length > 0 ? confinedWriters({ scope, states, state, isWriter }) : [], ...producers.here];
      };
    }

    const cone = new Set([child]);
    // The steps of this workflow an inner one read gone run-dir paths from run again, as a step of its own would bring them.
    const written = new Set(isItem(child) ? [] : states.filter((state) => enclosing.delete(localId(scope, state))));
    const rerunsChild = written.size > 0;

    for (let changed = true; changed;) {
      changed = false;

      for (const writer of [...cone].flatMap((state) => writers(state, written.has(state)))) {
        if (written.has(writer)) continue;
        written.add(writer);
        changed = true;
      }

      for (const state of states) {
        if (cone.has(state) || !(written.has(state) || dependencies(state).some((need) => cone.has(need)))) continue;
        cone.add(state);
        changed = true;
      }
    }

    let resetStops = false;

    if (reads) {
      for (const state of states) {
        if (state.status !== 'succeeded') continue;
        const id = localId(scope, state);
        const end = scope.definition.steps.find((step) => step.id === id)?.end;
        const condition = reads.breaks.get(id);
        const breaks = condition && isTruthy(evaluateExpression(condition, contextOf(scope, states, state)));

        if (end === undefined && !breaks) continue;

        if (cone.has(state)) {
          resetStops = true;
          continue;
        }

        const reached = end !== undefined ? `end "${end}" through step "${state.id}"` : `the break of step "${state.id}"`;

        return error('not_retryable', `Step "${target.id}" cannot run again: ${workflowLabel(scope)} already reached ${reached}, which does not depend on it.`);
      }
    }

    containers.push({ child, states, cone, runner, resetStops, rerunsChild });

    // A running workflow step goes on with its steps that run again, unless one of them reads a gone path from a step
    // around it, which only the workflow that holds that step can run again.
    if (!runner || (runner.status === 'running' && enclosing.size === 0)) return containers;
    child = runner;
  }
}

/**
 * Starts a new pass of a step in a retry cone. A waiting HITL request, or one answered but not yet run, is asked again,
 * because its context changed. Only an unanswered pending or skipped step stays in its pass.
 */
function retryInstance(run: RunState, state: StepState, now: string): void {
  const failure = { code: 'retried', message: 'Cancelled by teamai workflow retry' };

  switch (state.status) {
    case 'pending':
      if (!state.answer) return;
      break;
    case 'waiting':
      break;
    case 'skipped':
      if (!state.answer) {
        resetPending(state);

        return;
      }

      break;
    case 'leased':
      stopAttempt(run, state, now);
      cancel(state, failure, run.revision);
      break;
    case 'running':
    case 'delivering':
      stopWhere(run, isUnder(state.id), failure, run.revision, now);
      break;
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      break;
    default: {
      const unknown: never = state;

      return unknown;
    }
  }

  archiveUnder(run, state.id);
  repend(state);
}

/**
 * The command that starts a run like `run`: `teamai benchmark run <suite>` for the benchmark workflow, which plans its
 * suite and sets its timeout, else `teamai workflow start <name>` with the run's inputs.
 */
export function restartCommand(run: RunState): string {
  const inputs = isRecord(run.inputs) ? run.inputs : {};
  const suite = z.string().safeParse(inputs.suite).data;

  if (run.name !== 'teamai-benchmark' || suite === undefined) {
    return `teamai workflow start ${run.name}${Object.keys(inputs).length > 0 ? ` --inputs ${shellQuoteValue(JSON.stringify(inputs))}` : ''}`;
  }

  return `teamai benchmark run ${suite}${inputs.aliases === 'member' ? ' --member-aliases' : ''}`;
}

/** Why `step` of `run` cannot run again, as known before a running run is reconciled; undefined when it may. */
function retryRefusal(run: RunState, step: string, retention: ResolvedRetention, now: string): WorkflowEnvelope | undefined {
  const retainedUntil = run.status === 'running' ? undefined : runRetainedUntil(run, retention);

  // Past it, doctor --fix on any machine may remove what the run needs, and no install coordinates a reopen with it.
  if (retainedUntil !== undefined && retainedUntil <= Date.parse(now)) {
    return error('run_expired', `Run ${run.id} was not reopened: workflows.retention kept what it left until ${new Date(retainedUntil).toISOString()}, counted from when it first ended, so teamai doctor --fix may have removed its branches. Start the workflow again: ${restartCommand(run)}`);
  }

  if (isIsolated(run)) {
    return error('not_retryable', `Run ${run.id} is isolated: it runs only on the machine that started it, and a step that ran again would change what it already admitted or measured. Start a new run: ${restartCommand(run)}`);
  }

  if (run.finalizing) return error('not_retryable', `Run ${run.id} is running its finally steps; retry a step once the run ends`);

  if (run.definition.finally?.some((item) => item.id === step)) {
    return error('not_retryable', `Step "${step}" is a finally step, which runs again when the run ends again; retry a step of the run`);
  }

  return undefined;
}

/** The step a retry runs again and the workflows it runs again in, or why it cannot. */
function retryTarget(config: LocalConfig, run: RunState, step: string): { target: StepState; containers: RetryContainer[] } | WorkflowEnvelope {
  const target = run.steps.find((state) => state.id === step);

  if (!target) return missingStepError(run, step);
  const hitl = locateStep(run, target.id)?.step.hitl;

  const answeredHitl = target.answer !== undefined && ((hitl?.kind === 'approve' && target.status === 'skipped')
    || (hitl?.kind === 'choose' && target.status === 'succeeded'));

  if (target.status !== 'leased' && target.status !== 'failed' && target.status !== 'cancelled' && !answeredHitl) {
    if (target.status === 'skipped' && run.status === 'cancelled' && !run.steps.some(stopped)) {
      return error('not_retryable', `Run ${run.id} was cancelled before step "${step}" ran; start a new run`);
    }

    if (target.status === 'skipped') return error('not_retryable', `Step "${step}" is skipped; retry the step that stopped`);

    if (target.status === 'running') return error('not_retryable', `Step "${step}" is running; retry a step inside it`);

    return error('not_retryable', `Step "${step}" is ${target.status}; retry a leased or stopped step, or a HITL request to answer it again`);
  }

  // A run that settled had its $TEAMAI_RUN_DIR removed by finishRun, and a retry that reopened it brings none back.
  const runDir = runScratchDir(config, run.id);
  const containers = retryContainers(run, target, { path: runDir, isGone: run.status !== 'running' || !fs.existsSync(runDir) });

  return Array.isArray(containers) ? { target, containers } : containers;
}

/**
 * Brings back, before a retry reopens succeeded run `runId`, the branches it recorded that a cleanup deleted, here or on
 * the install it was claimed from; answers why the run is not reopened when one does not come back. A retry refused
 * anyway brings nothing back: the change under the run lock answers that refusal.
 */
async function restoreForRetry(config: LocalConfig, runId: string, step: string, retention: ResolvedRetention): Promise<WorkflowEnvelope | undefined> {
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt' || run.status !== 'succeeded') return undefined;

  if (retryRefusal(run, step, retention, new Date().toISOString()) || !('target' in retryTarget(config, run, step))) return undefined;
  // A claim keeps no driver, and takes the run into the checkout it names.
  const failed = await restoreRecordedBranches(run, run.driver?.workspace ?? run.checkout ?? process.cwd());

  if (failed.length === 0) return undefined;
  const why = failed.map(({ branch, reason }) => `Branch ${branch} is not back ${reason}.`).join(' ');

  return error('branches_not_restored', `Run ${runId} was not reopened: not every branch the run recorded is back at the commit it recorded. ${why} Try again once that is fixed: ${retryCommand(runId, step)}`);
}

/** What a retry answers under `retried`: the step, the pass it runs again as, and the other steps that run again with it. */
const RetriedSchema = z.object({ step: z.string(), pass: z.number(), runsAgain: z.array(z.string()) });

/** The other steps that run again with the retried step, by the answer of `retryStep`; none for a refusal. */
export function retriedRunsAgain(answer: WorkflowEnvelope): string[] {
  return 'data' in answer ? RetriedSchema.safeParse(answer.data.retried).data?.runsAgain ?? [] : [];
}

/** Retries a step and its dependency cone, retaining pass history and reopening a settled run. */
export async function retryStep(config: LocalConfig, runId: string, secrets: Record<string, string>, step: string): Promise<WorkflowEnvelope> {
  const retention = await resolveRetention(config, await loadTeamConfig(config.repo.localPath));

  const reopen = isRunId(runId)
    ? {
      busy: error('busy', `Cleanup of run ${runId} is removing its branches, so it was not reopened. Try again shortly: ${retryCommand(runId, step)}`),
      prepare: () => restoreForRetry(config, runId, step, retention),
    }
    : undefined;

  return controlRun(config, runId, secrets, async (run, now, finish) => {
    const refused = retryRefusal(run, step, retention, now);

    if (refused) return refused;

    // A run this reconcile finds ended, by its timeout or budget too, is reopened by the retry like a settled one.
    let ended = run.status !== 'running';

    if (!ended) {
      const reconciled = reconcileRun(run, now);

      if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);
      ended = 'outcome' in reconciled;
    }

    const planned = retryTarget(config, run, step);

    if (!('target' in planned)) return planned;
    const { target, containers } = planned;
    const reopened = run.status !== 'running';
    const again = new Set<StepState>();

    for (const container of containers) {
      if (container.child === target) {
        // A failed delivery delivers the same branch again; the agent's work it delivers does not change.
        if (target.status === 'failed' && target.failure?.code === 'delivery_failed' && target.delivery) redeliver(target, target.delivery);
        else retryInstance(run, target, now);
        resetIteration(target);
      }

      for (const state of container.states) {
        if (state === container.child) continue;

        if (container.cone.has(state) || (container.resetStops && state.status === 'cancelled' && state.failure.code === 'end_reached')) {
          again.add(state);
          retryInstance(run, state, now);
        } else if (state.status === 'skipped' && !state.answer) resetPending(state);
      }

      // A retried workflow runs again, so its timeout and budget count from now.
      const runner = container.runner && settled(container.runner) ? container.runner : undefined;
      const located = runner && locateStep(run, runner.id);

      if (runner) start(runner, undefined, located ? startLimits(run, runner, located.step, now) : undefined);

      if (container.rerunsChild) {
        again.add(container.child);
        retryInstance(run, container.child, now);
      }
    }

    if (ended) run.limitsFrom = { at: now, tokens: spentTokens(run, () => true) };

    if (reopened) {
      run.status = 'running';
      delete run.end;
      delete run.failure;
      // The branches its cleanup deleted are back, and the run's next end cleans up again.
      delete run.leftovers;
      await removeQueuedEndRecord(config, run.id);
      delete run.endRecordQueued;
    }

    run.revision += 1;
    const reconciled = reconcileRun(run, now);

    if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);

    if ('outcome' in reconciled) await finish(reconciled);

    const runsAgain = run.steps.filter((state) => again.has(state)).map((state) => state.id);
    const answered: z.infer<typeof RetriedSchema> = { step: target.id, pass: target.pass ?? 1, runsAgain };
    const retried = { retried: answered, reopened, run: runData(run) };

    return ok(reopened && run.status === 'running' ? { ...retried, resume: `teamai workflow resume ${run.id}` } : retried);
  }, { reopen });
}
