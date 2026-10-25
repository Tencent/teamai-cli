/** What the skill driver prints: a describe reply, a turn, or an error that names the literal to run instead. */
import path from 'node:path';
import { packagedSkillRoots } from '../../../skill-content.js';
import type { WorkflowDescription } from '../../describe.js';
import type { AttemptId, RunId } from '../../store.js';
import type { OutputSchema, WorkflowFailure } from '../../types.js';
import { HOST_CHOICES, HOST_PROFILES, HOST_QUESTION, type HostChoice } from './host-profiles.js';
import { ackLiteral, chooseHostLiteral, reportLiteral, unavailableLiteral, type Literal } from './literals.js';
import type { AttemptState, Dispatch, ModelPick, SkillState, TurnEvent } from './skill-state.js';
import { childCap } from './transitions.js';

/** How describe says to start: as is, after one question to the person, or with the local driver. */
export type DescribeAsk =
  | { kind: 'start'; start: Literal }
  | {
    kind: 'ask';
    question: {
      text: string;
      /** The inputs the person fills in; the agent puts their answers, as JSON, in each option's `{inputs}` slot. */
      inputs: Array<{ name: string; type: OutputSchema }>;
      options: Array<{ label: string; start: Literal }>;
    };
  }
  | { kind: 'local'; reason: string; start: Literal };

/** A prompt step for a child agent, shown in every foreground turn until its `ack` runs. */
export interface DispatchAction {
  kind: 'dispatch';
  offer: `dispatch.${string}`;
  attempt: AttemptId;
  step: string;
  /** `<run>/<attempt> <step>`: the child's name, so an agent that lost the ack can tell the child exists. */
  title: string;
  /** `parallel`: the child may run beside other children of the run. */
  needs: { place: Dispatch['place']; parallel: boolean };
  dir: string;
  /** The masked brief the child works from: the prompt, where to work, the result to write and the report to run. */
  brief: string;
  agent?: string;
  model: ModelPick;
  ack: Literal;
  report: Literal;
  /** Present when the model names one: run it instead when the host cannot run that model. */
  unavailable?: Literal;
}

export type Action =
  /** The agent's own answer, once per run with prompt steps: how its host runs a child. */
  | { kind: 'choose'; about: 'host'; decide: 'agent'; question: string; options: Array<{ id: HostChoice; label: string; run: Literal }>; reference: string }
  | DispatchAction
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure; prs: string[] };

export interface RunningEntry {
  attempt: AttemptId;
  step: string;
  phase: AttemptState['phase'];
  /** For a dispatch: the literal that reports it, so a returning child is linked back by attempt. */
  report?: Literal;
}

export interface Turn {
  run: RunId;
  status: 'driving' | 'done';
  actions: Action[];
  running: RunningEntry[];
  events: TurnEvent[];
  /** Why the run leased nothing more, when it did not. */
  waiting?: { reason: string };
  /**
   * The call to make next: `poll` in the background, or `wake` in the foreground when work waits for the agent.
   * Absent once the run is done.
   */
  then?: { kind: 'poll' | 'wake'; run: Literal };
}

/** An error the agent can act on: `next` is the literal to run instead, or null when only the person can act. */
export interface SkillError {
  /** The skill driver's own codes. An engine or protocol code is relayed as written. */
  code:
    | 'confirm_needed' | 'needs_local_driver' | 'not_skill_run' | 'orchestrator_active' | 'choice_pending' | 'unknown_choice' | 'unknown_offer'
    | 'unknown_attempt' | 'not_dispatched' | (string & {});
  message: string;
  next: Literal | null;
}

export type SkillAnswer =
  | { data: { describe: { workflow: WorkflowDescription; ask: DescribeAsk } } }
  | { data: { turn: Turn } }
  /**
   * What a runner answers once it is done with its attempt: `reported`; `offered` to the agent; `queued` behind the
   * attempt that holds its place; `gone` when the attempt closed without its report; or `held` when another live
   * runner of the attempt holds its lock and this call did nothing.
   */
  | { data: { runner: { attempt: AttemptId; status: 'reported' | 'offered' | 'queued' | 'gone' | 'held' } } }
  | { error: SkillError };

/** The skill-data reference the host question points to. */
function hostsReference(): string {
  return path.join(packagedSkillRoots().dataRoot, 'workflow', 'references', 'hosts.md');
}

function dispatchOf(state: SkillState, open: Extract<AttemptState, { phase: 'offered' | 'dispatched' }>): DispatchAction {
  const { attempt, step, dispatch } = open;
  const { invocation, run } = state;
  return {
    kind: 'dispatch', offer: `dispatch.${attempt}`, attempt, step, title: `${run}/${attempt} ${step}`,
    needs: { place: dispatch.place, parallel: childCap(state) > 1 },
    dir: dispatch.dir, brief: dispatch.brief, ...(dispatch.agent !== undefined ? { agent: dispatch.agent } : {}), model: dispatch.model,
    ack: ackLiteral(invocation, run, attempt), report: reportLiteral(invocation, run, attempt),
    ...(dispatch.model.by !== 'definition' ? { unavailable: unavailableLiteral(invocation, run, attempt) } : {}),
  };
}

/** What waits for the agent: the host question, else every dispatch not acked yet, else the end. */
function actionsOf(state: SkillState): Action[] {
  if (state.done) return [{ kind: 'done', outcome: state.done.outcome, ...(state.done.failure ? { failure: state.done.failure } : {}), prs: [] }];
  if (state.host.kind === 'pending') {
    const options = HOST_CHOICES.map((id) => ({ id, label: HOST_PROFILES[id].label, run: chooseHostLiteral(state.invocation, state.run, id) }));
    return [{ kind: 'choose', about: 'host', decide: 'agent', question: HOST_QUESTION, options, reference: hostsReference() }];
  }
  return state.attempts.flatMap((open) => (open.phase === 'offered' ? [dispatchOf(state, open)] : []));
}

/** The turn of `state` that shows `events`, with `after` as its `then` unless the run is done. A `quiet` turn carries no action. */
export function turnOf(state: SkillState, input: { events: TurnEvent[]; after?: NonNullable<Turn['then']>; waiting?: { reason: string }; quiet?: true }): Turn {
  const running = state.attempts.map(({ attempt, step, phase }): RunningEntry => ({
    attempt, step, phase, ...(phase === 'offered' || phase === 'dispatched' ? { report: reportLiteral(state.invocation, state.run, attempt) } : {}),
  }));
  return {
    run: state.run,
    status: state.done ? 'done' : 'driving',
    actions: input.quiet ? [] : actionsOf(state),
    running,
    events: input.events,
    ...(input.waiting && !state.done ? { waiting: input.waiting } : {}),
    // `then` is a value, never a function, so awaiting a turn does not treat it as a promise.
    // oxlint-disable-next-line unicorn/no-thenable
    ...(input.after && !state.done ? { then: input.after } : {}),
  };
}
