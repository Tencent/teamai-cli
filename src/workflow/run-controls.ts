import type { LocalConfig } from '../types.js';
import { agentEvidence, type AgentEvidence } from './attempt-marker.js';
import {
  error, finishRun, locateStep, ok, parseReads, reconcileRun, respondCommand, runData, withRun, workflowLabel,
  type RunReads, type WorkflowResult,
} from './engine.js';
import { evaluateExpression, isTruthy } from './expression.js';
import { isItem, itemsAfter, itemsOf } from './fan-out.js';
import { publishRunEnd } from './handoff.js';
import { archiveUnder, isUnder } from './loop.js';
import { spentTokens, startLimits } from './limits.js';
import { publishRunRecords, removeQueuedEndRecord } from './records.js';
import { contextOf, localId, statesIn } from './scope.js';
import { answerHitl, cancel, cancellable, redeliver, repend, resetIteration, resetPending, settled, start, stopAttempt, stopWhere, stopped, type StepState } from './step-state.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from './types.js';

async function controlRun(
  config: LocalConfig,
  runId: string,
  secrets: Record<string, string>,
  operation: (run: RunState, now: string, finish: (result: WorkflowResult) => Promise<void>) => Promise<WorkflowEnvelope>,
): Promise<WorkflowEnvelope> {
  let queued = false;
  let settled = false;
  let checkout = process.cwd();
  const envelope = await withRun(config, runId, secrets, async (run, now) => {
    const before = JSON.stringify(run);
    checkout = run.driver?.workspace ?? checkout;
    const finish = async (result: WorkflowResult): Promise<void> => {
      settled = true;
      queued = await finishRun(config, run, now, result, secrets, run.driver);
    };
    const envelope = await operation(run, now, finish);
    return { envelope, save: JSON.stringify(run) !== before };
  });
  // Not on a control that only found a run already ended: its answer is an error, and the end was published before.
  // A control that settled the run answers with an error too, and still publishes its end.
  const notPublished = 'data' in envelope || settled ? await publishRunEnd(config, runId, checkout) : undefined;
  if (queued) await publishRunRecords(config);
  if (notPublished && 'data' in envelope) envelope.data.notPublished = notPublished;
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
    answerHitl(state, { choice: input.choice, ...(input.note !== undefined ? { note: input.note } : {}), at: now, channel, agent, ...(driver ? { driver } : {}) });
    const reconciled = reconcileRun(run, now);
    if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);
    if ('outcome' in reconciled) await finish(reconciled);
    return ok({ answered, run: runData(run) });
  });
}

/** Stops a whole run or one open step and invalidates the attempts it cancelled. */
export async function cancelRun(config: LocalConfig, runId: string, secrets: Record<string, string>, step?: string): Promise<WorkflowEnvelope> {
  return controlRun(config, runId, secrets, async (run, now, finish) => {
    if (run.status !== 'running') return settledRunError(run);
    const failure = { code: 'cancelled', message: 'Cancelled by teamai workflow cancel' };
    if (step !== undefined) {
      const reconciled = reconcileRun(run, now);
      if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);
      if ('outcome' in reconciled) {
        await finish(reconciled);
        return settledRunError(run);
      }
    }
    let changed: string[];
    const attemptsBefore = run.cancelledAttempts?.length ?? 0;
    if (step === undefined) {
      changed = stopWhere(run, () => true, failure, run.revision, now);
      await finish({ outcome: 'cancelled', settledAt: run.revision });
    } else {
      const state = run.steps.find((state) => state.id === step);
      if (!state) return missingStepError(run, step);
      if (!cancellable(state)) return error('not_cancellable', `Step "${state.id}" is ${state.status}; only pending, waiting, leased, running or delivering steps can be cancelled`);
      const located = locateStep(run, step);
      if (!located) return missingStepError(run, step);
      changed = state.status === 'running' ? stopWhere(run, isUnder(state.id), failure, run.revision, now) : [];
      changed.push(state.id);
      if (state.status === 'leased') stopAttempt(run, state, now);
      cancel(state, failure, run.revision);
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
}

function retryContainers(run: RunState, target: StepState): RetryContainer[] | WorkflowEnvelope {
  const containers: RetryContainer[] = [];
  let child = target;
  for (;;) {
    const located = locateStep(run, child.id);
    if (!located) return missingStepError(run, child.id);
    const { scope } = located;
    let states: StepState[];
    let runner: StepState | undefined;
    let dependencies: (state: StepState) => StepState[];
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
      if (typeof parsed === 'string') return error('run_unreadable', parsed);
      reads = parsed;
      dependencies = (state) => {
        const id = localId(scope, state);
        const definition = scope.definition.steps.find((step) => step.id === id);
        const ids = new Set([...definition?.needs ?? [], ...parsed.reads.get(id) ?? [], ...parsed.waits.get(id) ?? []]);
        return states.filter((other) => ids.has(localId(scope, other)));
      };
    }
    const cone = new Set([child]);
    for (let changed = true; changed;) {
      changed = false;
      for (const state of states) {
        if (cone.has(state) || !dependencies(state).some((need) => cone.has(need))) continue;
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
    containers.push({ child, states, cone, runner, resetStops });
    if (!runner || runner.status === 'running') return containers;
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

/** Retries a step and its dependency cone, retaining pass history and reopening a settled run. */
export async function retryStep(config: LocalConfig, runId: string, secrets: Record<string, string>, step: string): Promise<WorkflowEnvelope> {
  return controlRun(config, runId, secrets, async (run, now, finish) => {
    // A run this reconcile finds ended, by its timeout or budget too, is reopened by the retry like a settled one.
    let ended = run.status !== 'running';
    if (!ended) {
      const reconciled = reconcileRun(run, now);
      if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);
      ended = 'outcome' in reconciled;
    }
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
    const containers = retryContainers(run, target);
    if (!Array.isArray(containers)) return containers;
    const reopened = run.status !== 'running';
    for (const container of containers) {
      if (container.child === target) {
        // A failed delivery delivers the same branch again; the agent's work it delivers does not change.
        if (target.status === 'failed' && target.failure?.code === 'delivery_failed' && target.delivery) redeliver(target, target.delivery);
        else retryInstance(run, target, now);
        resetIteration(target);
      }
      for (const state of container.states) {
        if (state === container.child) continue;
        if (container.cone.has(state) || (container.resetStops && state.status === 'cancelled' && state.failure.code === 'end_reached')) retryInstance(run, state, now);
        else if (state.status === 'skipped' && !state.answer) resetPending(state);
      }
      // A retried workflow runs again, so its timeout and budget count from now.
      const runner = container.runner && settled(container.runner) ? container.runner : undefined;
      const located = runner && locateStep(run, runner.id);
      if (runner) start(runner, undefined, located ? startLimits(run, runner, located.step, now) : undefined);
    }
    if (ended) run.limitsFrom = { at: now, tokens: spentTokens(run, () => true) };
    if (reopened) {
      run.status = 'running';
      delete run.end;
      delete run.failure;
      await removeQueuedEndRecord(config, run.id);
      delete run.endRecordQueued;
    }
    run.revision += 1;
    const reconciled = reconcileRun(run, now);
    if ('unreadable' in reconciled) return error('run_unreadable', reconciled.unreadable);
    if ('outcome' in reconciled) await finish(reconciled);
    return ok({ retried: { step: target.id, pass: target.pass ?? 1 }, reopened, run: runData(run),
      ...(reopened && run.status === 'running' ? { resume: `teamai workflow resume ${run.id}` } : {}) });
  });
}
