/** What the skill driver prints: a describe reply, a turn, or an error that names the literal to run instead. */
import path from 'node:path';
import { packagedSkillRoots } from '../../../skill-content.js';
import type { WorkflowDescription } from '../../describe.js';
import type { Judging } from '../../protocol.js';
import type { AttemptId, RunId } from '../../store.js';
import type { OutputSchema, WorkflowFailure } from '../../types.js';
import { HOST_CHOICES, HOST_PROFILES, HOST_QUESTION, type HostChoice } from './host-profiles.js';
import {
  ackLiteral, adoptLiteral, chooseHostLiteral, localStartLiteral, nextLiteral, personRespondLiteral, pollLiteral, reportLiteral, respondLiteral, resumeLiteral,
  sessionJudgeLiteral, skillResumeLiteral, takeoverLiteral, unavailableLiteral, type Invocation, type Literal,
} from './literals.js';
import type { AttemptState, Dispatch, Gate, ModelPick, SkillState, StopReason, TurnEvent } from './skill-state.js';
import { childCap, reportedByAgent, type Answer, type Refusal } from './transitions.js';

/** How describe says to start: as is, after one question to the person, or with the local driver. */
export type DescribeAsk =
  /**
   * `say`: the facts to tell the person before running `start`, a line each. `inputs`: in an unattended run, the inputs
   * the agent fills `start`'s `{inputs}` slot with, as JSON, from its own task.
   */
  | { kind: 'start'; say?: string; start: Literal; inputs?: Array<{ name: string; type: OutputSchema }> }
  | {
    kind: 'ask';
    question: {
      text: string;
      /** The inputs the person fills in; the agent puts their answers, as JSON, in each option's `{inputs}` slot. */
      inputs: Array<{ name: string; type: OutputSchema }>;
      options: Array<{ label: string; start: Literal }>;
    };
  }
  | { kind: 'local'; reason: string; start: Literal }
  /** The session names no tool the run needs: the agent fills `describe`'s `{tool}` slot with the one of `tools` it works in, and describes again. */
  | { kind: 'tool'; reason: string; describe: Literal; tools: string[] }
  /** `invoke: deny` asked from an agent session, or a start this checkout would refuse for its delivery: no literal. */
  | { kind: 'denied'; reason: string };

/** A prompt step for a child agent, shown in every foreground turn until its `ack` runs. */
export interface DispatchAction {
  kind: 'dispatch';
  offer: `dispatch.${string}`;
  attempt: AttemptId;
  step: string;
  /** `<step>-<attempt>`, a valid agent name: the child's name, so an agent that lost the ack can tell the child exists. */
  title: string;
  /**
   * `parallel`: the child may run beside other children of the run. `person`: the agent works the step itself, with the
   * person. `isolation`: the step requires a sandbox, which TeamAI does not enforce.
   */
  needs: { place: Dispatch['place']; parallel: boolean; person: boolean; isolation?: 'sandbox' };
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

/**
 * A step whose child works in a place the host makes: shown in every foreground turn until `adopt` runs. The host
 * makes a worktree of this repository named `name`, on `branch` from commit `start`, and `adopt`, with its directory
 * in the `{dir}` slot, hands it to TeamAI.
 */
export interface PlaceAction {
  kind: 'place';
  attempt: AttemptId;
  step: string;
  name: string;
  branch: string;
  start: string;
  adopt: Literal;
  /** Why the place adopted last was refused: what to fix in it, or make another. */
  refused?: string;
  /** The skill-data reference on host places. */
  reference: string;
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

/**
 * An optional gate, shown in every foreground turn until it is answered. `decide: person`: the agent asks the person
 * `question` and runs the `run` of their answer; `decide: agent`: the agent runs the `run` of its best recommendation.
 */
export interface GateAction {
  kind: 'choose';
  about: 'gate';
  decide: 'person' | 'agent';
  step: string;
  pass: number;
  question: string;
  default?: string;
  options: Array<{ choice: string; run: Literal }>;
}

/** A required approval, shown in every foreground turn until the person answers it. The agent shows `run` and never runs it. */
export interface PersonAction {
  kind: 'person';
  why: 'approval';
  step: string;
  pass: number;
  message: string;
  say: string;
  run: Literal[];
}

/**
 * Only steps held from this driver are left, and nothing of the run is open but a gate the turn shows: the person
 * continues the run with the local driver. The agent shows `run` and never runs it, and the turn has no `then`, so its
 * loop ends here.
 */
export interface HandoffAction {
  kind: 'person';
  why: 'handoff';
  held: NonNullable<Waiting['held']>;
  message: string;
  say: string;
  run: Literal[];
}

export type Action =
  /** The agent's own answer, once per run with prompt steps: how its host runs a child. */
  | { kind: 'choose'; about: 'host'; decide: 'agent'; question: string; options: Array<{ id: HostChoice; label: string; run: Literal }>; reference: string }
  | StopAction
  | DispatchAction
  | PlaceAction
  | GateAction
  | PersonAction
  | HandoffAction
  /**
   * `judging`: the judge running now, on the pass of `step` that `scorers` judge. `score`: the `score --next` that leases
   * the run's judge work to the session's own judge, when the session judges the run.
   */
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure; prs: string[]; judging?: { step: string; scorers: string[] }; score?: Literal };

export interface RunningEntry {
  attempt: AttemptId;
  step: string;
  phase: AttemptState['phase'];
  /** For a dispatch or a stop the agent makes: the literal that reports it, so a returning child is linked back by attempt. */
  report?: Literal;
}

/**
 * Why the run leases nothing. `delivering`: steps whose pull requests teamai is opening; the run goes on once they are.
 * `held`: steps the engine holds from this driver, with what each needs that it does not declare.
 */
export interface Waiting {
  reason: string;
  delivering?: string[];
  held?: Array<{ step: string; missing: string[] }>;
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
  waiting?: Waiting;
  /**
   * The call to make next: `poll` in the background, or `wake` in the foreground when work waits for the agent.
   * Absent once the run is done and none of its attempts, and no judge of it, is open, and while a handoff shows.
   */
  then?: { kind: 'poll' | 'wake'; run: Literal };
}

/** An error the agent can act on: `next` is the literal to run instead, or null when only the person can act. */
export interface SkillError {
  /** A refusal of the transitions, or the driver's own code for a call or state it cannot read. An engine or protocol code is relayed as written. */
  code: Refusal['code'] | 'run_unreadable' | 'invalid_arguments' | 'invalid_json' | (string & {});
  message: string;
  /** `orchestrator_active`: the seconds since the session that drives the run last called, for the person to judge whether it is gone. */
  idleSeconds?: number;
  next: Literal | null;
}

/**
 * The error a row answers, with its message and the literal to run instead. `run` names the run of an engine error;
 * `localTool`, the prompt tool a local start or resume the refusal prints names (`localPromptTool`).
 */
export function errorOf(answer: Answer, context: { invocation: Invocation; same: Literal; run?: RunId; localTool?: string; tool?: string }): SkillError {
  const { invocation, same } = context;
  if (answer.kind === 'engine-error') {
    const next = answer.next === null ? null : context.run === undefined || answer.next === 'same' ? same : answer.next === 'poll' ? pollLiteral(invocation, context.run) : nextLiteral(invocation, context.run);
    return { ...answer.error, next };
  }
  const { refusal } = answer;
  return {
    code: refusal.code, message: refusalMessage(refusal, { invocation, tool: context.localTool }), ...(refusal.code === 'orchestrator_active' ? { idleSeconds: refusal.idleSeconds } : {}),
    next: refusalNext(refusal, { invocation, same, tool: context.tool }),
  };
}

/**
 * The literal each refusal names to run instead, null when only the person can act on it; `same` is the call refused,
 * and `tool` the tool it declared.
 */
function refusalNext(refusal: Refusal, context: { invocation: Invocation; same: Literal; tool?: string }): Literal | null {
  const { invocation } = context;
  switch (refusal.code) {
    case 'needs_local_driver':
      return null;
    case 'confirm_needed':
      // Only a start is refused for it, and its describe keeps the tool the start declared.
      return context.same;
    case 'not_skill_run':
      return skillResumeLiteral(invocation, refusal.run, { tool: refusal.toolNamed ? undefined : '{tool}' });
    case 'tool_needed':
      // The claim the refused call made stands.
      return skillResumeLiteral(invocation, refusal.run, { ...refusal.answers, noJudge: refusal.answers.judge === false, confirmed: refusal.confirmed, tool: '{tool}' });
    case 'not_owner':
    case 'run_not_found':
      return skillResumeLiteral(invocation, refusal.run, { claim: true, tool: context.tool });
    case 'orchestrator_active':
      return takeoverLiteral(invocation, refusal.run);
    case 'choice_pending':
    case 'unknown_choice':
    case 'unknown_offer':
    case 'unknown_attempt':
    case 'not_dispatched':
      return nextLiteral(invocation, refusal.run);
    case 'driver_running':
      return context.same;
    default: {
      const unhandled: never = refusal;
      return unhandled;
    }
  }
}

/** The message of each refusal: what happened, and what the agent or the person does next. */
function refusalMessage(refusal: Refusal, local: { invocation: Invocation; tool?: string | undefined }): string {
  switch (refusal.code) {
    case 'needs_local_driver': {
      const literal = refusal.run === undefined ? localStartLiteral(local.invocation, refusal.name, { tool: local.tool }) : resumeLiteral(local.invocation, refusal.run, { tool: local.tool });
      return `Workflow ${refusal.name} must run with the local driver. ${refusal.reason} Ask the person to run ${literal} in their own terminal.`;
    }
    case 'confirm_needed': {
      const lacks = refusal.missing.map((answer) => ({
        confirmed: '--confirmed, the person\'s yes', inputs: '--inputs', parallel: '--parallel', hitl: '--hitl or --auto-approve', tool: '--tools default=<tool>, the tool this coding session works in',
      })[answer]);
      const said = [
        ...(lacks.length > 0 ? [`it needs ${lacks.join(', ')}`] : []),
        ...(refusal.outOfRange ? [`--parallel ${refusal.outOfRange.parallel} is above the most this machine runs at once, ${refusal.outOfRange.ceiling}`] : []),
      ];
      // The tool is the agent's own answer, which describe asks it for.
      const act = refusal.missing.some((answer) => answer !== 'tool') || refusal.outOfRange ? 'Run the describe literal and ask the person.' : 'Run the describe literal.';
      return `Start ${refusal.name} from its describe reply: ${said.join('; ')}. ${act}`;
    }
    case 'not_skill_run':
      return `Run ${refusal.run} is not driven by the skill driver on this machine. Ask the person whether to continue it from this session, and run the command in next only when they agree: it takes the run over from the machine that last drove it. The person can instead continue it in a terminal with ${resumeLiteral(local.invocation, refusal.run, { tool: local.tool })}.`;
    case 'tool_needed':
      return `Run ${refusal.run} needs the tool this coding session works in, for the models of its steps or its judging, and it names none.`;
    case 'not_owner':
      return `Run ${refusal.run} is owned by ${refusal.owner}, who claimed it at ${refusal.since}. Ask the person whether that install is done with it, and run the command in next only when they agree to take it from there; otherwise the run goes on there.`;
    case 'run_not_found':
      return `Run ${refusal.run} is not on this machine, so there is no session to take it over from. Ask the person whether to take it from the machine that published it, and run the command in next only when they agree.`;
    case 'orchestrator_active':
      return `Run ${refusal.run} is driven by another coding session, which last called ${refusal.idleSeconds} s ago. Ask the person whether that session is gone, and run the command in next only when they agree to take the run over here; otherwise the run goes on from that session.`;
    case 'choice_pending':
      return `Run ${refusal.run} waits for the host question. Run the next literal, then the run of the option that fits your host.`;
    case 'unknown_choice':
      return `Run ${refusal.run} asks no host question now: its host is already chosen, or nothing in it needs a child agent. Run the next literal to see the run.`;
    case 'unknown_offer':
      return `Attempt ${refusal.attempt} of run ${refusal.run} has no dispatch to ack. Run the next literal to see the run.`;
    case 'unknown_attempt':
      return refusal.phase === undefined
        ? `Attempt ${refusal.attempt} is not open in run ${refusal.run}. Run the next literal to see the run.`
        : `Attempt ${refusal.attempt} of run ${refusal.run} is ${refusal.phase} and waits for no place, so nothing was adopted. Run the next literal to see the run.`;
    case 'not_dispatched':
      return `Attempt ${refusal.attempt} of run ${refusal.run} is ${refusal.phase}: teamai runs it and reports it, so there is nothing to report yet. Run the next literal to see the run.`;
    case 'driver_running':
      return `Run ${refusal.run} is busy: another teamai process holds its driver lock. Run the same call again.`;
    default: {
      const unhandled: never = refusal;
      return unhandled;
    }
  }
}

export type SkillAnswer =
  | { data: { describe: { workflow: WorkflowDescription; judging: Judging; ask: DescribeAsk } } }
  | { data: { turn: Turn } }
  /**
   * What a runner answers once it is done with its attempt, and what an agent's report answers: `reported`; `repeated`
   * when the attempt was settled before; `offered` to the agent; `queued` behind the attempt that holds its place;
   * `placing` when it waits for the agent to adopt a place its host made; `gone` when the attempt closed without its
   * report; or `held` when another live runner of the attempt holds its lock and this call did nothing.
   */
  | { data: { runner: { attempt: AttemptId; status: 'reported' | 'repeated' | 'offered' | 'queued' | 'placing' | 'gone' | 'held' } } }
  | { error: SkillError };

/** The skill-data reference `name` of the workflow guide. */
function reference(name: 'hosts.md' | 'places.md'): string {
  return path.join(packagedSkillRoots().dataRoot, 'workflow', 'references', name);
}

/**
 * The name a child runs under, valid as an agent or teammate name (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): `<step>-<attempt>`,
 * each other character of the step path mapped to `-`, the step cut so the whole fits 64 characters.
 */
function titleOf(open: AttemptState): string {
  const suffix = `-${open.attempt}`;
  return `${open.step.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64 - suffix.length)}${suffix}`;
}

function dispatchOf(state: SkillState, open: Extract<AttemptState, { phase: 'offered' | 'dispatched' }>): DispatchAction {
  const { attempt, step, dispatch } = open;
  const { invocation, run } = state;
  return {
    kind: 'dispatch', offer: `dispatch.${attempt}`, attempt, step, title: titleOf(open),
    needs: { place: dispatch.place, parallel: childCap(state) > 1 && !dispatch.person, person: dispatch.person === true, ...(dispatch.isolation ? { isolation: dispatch.isolation } : {}) },
    dir: dispatch.dir, brief: dispatch.brief, ...(dispatch.agent !== undefined ? { agent: dispatch.agent } : {}), model: dispatch.model,
    ack: ackLiteral(invocation, run, attempt), report: reportLiteral(invocation, run, attempt),
    ...(dispatch.model.by !== 'definition' ? { unavailable: unavailableLiteral(invocation, run, attempt) } : {}),
    ...(open.phase === 'offered' && open.reissued ? { reissued: `An earlier session was given this dispatch, and its child may still run as ${titleOf(open)}. Stop that child if you can reach it, then dispatch this one.` } : {}),
  };
}

/** The action of `gate`: the person's approval, or the agent's choice. */
function gateAction(state: SkillState, gate: Gate): GateAction | PersonAction {
  const { step, pass, message } = gate;
  if (gate.required) {
    return {
      kind: 'person', why: 'approval', step, pass, message,
      say: 'Only you can answer this approval. Run one of these commands in your own terminal, or answer it in teamai dashboard.',
      run: gate.options.map((choice) => personRespondLiteral(state.invocation, state.run, { step, pass, choice })),
    };
  }
  return {
    kind: 'choose', about: 'gate', decide: gate.decide, step, pass, question: message, ...(gate.default !== undefined ? { default: gate.default } : {}),
    options: gate.options.map((choice) => ({ choice, run: respondLiteral(state.invocation, state.run, { step, pass, choice }) })),
  };
}

/**
 * What waits for the agent: the host question; else every child to stop, then every dispatch not acked yet, then every
 * place to adopt, then the gate; and the end once the run is done.
 */
function actionsOf(state: SkillState): Action[] {
  if (state.host.kind === 'pending') {
    const options = HOST_CHOICES.map((id) => ({ id, label: HOST_PROFILES[id].label, run: chooseHostLiteral(state.invocation, state.run, id) }));
    return [{ kind: 'choose', about: 'host', decide: 'agent', question: HOST_QUESTION, options, reference: reference('hosts.md') }];
  }
  const stops = state.attempts.flatMap((open): StopAction[] => (open.phase === 'stopping' && open.by === 'agent'
    ? [{ kind: 'stop', attempt: open.attempt, step: open.step, title: titleOf(open), why: open.why, report: reportLiteral(state.invocation, state.run, open.attempt) }]
    : []));
  const offers = state.attempts.flatMap((open) => (open.phase === 'offered' ? [dispatchOf(state, open)] : []));
  const places = state.attempts.flatMap((open): PlaceAction[] => (open.phase === 'placing'
    ? [{
      kind: 'place', attempt: open.attempt, step: open.step, ...open.ask, adopt: adoptLiteral(state.invocation, state.run, open.attempt),
      ...(open.refused !== undefined ? { refused: open.refused } : {}), reference: reference('places.md'),
    }]
    : []));
  const judge = state.judging?.open;
  const end: Action[] = state.done ? [{
    kind: 'done', outcome: state.done.outcome, ...(state.done.failure ? { failure: state.done.failure } : {}), prs: state.done.prs, ...(judge ? { judging: { step: judge.step, scorers: judge.scorers } } : {}),
    ...(state.sessionJudge ? { score: sessionJudgeLiteral(state.invocation, state.run, state.driver, state.orchestrator.tool ?? state.sessionJudge.tool) } : {}),
  }] : [];
  const gate = state.gate && !state.done ? [gateAction(state, state.gate)] : [];
  return [...stops, ...offers, ...places, ...gate, ...end];
}

/**
 * The handoff of a run that can go no further here. `resume` drives from the directory it runs in when the run's last
 * driver was not a local one, so the person runs it from the checkout the run started in. `localTool`: the prompt tool
 * the resume literal names (`localPromptTool`).
 */
function handoffOf(state: SkillState, waiting: { reason: string; held: NonNullable<Waiting['held']> }, localTool: string | undefined): HandoffAction {
  return {
    kind: 'person', why: 'handoff', held: waiting.held,
    message: `Run ${state.run} waits on steps this coding session cannot run: ${waiting.reason}.${state.gate ? '' : ' Nothing else of the run is open.'}`,
    say: `This session can take the run no further. To continue it with the local driver, run this command in your own terminal, from ${state.driver.workspace}.`,
    run: [resumeLiteral(state.invocation, state.run, { tool: localTool })],
  };
}

/**
 * The turn of `state` that shows `events`, with `after` as its `then` while the run drives, or an attempt or a judge of
 * it is open. A `quiet` turn carries no action; any other shows the handoff of a `waiting` that holds steps.
 */
export function turnOf(state: SkillState, input: { events: TurnEvent[]; after?: NonNullable<Turn['then']>; waiting?: Waiting; quiet?: true; localTool?: string }): Turn {
  const running = state.attempts.map((open): RunningEntry => ({
    attempt: open.attempt, step: open.step, phase: open.phase, ...(reportedByAgent(open) ? { report: reportLiteral(state.invocation, state.run, open.attempt) } : {}),
  }));
  const waiting = input.waiting && !state.done && state.attempts.length === 0 ? input.waiting : undefined;
  const handoff = waiting?.held && !input.quiet ? [handoffOf(state, { reason: waiting.reason, held: waiting.held }, input.localTool)] : [];
  return {
    run: state.run,
    status: state.done ? 'done' : 'driving',
    actions: input.quiet ? [] : [...actionsOf(state), ...handoff],
    running,
    events: input.events,
    ...(waiting ? { waiting } : {}),
    // `then` is a value, never a function, so awaiting a turn does not treat it as a promise.
    // oxlint-disable-next-line unicorn/no-thenable
    ...(input.after && (!state.done || state.attempts.length > 0 || state.judging?.open) ? { then: input.after } : {}),
  };
}
