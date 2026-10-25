/** What the skill driver prints: a describe reply, a turn, or an error that names the literal to run instead. */
import path from 'node:path';
import { packagedSkillRoots } from '../../../skill-content.js';
import type { WorkflowDescription } from '../../describe.js';
import type { Judging } from '../../protocol.js';
import type { AttemptId, RunId } from '../../store.js';
import type { OutputSchema, WorkflowFailure } from '../../types.js';
import { HOST_CHOICES, HOST_PROFILES, HOST_QUESTION, type HostChoice } from './host-profiles.js';
import { ackLiteral, chooseHostLiteral, reportLiteral, unavailableLiteral, type Literal } from './literals.js';
import type { AttemptState, Dispatch, ModelPick, SkillState, StopReason, TurnEvent } from './skill-state.js';
import { childCap, reportedByAgent } from './transitions.js';

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
  /** Present when an earlier session was shown this dispatch: what to do about the child it may have started. */
  reissued?: string;
}

/** A child the agent started whose attempt the engine stopped: shown in every foreground turn until `report` runs. */
export interface StopAction {
  kind: 'stop';
  attempt: AttemptId;
  step: string;
  /** The title the child was started with. */
  title: string;
  why: StopReason;
  /** Run once the child is stopped: it gives the attempt up, and the protocol abandons its place. */
  report: Literal;
}

export type Action =
  /** The agent's own answer, once per run with prompt steps: how its host runs a child. */
  | { kind: 'choose'; about: 'host'; decide: 'agent'; question: string; options: Array<{ id: HostChoice; label: string; run: Literal }>; reference: string }
  | StopAction
  | DispatchAction
  /** `judging`: the judge running now, on the pass of `step` that `scorers` judge. */
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure; prs: string[]; judging?: { step: string; scorers: string[] } };

export interface RunningEntry {
  attempt: AttemptId;
  step: string;
  phase: AttemptState['phase'];
  /** For a dispatch or a stop the agent makes: the literal that reports it, so a returning child is linked back by attempt. */
  report?: Literal;
}

export interface Turn {
  run: RunId;
  status: 'driving' | 'done';
  actions: Action[];
  running: RunningEntry[];
  events: TurnEvent[];
  /**
   * Why the run leases nothing, when no attempt is open. An open attempt is in `running` already, and a call that leased
   * one would otherwise show no reason where its repeat shows one.
   */
  waiting?: { reason: string };
  /**
   * The call to make next: `poll` in the background, or `wake` in the foreground when work waits for the agent.
   * Absent once the run is done and none of its attempts, and no judge of it, is open.
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
  /** `orchestrator_active`: the seconds since the session that drives the run last called, for the person to judge whether it is gone. */
  idleSeconds?: number;
  next: Literal | null;
}

export type SkillAnswer =
  | { data: { describe: { workflow: WorkflowDescription; judging: Judging; ask: DescribeAsk } } }
  | { data: { turn: Turn } }
  /**
   * What a runner answers once it is done with its attempt, and what an agent's report answers: `reported`; `repeated`
   * when the attempt was settled before; `offered` to the agent; `queued` behind the attempt that holds its place;
   * `gone` when the attempt closed without its report; or `held` when another live runner of the attempt holds its lock
   * and this call did nothing.
   */
  | { data: { runner: { attempt: AttemptId; status: 'reported' | 'repeated' | 'offered' | 'queued' | 'gone' | 'held' } } }
  | { error: SkillError };

/** The skill-data reference the host question points to. */
function hostsReference(): string {
  return path.join(packagedSkillRoots().dataRoot, 'workflow', 'references', 'hosts.md');
}

function titleOf(run: RunId, open: AttemptState): string {
  return `${run}/${open.attempt} ${open.step}`;
}

function dispatchOf(state: SkillState, open: Extract<AttemptState, { phase: 'offered' | 'dispatched' }>): DispatchAction {
  const { attempt, step, dispatch } = open;
  const { invocation, run } = state;
  return {
    kind: 'dispatch', offer: `dispatch.${attempt}`, attempt, step, title: titleOf(run, open),
    needs: { place: dispatch.place, parallel: childCap(state) > 1 },
    dir: dispatch.dir, brief: dispatch.brief, ...(dispatch.agent !== undefined ? { agent: dispatch.agent } : {}), model: dispatch.model,
    ack: ackLiteral(invocation, run, attempt), report: reportLiteral(invocation, run, attempt),
    ...(dispatch.model.by !== 'definition' ? { unavailable: unavailableLiteral(invocation, run, attempt) } : {}),
    ...(open.phase === 'offered' && open.reissued ? { reissued: `An earlier session was given this dispatch, and its child may still run as ${titleOf(run, open)}. Stop that child if you can reach it, then dispatch this one.` } : {}),
  };
}

/**
 * What waits for the agent: the host question; else every child to stop, then every dispatch not acked yet; and the
 * end once the run is done.
 */
function actionsOf(state: SkillState): Action[] {
  if (state.host.kind === 'pending') {
    const options = HOST_CHOICES.map((id) => ({ id, label: HOST_PROFILES[id].label, run: chooseHostLiteral(state.invocation, state.run, id) }));
    return [{ kind: 'choose', about: 'host', decide: 'agent', question: HOST_QUESTION, options, reference: hostsReference() }];
  }
  const stops = state.attempts.flatMap((open): StopAction[] => (open.phase === 'stopping' && open.by === 'agent'
    ? [{ kind: 'stop', attempt: open.attempt, step: open.step, title: titleOf(state.run, open), why: open.why, report: reportLiteral(state.invocation, state.run, open.attempt) }]
    : []));
  const offers = state.attempts.flatMap((open) => (open.phase === 'offered' ? [dispatchOf(state, open)] : []));
  const judge = state.judging?.open;
  const end: Action[] = state.done ? [{
    kind: 'done', outcome: state.done.outcome, ...(state.done.failure ? { failure: state.done.failure } : {}), prs: [], ...(judge ? { judging: { step: judge.step, scorers: judge.scorers } } : {}),
  }] : [];
  return [...stops, ...offers, ...end];
}

/**
 * The turn of `state` that shows `events`, with `after` as its `then` while the run drives, or an attempt or a judge of
 * it is open. A `quiet` turn carries no action.
 */
export function turnOf(state: SkillState, input: { events: TurnEvent[]; after?: NonNullable<Turn['then']>; waiting?: { reason: string }; quiet?: true }): Turn {
  const running = state.attempts.map((open): RunningEntry => ({
    attempt: open.attempt, step: open.step, phase: open.phase, ...(reportedByAgent(open) ? { report: reportLiteral(state.invocation, state.run, open.attempt) } : {}),
  }));
  return {
    run: state.run,
    status: state.done ? 'done' : 'driving',
    actions: input.quiet ? [] : actionsOf(state),
    running,
    events: input.events,
    ...(input.waiting && !state.done && state.attempts.length === 0 ? { waiting: input.waiting } : {}),
    // `then` is a value, never a function, so awaiting a turn does not treat it as a promise.
    // oxlint-disable-next-line unicorn/no-thenable
    ...(input.after && (!state.done || state.attempts.length > 0 || state.judging?.open) ? { then: input.after } : {}),
  };
}
