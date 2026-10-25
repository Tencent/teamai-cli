/**
 * The skill driver's state machine: `step(state, input)` returns the row it took, the new state and what the caller
 * must do. The rows are the tables under `## The skill driver` in docs/dev/workflow-engine.md, cell by cell.
 */
import type { EnvScope } from '../../requirements.js';
import type { AttemptId } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import type { StartAnswer, StartCheck } from './preflight.js';
import type { AttemptState, ReportBody, SkillState, TurnEvent } from './skill-state.js';
import type { DescribeAsk } from './turn.js';

export interface TransitionRow {
  id: string;
  state: string;
  input: string;
  guard: string;
  effects: string;
  next: string;
  action: string;
}

export const TRANSITIONS = [
  { id: 'R2', state: 'none', input: 'describe', guard: 'the definition has a prompt step or a step outside the checkout', effects: 'none', next: 'none', action: 'describe `ask.kind: local` with the reason and the `--driver local` start literal' },
  { id: 'R3', state: 'none', input: 'describe', guard: 'something to ask: `invoke: ask`, a required input, or width above 1', effects: 'none', next: 'none', action: 'describe `ask.kind: ask`: one question, and the start literal of each option' },
  { id: 'R4', state: 'none', input: 'describe', guard: 'nothing to ask', effects: 'none', next: 'none', action: 'describe `ask.kind: start` with the one start literal' },
  { id: 'R8', state: 'none', input: 'start `--driver skill`', guard: 'the definition has a prompt step or a step outside the checkout', effects: 'none', next: 'none', action: 'error `needs_local_driver`, next null' },
  { id: 'R9', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `confirm-needed`', effects: 'none', next: 'none', action: 'error `confirm_needed`, next: the describe literal' },
  { id: 'R10', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `ok`', effects: '`WorkflowClient.start`; write skill.json: identity `{skill, machine, run checkout}`, invocation, options, owner := the caller\'s session', next: 'drive', action: 'the turn of a tick' },
  { id: 'R11', state: 'none', input: 'next, report `--driver skill`', guard: 'this machine has no skill.json for the run', effects: 'none', next: 'none', action: 'error `not_skill_run`, next null' },
  { id: 'S1', state: 'drive, done', input: 'an agent call from session s', guard: 'the owner is s, or either session is unknown', effects: '`lastCallAt` := now; owner := s when unknown', next: 'unchanged', action: 'the input\'s row' },
  { id: 'S2', state: 'drive, done', input: 'an agent call from session s', guard: 'owner o is not s, and both are known', effects: 'none', next: 'unchanged', action: 'error `orchestrator_active`, next null' },
  { id: 'S5', state: 'any', input: 'a runner call (`report --attempt a` with the marker `<run>/a`)', guard: '', effects: 'no session check, no `lastCallAt`', next: 'unchanged', action: 'C rows' },
  { id: 'D1', state: 'drive', input: 'tick', guard: '', effects: 'engine `next {driver: identity + can, running: every open attempt, canTakeLease: fewer open than options.parallel}`', next: 'drive', action: '' },
  { id: 'D6', state: 'drive', input: 'reply lease', guard: 'executor command', effects: 'phase preparing; spawn runner job `command`', next: 'drive', action: 'event `started`' },
  { id: 'D15', state: 'drive', input: 'reply wait', guard: '', effects: 'none', next: 'drive', action: 'waiting' },
  { id: 'D16', state: 'drive', input: 'reply done', guard: '', effects: '`seq` := seq + 1, so every session has the end to see', next: 'done', action: '`done {outcome, failure, prs}`' },
  { id: 'D17', state: 'drive', input: 'reply error', guard: '', effects: 'none', next: 'drive', action: 'error with the engine\'s code, next: the next literal' },
  { id: 'D18', state: 'drive', input: 'a foreground call', guard: 'it spawned runners', effects: 'release the lock; wait up to `WAIT_GRACE_MS` for them, re-taking the lock per check', next: 'drive', action: '' },
  { id: 'D19', state: 'any', input: 'a foreground call', guard: 'the lock is not free within `TICK_LOCK_WAIT_MS` (`report`: `WAIT_BOUND_MS`)', effects: 'none', next: 'unchanged', action: 'error `driver_running`, next: the same literal' },
  { id: 'D20', state: 'drive, done', input: 'a foreground call, after its tick', guard: '', effects: '`seen[s]` := seq', next: 'unchanged', action: 'the turn: events after the old `seen[s]`; `then: poll` (none once done)' },
  { id: 'D21', state: 'drive, done', input: 'a poll tick', guard: 'the lock was busy, or nothing below applies, and the bound is not reached', effects: 'release; sleep `WAIT_POLL_MS`; tick again', next: 'unchanged', action: '' },
  { id: 'D23', state: 'done', input: 'a poll tick', guard: '`seen[s]` is below seq: s has not seen `done`', effects: '`seen[s]` := seq', next: 'done', action: '`done` with its events' },
  { id: 'D24', state: 'drive, done', input: 'a poll tick', guard: 'the bound is reached', effects: 'none', next: 'unchanged', action: '`then: poll`, no actions' },
  { id: 'C1', state: 'preparing', input: 'runner: prepared', guard: 'job `command`', effects: 'run the command outside the lock with `{...stepEnvironment(values, envScope).env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT}` (`process.env` for a lease without `envScope`), output masked into `output.log`', next: 'running', action: '' },
  { id: 'C7', state: 'preparing', input: 'runner: prepare failed', guard: '', effects: 'write-ahead `failed` with its failure', next: 'reporting', action: '' },
  { id: 'C8', state: 'running', input: 'runner: the command exited', guard: '', effects: 'write-ahead: `success` on exit 0, else `failed`; outputs, exit code, masked tail', next: 'reporting', action: '' },
  { id: 'C10', state: 'preparing, running', input: 'tick: its `runner.lock` is free', guard: 'it was spawned more than `WAIT_GRACE_MS` ago', effects: 'spawn the same job again (prepare is idempotent; a command restarts in its prepared place)', next: 'unchanged', action: 'event `restarted`' },
  { id: 'P2', state: 'drive', input: 'report a', guard: 'a is unknown', effects: 'none', next: 'drive', action: 'error `unknown_attempt`, next: the next literal' },
  { id: 'P3', state: 'drive', input: 'report a', guard: 'a preparing, running or reporting', effects: 'none', next: 'drive', action: 'error `not_dispatched`, next: the next literal' },
  { id: 'P7', state: 'reporting', input: 'engine: reported, any status', guard: '', effects: 'drop a; add to settled', next: 'drive', action: 'event `settled`' },
  { id: 'P8', state: 'reporting', input: 'engine: `repeated_report`', guard: '', effects: 'as P7', next: 'drive', action: 'event `settled`' },
  { id: 'P10', state: 'reporting', input: 'engine: another error', guard: '', effects: 'keep the body', next: 'reporting', action: 'error, next: the same report literal (a runner retries at its next check)' },
  { id: 'P11', state: 'reporting', input: 'tick', guard: 'a body is stored (a crash came between write and send)', effects: 'send it again', next: 'reporting', action: 'P7 to P10' },
  { id: 'X2', state: 'done', input: 'next', guard: '', effects: 'none', next: 'done', action: '`done`, no `then`' },
] as const satisfies readonly TransitionRow[];

export type RowId = typeof TRANSITIONS[number]['id'];

/** A lease the engine handed out, as the tick read it. */
export interface ReadLease {
  attempt: AttemptId;
  step: string;
  revision: number;
  command: string;
  env: Record<string, string>;
  envScope?: EnvScope;
}

export type EngineReply =
  | { kind: 'lease'; lease: ReadLease }
  | { kind: 'wait'; reason: string }
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure }
  | { kind: 'error'; error: WorkflowFailure };

/** What the engine answered a sent report: the step it settled, or an error. */
export type ReportReply = { kind: 'reported'; outcome: Extract<TurnEvent, { kind: 'settled' }>['outcome'] } | { kind: 'error'; error: WorkflowFailure };

export type MachineInput =
  | { kind: 'describe'; needed: StartAnswer[]; localOnly: string[] }
  | { kind: 'start'; check: StartCheck; localOnly: string[] }
  | { kind: 'call'; session: string | undefined; at: string }
  | { kind: 'runner-call' }
  | { kind: 'tick' }
  | { kind: 'next' }
  | { kind: 'reply'; reply: EngineReply; at: string }
  | { kind: 'spawned' }
  | { kind: 'lock-busy' }
  | { kind: 'turn'; session: string | undefined }
  | { kind: 'poll'; session: string | undefined; busy: boolean; boundReached: boolean }
  | { kind: 'prepared'; attempt: AttemptId }
  | { kind: 'prepare-failed'; attempt: AttemptId; body: ReportBody }
  | { kind: 'exited'; attempt: AttemptId; body: ReportBody; tail?: string }
  | { kind: 'runner-free'; attempt: AttemptId; at: string; graceMs: number }
  | { kind: 'reported'; attempt: AttemptId; reply: ReportReply }
  | { kind: 'resend'; attempt: AttemptId }
  | { kind: 'report'; attempt: AttemptId };

/** What the caller does for a row, beyond saving its state. */
export type Effect =
  | { kind: 'start'; parallel: number }
  | { kind: 'next'; running: AttemptId[]; canTakeLease: boolean }
  /** `job` is the lease's command and env for a new attempt; a respawn reuses the job already saved. */
  | { kind: 'spawn'; attempt: AttemptId; job?: Pick<ReadLease, 'command' | 'env' | 'envScope'> }
  | { kind: 'run'; attempt: AttemptId }
  | { kind: 'send'; attempt: AttemptId; body: ReportBody }
  | { kind: 'grace' }
  | { kind: 'sleep' };

/** What the call answers, when the row decides it. */
export type Answer =
  | { kind: 'describe'; ask: DescribeAsk['kind'] }
  | { kind: 'error'; code: 'needs_local_driver' | 'confirm_needed' | 'not_skill_run' | 'orchestrator_active' | 'unknown_attempt' | 'not_dispatched' | 'driver_running'; next: 'describe' | 'next' | 'same' | null }
  | { kind: 'engine-error'; error: WorkflowFailure; next: 'next' | 'same' }
  | { kind: 'turn'; events: 'unseen' | 'none'; poll: boolean };

export interface Step {
  row: RowId;
  state: SkillState | undefined;
  effects: Effect[];
  answer?: Answer;
  /** Why the run leased nothing more (D15). */
  waiting?: { reason: string };
}

function withEvent(state: SkillState, event: TurnEvent): SkillState {
  const seq = state.seq + 1;
  return { ...state, seq, events: [...state.events, { seq, event }] };
}

function withAttempt(state: SkillState, attempt: AttemptState): SkillState {
  return { ...state, attempts: [...state.attempts.filter((open) => open.attempt !== attempt.attempt), attempt] };
}

function seenBy(session: string | undefined): string {
  return session ?? '';
}

/** The open attempt `attempt` of `state`. */
export function openAttempt(state: SkillState, attempt: AttemptId): AttemptState | undefined {
  return state.attempts.find((open) => open.attempt === attempt);
}

/** The events `session` has not been shown. */
export function unseenEvents(state: SkillState, session: string | undefined): TurnEvent[] {
  const seen = state.seen[seenBy(session)] ?? 0;
  return state.events.filter((entry) => entry.seq > seen).map((entry) => entry.event);
}

/** Takes the row `input` matches in `state`. Undefined when no row applies, which leaves everything as it was. */
export function step(state: SkillState | undefined, input: MachineInput): Step | undefined {
  switch (input.kind) {
    case 'describe':
      if (input.localOnly.length > 0) return { row: 'R2', state, effects: [], answer: { kind: 'describe', ask: 'local' } };
      if (input.needed.length > 0) return { row: 'R3', state, effects: [], answer: { kind: 'describe', ask: 'ask' } };
      return { row: 'R4', state, effects: [], answer: { kind: 'describe', ask: 'start' } };
    case 'start':
      if (input.localOnly.length > 0) return { row: 'R8', state, effects: [], answer: { kind: 'error', code: 'needs_local_driver', next: null } };
      if (input.check.kind === 'confirm-needed') return { row: 'R9', state, effects: [], answer: { kind: 'error', code: 'confirm_needed', next: 'describe' } };
      return { row: 'R10', state, effects: [{ kind: 'start', parallel: input.check.parallel }] };
    case 'call': {
      if (!state) return { row: 'R11', state, effects: [], answer: { kind: 'error', code: 'not_skill_run', next: null } };
      const owner = state.orchestrator.session;
      if (owner !== undefined && input.session !== undefined && owner !== input.session) {
        return { row: 'S2', state, effects: [], answer: { kind: 'error', code: 'orchestrator_active', next: null } };
      }
      return { row: 'S1', state: { ...state, orchestrator: { session: state.orchestrator.session ?? input.session, lastCallAt: input.at } }, effects: [] };
    }
    case 'runner-call':
      if (!state) return undefined;
      return { row: 'S5', state, effects: [] };
    case 'next':
      if (!state) return undefined;
      if (state.done) return { row: 'X2', state, effects: [] };
      return tick(state);
    case 'tick':
      if (!state || state.done) return undefined;
      return tick(state);
    case 'reply':
      return state && !state.done ? reply(state, input.reply, input.at) : undefined;
    case 'spawned':
      return state && !state.done ? { row: 'D18', state, effects: [{ kind: 'grace' }] } : undefined;
    case 'lock-busy':
      return { row: 'D19', state, effects: [], answer: { kind: 'error', code: 'driver_running', next: 'same' } };
    case 'turn':
      if (!state) return undefined;
      return { row: 'D20', state: { ...state, seen: { ...state.seen, [seenBy(input.session)]: state.seq } }, effects: [], answer: { kind: 'turn', events: 'unseen', poll: !state.done } };
    case 'poll': {
      if (state?.done && !input.busy && (state.seen[seenBy(input.session)] ?? 0) < state.seq) {
        return { row: 'D23', state: { ...state, seen: { ...state.seen, [seenBy(input.session)]: state.seq } }, effects: [], answer: { kind: 'turn', events: 'unseen', poll: false } };
      }
      if (input.boundReached) return { row: 'D24', state, effects: [], answer: { kind: 'turn', events: 'none', poll: true } };
      return { row: 'D21', state, effects: [{ kind: 'sleep' }] };
    }
    case 'prepared': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'preparing') return undefined;
      return { row: 'C1', state: withAttempt(state, { ...open, phase: 'running' }), effects: [{ kind: 'run', attempt: input.attempt }] };
    }
    case 'prepare-failed': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'preparing') return undefined;
      return { row: 'C7', state: withAttempt(state, { ...open, phase: 'reporting', body: input.body }), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
    }
    case 'exited': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'running') return undefined;
      const reporting: AttemptState = { ...open, phase: 'reporting', body: input.body, ...(input.tail ? { tail: input.tail } : {}) };
      return { row: 'C8', state: withAttempt(state, reporting), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
    }
    case 'runner-free': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || !open || open.phase === 'reporting' || Date.parse(input.at) - Date.parse(open.spawnedAt) <= input.graceMs) return undefined;
      const respawned = withAttempt(state, { ...open, spawnedAt: input.at });
      return { row: 'C10', state: withEvent(respawned, { kind: 'restarted', step: open.step, attempt: open.attempt }), effects: [{ kind: 'spawn', attempt: open.attempt }] };
    }
    case 'reported': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'reporting') return undefined;
      if (input.reply.kind === 'error' && input.reply.error.code !== 'repeated_report') {
        return { row: 'P10', state, effects: [], answer: { kind: 'engine-error', error: input.reply.error, next: 'same' } };
      }
      const outcome = input.reply.kind === 'reported' ? input.reply.outcome : open.body.outcome;
      const dropped = { ...state, attempts: state.attempts.filter((other) => other.attempt !== open.attempt), settled: [...state.settled, open.attempt] };
      const settled = withEvent(dropped, {
        kind: 'settled', step: open.step, outcome,
        ...(open.body.exitCode !== undefined ? { exitCode: open.body.exitCode } : {}),
        ...(open.body.failure ? { failure: open.body.failure } : {}),
        ...(open.tail ? { tail: open.tail } : {}),
      });
      return { row: input.reply.kind === 'reported' ? 'P7' : 'P8', state: settled, effects: [] };
    }
    case 'resend': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'reporting') return undefined;
      return { row: 'P11', state, effects: [{ kind: 'send', attempt: input.attempt, body: open.body }] };
    }
    case 'report': {
      if (!state || state.done) return undefined;
      const open = openAttempt(state, input.attempt);
      if (!open) return { row: 'P2', state, effects: [], answer: { kind: 'error', code: 'unknown_attempt', next: 'next' } };
      return { row: 'P3', state, effects: [], answer: { kind: 'error', code: 'not_dispatched', next: 'next' } };
    }
    default: {
      const unhandled: never = input;
      return unhandled;
    }
  }
}

/** Whether `state` has room for another attempt. */
export function hasSlot(state: SkillState): boolean {
  return state.attempts.length < state.options.parallel;
}

function tick(state: SkillState): Step {
  return { row: 'D1', state, effects: [{ kind: 'next', running: state.attempts.map((open) => open.attempt), canTakeLease: hasSlot(state) }] };
}

function reply(state: SkillState, engine: EngineReply, at: string): Step {
  switch (engine.kind) {
    case 'lease': {
      const { attempt, step: id, revision, command, env, envScope } = engine.lease;
      const preparing = withAttempt(state, { attempt, step: id, revision, spawnedAt: at, phase: 'preparing' });
      const job = { command, env, ...(envScope ? { envScope } : {}) };
      return { row: 'D6', state: withEvent(preparing, { kind: 'started', step: id, attempt }), effects: [{ kind: 'spawn', attempt, job }] };
    }
    case 'wait':
      return { row: 'D15', state, effects: [], waiting: { reason: engine.reason } };
    case 'done':
      return { row: 'D16', state: { ...state, seq: state.seq + 1, done: { outcome: engine.outcome, ...(engine.failure ? { failure: engine.failure } : {}) } }, effects: [] };
    case 'error':
      return { row: 'D17', state, effects: [], answer: { kind: 'engine-error', error: engine.error, next: 'next' } };
    default: {
      const unhandled: never = engine;
      return unhandled;
    }
  }
}
