/** What the skill driver prints: a describe reply, a turn, or an error that names the literal to run instead. */
import type { WorkflowDescription } from '../../describe.js';
import type { AttemptId, RunId } from '../../store.js';
import type { OutputSchema, WorkflowFailure } from '../../types.js';
import type { Literal } from './literals.js';
import type { AttemptState, SkillState, TurnEvent } from './skill-state.js';

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

export type Action = { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure; prs: string[] };

export interface RunningEntry {
  attempt: AttemptId;
  step: string;
  phase: AttemptState['phase'];
}

export interface Turn {
  run: RunId;
  status: 'driving' | 'done';
  actions: Action[];
  running: RunningEntry[];
  events: TurnEvent[];
  /** Why the run leased nothing more, when it did not. */
  waiting?: { reason: string };
  /** The call to make next: `poll` in the background. Absent once the run is done. */
  then?: { kind: 'poll'; run: Literal };
}

/** An error the agent can act on: `next` is the literal to run instead, or null when only the person can act. */
export interface SkillError {
  /** The skill driver's own codes. An engine or protocol code is relayed as written. */
  code: 'confirm_needed' | 'needs_local_driver' | 'not_skill_run' | 'orchestrator_active' | 'unknown_attempt' | 'not_dispatched' | (string & {});
  message: string;
  next: Literal | null;
}

export type SkillAnswer =
  | { data: { describe: { workflow: WorkflowDescription; ask: DescribeAsk } } }
  | { data: { turn: Turn } }
  /** What a runner answers once it is done with its attempt. Nobody reads it: a runner reports itself. */
  | { data: { runner: { attempt: AttemptId; reported: boolean } } }
  | { error: SkillError };

/** The turn of `state` that shows `events`, with `then` unless the run is done. A `quiet` turn carries no action. */
export function turnOf(state: SkillState, input: { events: TurnEvent[]; poll?: Literal; waiting?: { reason: string }; quiet?: true }): Turn {
  const running = state.attempts.map(({ attempt, step, phase }): RunningEntry => ({ attempt, step, phase }));
  return {
    run: state.run,
    status: state.done ? 'done' : 'driving',
    actions: state.done && !input.quiet ? [{ kind: 'done', outcome: state.done.outcome, ...(state.done.failure ? { failure: state.done.failure } : {}), prs: [] }] : [],
    running,
    events: input.events,
    ...(input.waiting && !state.done ? { waiting: input.waiting } : {}),
    // `then` is a value, never a function, so awaiting a turn does not treat it as a promise.
    // oxlint-disable-next-line unicorn/no-thenable
    ...(input.poll && !state.done ? { then: { kind: 'poll', run: input.poll } } : {}),
  };
}
