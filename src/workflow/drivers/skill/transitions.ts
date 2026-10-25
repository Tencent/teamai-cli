/**
 * The skill driver's state machine: `step(state, input)` returns the row it took, the new state and what the caller
 * must do. The rows are the tables under `## The skill driver` in docs/dev/workflow-engine.md, cell by cell.
 */
import type { EnvScope } from '../../requirements.js';
import type { AttemptId, RunId } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import type { ChildResult } from './child-brief.js';
import type { HostChoice, HostProfile } from './host-profiles.js';
import type { StartAnswer, StartCheck } from './preflight.js';
import type { AttemptState, Dispatch, ReportBody, SkillState, StopReason, TurnEvent } from './skill-state.js';
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
  { id: 'R2', state: 'none', input: 'describe', guard: 'the definition has an interactive step', effects: 'none', next: 'none', action: 'describe `ask.kind: local` with the reason and the `--driver local` start literal' },
  { id: 'R3', state: 'none', input: 'describe', guard: 'something to ask: `invoke: ask`, a required input, or width above 1', effects: 'none', next: 'none', action: 'describe `ask.kind: ask`: one question, and the start literal of each option' },
  { id: 'R4', state: 'none', input: 'describe', guard: 'nothing to ask', effects: 'none', next: 'none', action: 'describe `ask.kind: start` with the one start literal' },
  { id: 'R8', state: 'none', input: 'start `--driver skill`', guard: 'the definition has an interactive step', effects: 'none', next: 'none', action: 'error `needs_local_driver`, next null' },
  { id: 'R9', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `confirm-needed`', effects: 'none', next: 'none', action: 'error `confirm_needed`, next: the describe literal' },
  { id: 'R10', state: 'none', input: 'start `--driver skill`', guard: '`checkStartAnswers` answers `ok`', effects: '`WorkflowClient.start`; write skill.json: identity `{skill, machine, run checkout}`, invocation, options, host `pending` when the definition has a prompt step, owner := the caller\'s session', next: 'host when it has a prompt step, else drive', action: 'the turn of a tick' },
  { id: 'R11', state: 'none', input: 'next, report `--driver skill`', guard: 'this machine has no skill.json for the run', effects: 'none', next: 'none', action: 'error `not_skill_run`, next null' },
  { id: 'R12', state: 'host', input: 'tick', guard: '', effects: 'none', next: 'host', action: '`choose about:host decide:agent`' },
  { id: 'R13', state: 'host', input: 'next `--choice h`', guard: '', effects: 'host := `HOST_PROFILES[h]`', next: 'drive', action: 'the turn of a tick' },
  { id: 'R14', state: 'host', input: 'report, next `--ack`', guard: '', effects: 'none', next: 'host', action: 'error `choice_pending`, next: the next literal' },
  { id: 'R15', state: 'drive, done', input: 'next `--choice h`', guard: '', effects: 'none', next: 'unchanged', action: 'error `unknown_choice`, next: the next literal' },
  { id: 'S1', state: 'host, drive, done', input: 'an agent call from session s', guard: 'the owner is s, or either session is unknown', effects: '`lastCallAt` := now; owner := s when unknown', next: 'unchanged', action: 'the input\'s row' },
  { id: 'S2', state: 'host, drive, done', input: 'an agent call from session s without `--takeover`', guard: 'owner o is not s, and both are known, however long o has been idle', effects: 'none', next: 'unchanged', action: 'error `orchestrator_active` with `idleSeconds`, the seconds since o\'s last call, next: the takeover literal' },
  { id: 'S4', state: 'host, drive, done', input: 'next `--takeover` from session s', guard: '', effects: 'owner := s; `lastCallAt` := now; every offered or dispatched attempt becomes offered with `reissued`', next: 'unchanged', action: 'event `takeover`; the turn of a tick' },
  { id: 'S5', state: 'any', input: 'a runner call (`report --attempt a` with the marker `<run>/a`)', guard: '', effects: 'no session check, no `lastCallAt`', next: 'unchanged', action: 'C rows' },
  { id: 'S6', state: 'host, drive, done', input: 'an agent `report --attempt a`, from any session', guard: 'a is settled, or open offered, dispatched, reporting, or stopping by the agent', effects: 'no session check, no `lastCallAt`', next: 'unchanged', action: 'the input\'s row' },
  { id: 'D1', state: 'drive', input: 'tick', guard: '', effects: 'engine `next {driver: identity + SKILL_CAN, running: every open attempt, canTakeLease: fewer open than options.parallel, and than one under a serial host; false in a runner\'s check}`', next: 'drive', action: '' },
  { id: 'D2', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a queued', effects: 'drop a', next: 'drive', action: 'event `stopped`' },
  { id: 'D3', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a preparing or running', effects: 'phase stopping by its runner, why `timeout` once its `expiresAt` passed, else `cancelled`', next: 'drive', action: '' },
  { id: 'D4', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a offered or dispatched', effects: 'phase stopping by the agent, why as D3', next: 'drive', action: '`stop {why, report}` in each foreground turn until reported' },
  { id: 'D5', state: 'drive', input: 'reply `cancelled` holds a', guard: 'a stopping or reporting', effects: 'none', next: 'drive', action: '' },
  { id: 'D6', state: 'drive', input: 'reply lease', guard: 'executor command', effects: 'phase preparing; spawn runner job `command`', next: 'drive', action: 'event `started`' },
  { id: 'D7', state: 'drive', input: 'reply lease', guard: 'executor prompt', effects: 'phase preparing; spawn runner job `prompt`', next: 'drive', action: 'event `started`' },
  { id: 'D9', state: 'drive', input: 'tick', guard: 'a queued attempt whose `behind` is no longer open', effects: 'phase preparing; spawn its job again', next: 'drive', action: '' },
  { id: 'D15', state: 'drive', input: 'reply wait', guard: '', effects: 'none', next: 'drive', action: 'waiting' },
  { id: 'D16', state: 'drive', input: 'reply done', guard: '', effects: '`seq` := seq + 1, so every session has the end to see', next: 'done', action: '`done {outcome, failure, prs}`' },
  { id: 'D17', state: 'drive', input: 'reply error', guard: '', effects: 'none', next: 'drive', action: 'error with the engine\'s code, next: the next literal' },
  { id: 'D18', state: 'drive', input: 'a foreground call', guard: 'it spawned runners', effects: 'release the lock; wait up to `WAIT_GRACE_MS` for them, re-taking the lock per check', next: 'drive', action: '' },
  { id: 'D19', state: 'any', input: 'a foreground call', guard: 'the lock is not free within `TICK_LOCK_WAIT_MS` (`report`: `WAIT_BOUND_MS`)', effects: 'none', next: 'unchanged', action: 'error `driver_running`, next: the same literal' },
  { id: 'D20', state: 'host, drive, done', input: 'a foreground call, after its tick', guard: '', effects: '`seen[s]` := seq', next: 'unchanged', action: 'the turn: the host question, or every `stop` then every unacked dispatch; events after the old `seen[s]`; `then: poll` until the run is done and no attempt is open' },
  { id: 'D21', state: 'host, drive, done', input: 'a poll tick', guard: 'the lock was busy, or nothing below applies, and the bound is not reached', effects: 'release; sleep `WAIT_POLL_MS`; tick again', next: 'unchanged', action: '' },
  { id: 'D22', state: 'host, drive, done', input: 'a poll tick', guard: 'the host question is unanswered, a dispatch is unacked, or a `stop` is not reported', effects: 'none', next: 'unchanged', action: '`then: wake` with the next literal, no actions' },
  { id: 'D23', state: 'done', input: 'a poll tick', guard: '`seen[s]` is below seq, and no attempt is open', effects: '`seen[s]` := seq', next: 'done', action: '`done` with its events' },
  { id: 'D24', state: 'host, drive, done', input: 'a poll tick', guard: 'the bound is reached', effects: 'none', next: 'unchanged', action: '`then: poll`, no actions' },
  { id: 'C1', state: 'preparing', input: 'runner: prepared', guard: 'job `command`', effects: 'run the command outside the lock with `{...stepEnvironment(values, envScope).env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT}` (`process.env` for a lease without `envScope`), output masked into `output.log`', next: 'running', action: '' },
  { id: 'C2', state: 'preparing', input: 'runner: prepared', guard: 'job `prompt`', effects: '`pickChildModel`; `writeChildBrief`', next: 'offered', action: '`dispatch` in each foreground turn until acked' },
  { id: 'C3', state: 'preparing', input: 'runner: prepared', guard: 'job `prompt`; `pickChildModel` fails `model_unavailable`', effects: 'write-ahead `failed` with that failure', next: 'reporting', action: '' },
  { id: 'C4', state: 'preparing', input: 'runner: place busy, behind b', guard: '', effects: '`behind` := b', next: 'queued', action: '' },
  { id: 'C7', state: 'preparing', input: 'runner: prepare or setup failed', guard: '', effects: 'write-ahead `failed` with its failure', next: 'reporting', action: '' },
  { id: 'C8', state: 'running', input: 'runner: the command exited', guard: '', effects: 'write-ahead: `success` on exit 0, else `failed`; outputs, exit code, masked tail', next: 'reporting', action: '' },
  { id: 'C9', state: 'stopping by its runner', input: 'runner: its check every `RUNNER_POLL_MS` and at `expiresAt`, its setup ending, or its command exiting', guard: '', effects: 'stop the command and every process it started (`tool-launch/process-stop.ts`); write-ahead `released`', next: 'reporting', action: '' },
  { id: 'C10', state: 'preparing, running', input: 'tick: its `runner.lock` is free', guard: 'it was spawned more than `WAIT_GRACE_MS` ago', effects: 'stop the process group its command left; spawn the same job again (prepare is idempotent; a command restarts in its prepared place)', next: 'unchanged', action: 'event `restarted`' },
  { id: 'C11', state: 'stopping by its runner', input: 'tick: its `runner.lock` is free', guard: '', effects: 'stop the process group its command left; write-ahead `released`', next: 'reporting', action: '' },
  { id: 'K1', state: 'drive', input: 'next `--ack dispatch.a`', guard: 'a offered', effects: 'phase dispatched', next: 'drive', action: 'the turn of a tick' },
  { id: 'K2', state: 'drive', input: 'next `--ack dispatch.a`', guard: 'a dispatched', effects: 'none', next: 'drive', action: 'the turn of a tick' },
  { id: 'K3', state: 'drive, done', input: 'next `--ack dispatch.a`', guard: 'a neither offered nor dispatched', effects: 'none', next: 'unchanged', action: 'error `unknown_offer`, next: the next literal' },
  { id: 'P1', state: 'drive, done', input: 'report a', guard: 'a is in the settled list', effects: 'none', next: 'unchanged', action: 'runner answer `repeated`' },
  { id: 'P2', state: 'drive', input: 'report a', guard: 'a is unknown', effects: 'none', next: 'drive', action: 'error `unknown_attempt`, next: the next literal' },
  { id: 'P3', state: 'drive', input: 'report a', guard: 'a preparing, queued, running, or stopping by its runner', effects: 'none', next: 'drive', action: 'error `not_dispatched`, next: the next literal' },
  { id: 'P4', state: 'drive', input: 'report a `--model-unavailable`', guard: 'a offered or dispatched, its dispatch printed `unavailable`', effects: 'write-ahead `failed` `model_unavailable` naming the model', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P5', state: 'drive', input: 'report a', guard: 'a offered or dispatched, otherwise', effects: 'read `result.json`: an output gives `success` with it as outputs, a failure gives `failed` with it, none or an unreadable one gives `failed` `tool_failed`; write-ahead', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P6', state: 'drive, done', input: 'report a', guard: 'a stopping by the agent', effects: 'write-ahead `released`', next: 'reporting', action: 'P7 to P10; after P7 to P9, runner answer `reported`' },
  { id: 'P7', state: 'reporting', input: 'engine: reported, any status', guard: '', effects: 'drop a; add to settled', next: 'drive', action: 'event `settled`' },
  { id: 'P8', state: 'reporting', input: 'engine: `repeated_report`', guard: '', effects: 'as P7', next: 'drive', action: 'event `settled`' },
  { id: 'P9', state: 'reporting', input: 'engine: `lease_cancelled`', guard: '', effects: 'drop a (the protocol abandoned its place); add to settled, so a late report of its child is P1', next: 'unchanged', action: 'event `stopped`, why as its stop said, else as D3' },
  { id: 'P10', state: 'reporting', input: 'engine: another error', guard: '', effects: 'keep the body', next: 'reporting', action: 'error, next: the same report literal (a runner retries at its next check)' },
  { id: 'P11', state: 'reporting', input: 'tick, or report a', guard: 'a body is stored (a crash or a refusal came between write and send)', effects: 'send it again', next: 'reporting', action: 'P7 to P10' },
  { id: 'X2', state: 'done', input: 'next', guard: 'no attempt is open', effects: 'none', next: 'done', action: '`done`, no `then`' },
  { id: 'X4', state: 'done', input: 'next', guard: 'an attempt is still open: the engine cancelled it with the run', effects: 'none', next: 'done', action: 'every `stop`, then `done`; `then: poll`' },
] as const satisfies readonly TransitionRow[];

export type RowId = typeof TRANSITIONS[number]['id'];

/** A lease the engine handed out, as the tick read it: a command, or a prompt for a child. */
export type ReadLease = { attempt: AttemptId; step: string; revision: number; expiresAt?: string } & (
  | { executor: 'command'; command: string; env: Record<string, string>; envScope?: EnvScope }
  | { executor: 'prompt'; prompt: string; place: Dispatch['place']; agent?: string; model?: string; defaultModel?: string; output?: unknown }
);

export type EngineReply =
  /** `raw` is the lease as the engine sent it: its runner prepares the place from it. */
  | { kind: 'lease'; lease: ReadLease; raw: unknown }
  | { kind: 'wait'; reason: string }
  | { kind: 'done'; outcome: NonNullable<SkillState['done']>['outcome']; failure?: WorkflowFailure }
  | { kind: 'error'; error: WorkflowFailure };

/** What the engine answered a sent report: the step it settled, or an error. */
export type ReportReply = { kind: 'reported'; outcome: Extract<TurnEvent, { kind: 'settled' }>['outcome'] } | { kind: 'error'; error: WorkflowFailure };

export type MachineInput =
  | { kind: 'describe'; needed: StartAnswer[]; localOnly: string[] }
  | { kind: 'start'; name: string; check: StartCheck; localOnly: string[]; prompts: boolean }
  /** `takeover`: the call is `next --takeover`. */
  | { kind: 'call'; run: RunId; session: string | undefined; at: string; takeover: boolean }
  | { kind: 'runner-call' }
  /** An agent's `report --attempt a`, before the session check: the child of `a` may run in a session of its own. */
  | { kind: 'report-call'; attempt: AttemptId }
  /** `runner`: the check a runner makes while its attempt runs, which takes no lease. */
  | { kind: 'tick'; role: 'call' | 'runner' }
  | { kind: 'next' }
  | { kind: 'choose'; choice: HostChoice; profile: HostProfile }
  | { kind: 'ack'; attempt: AttemptId }
  | { kind: 'reply'; reply: EngineReply; at: string }
  /** The engine no longer leases `attempt` to this driver: it was cancelled, or it passed its deadline. */
  | { kind: 'cancelled'; attempt: AttemptId; at: string }
  | { kind: 'spawned' }
  | { kind: 'lock-busy'; run: RunId }
  | { kind: 'turn'; session: string | undefined }
  | { kind: 'poll'; session: string | undefined; busy: boolean; boundReached: boolean }
  | { kind: 'prepared'; attempt: AttemptId }
  | { kind: 'offer'; attempt: AttemptId; dispatch: Dispatch }
  | { kind: 'place-busy'; attempt: AttemptId; behind: AttemptId }
  | { kind: 'unqueue'; attempt: AttemptId; at: string }
  | { kind: 'prepare-failed'; attempt: AttemptId; body: ReportBody }
  | { kind: 'model-failed'; attempt: AttemptId; body: ReportBody }
  | { kind: 'exited'; attempt: AttemptId; body: ReportBody; tail?: string }
  | { kind: 'runner-free'; attempt: AttemptId; at: string; graceMs: number }
  /** The runner found its attempt stopping, and its command, if it started one, is stopped. */
  | { kind: 'runner-stop'; attempt: AttemptId }
  | { kind: 'reported'; attempt: AttemptId; reply: ReportReply; at: string }
  | { kind: 'resend'; attempt: AttemptId }
  /** `result` is what the attempt's child left, read before the row is taken. */
  | { kind: 'report'; attempt: AttemptId; modelUnavailable: boolean; result: ChildResult };

/** What the caller does for a row, beyond saving its state. */
export type Effect =
  | { kind: 'start'; parallel: number; host: 'none' | 'pending' }
  | { kind: 'next'; running: AttemptId[]; canTakeLease: boolean }
  /** `job` is the lease of a new attempt; a respawn reuses the job already saved. */
  | { kind: 'spawn'; attempt: AttemptId; job?: { lease: unknown } }
  | { kind: 'run'; attempt: AttemptId }
  /** Stops what the command of `attempt` left running when its runner died, before anything else runs in its place. */
  | { kind: 'stop-left'; attempt: AttemptId }
  | { kind: 'send'; attempt: AttemptId; body: ReportBody }
  | { kind: 'grace' }
  | { kind: 'sleep' };

/** A call the skill driver refuses, with what its message names. */
export type Refusal =
  | { code: 'needs_local_driver'; name: string; steps: string[] }
  | { code: 'confirm_needed'; name: string; missing: StartAnswer[]; outOfRange?: { parallel: number; ceiling: number } }
  | { code: 'not_skill_run'; run: RunId }
  /** `idleSeconds`: the seconds since the owner's last call. */
  | { code: 'orchestrator_active'; run: RunId; idleSeconds: number }
  | { code: 'choice_pending'; run: RunId }
  | { code: 'unknown_choice'; run: RunId }
  | { code: 'unknown_offer'; run: RunId; attempt: AttemptId }
  | { code: 'unknown_attempt'; run: RunId; attempt: AttemptId }
  | { code: 'not_dispatched'; run: RunId; attempt: AttemptId; phase: AttemptState['phase'] }
  | { code: 'driver_running'; run: RunId };

/** What the call answers, when the row decides it. */
export type Answer =
  | { kind: 'describe'; ask: DescribeAsk['kind'] }
  | { kind: 'error'; refusal: Refusal; next: 'describe' | 'next' | 'takeover' | 'same' | null }
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

/** `state` with `attempt` in the place it holds, or last when it is new, so a turn lists attempts in the order they opened. */
function withAttempt(state: SkillState, attempt: AttemptState): SkillState {
  const held = state.attempts.some((open) => open.attempt === attempt.attempt);
  return { ...state, attempts: held ? state.attempts.map((open) => (open.attempt === attempt.attempt ? attempt : open)) : [...state.attempts, attempt] };
}

/** The attempt `open` with only what every phase keeps. */
function baseOf(open: AttemptState): Pick<AttemptState, 'attempt' | 'step' | 'revision' | 'spawnedAt' | 'expiresAt'> {
  const { attempt, step: id, revision, spawnedAt, expiresAt } = open;
  return { attempt, step: id, revision, spawnedAt, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Why the engine stopped `open`, as it is known at `at`: its deadline passed, or the person cancelled it. */
function stopReason(open: AttemptState, at: string): StopReason {
  return open.expiresAt !== undefined && Date.parse(open.expiresAt) <= Date.parse(at) ? 'timeout' : 'cancelled';
}

/** Gives up stopped attempt `open` with a `released` report, which the protocol answers by abandoning its place. */
function released(state: SkillState, open: Extract<AttemptState, { phase: 'stopping' }>, row: 'C9' | 'C11' | 'P6'): Step {
  const body: ReportBody = { attempt: open.attempt, revision: open.revision, driver: state.driver, outcome: 'released' };
  return { row, state: withAttempt(state, { ...baseOf(open), phase: 'reporting', body, stopped: open.why }), effects: [{ kind: 'send', attempt: open.attempt, body }] };
}

/** Whether the agent reports `open`: its child works it, or the agent must stop that child. */
export function reportedByAgent(open: AttemptState): boolean {
  return open.phase === 'offered' || open.phase === 'dispatched' || (open.phase === 'stopping' && open.by === 'agent');
}

/** Whether something waits for the agent: the host question, a dispatch to ack, or a child to stop. */
export function waitsForAgent(state: SkillState): boolean {
  return state.host.kind === 'pending' || state.attempts.some((open) => open.phase === 'offered' || (open.phase === 'stopping' && open.by === 'agent'));
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
      if (input.localOnly.length > 0) {
        return { row: 'R8', state, effects: [], answer: { kind: 'error', refusal: { code: 'needs_local_driver', name: input.name, steps: input.localOnly }, next: null } };
      }
      if (input.check.kind === 'confirm-needed') {
        const { missing, outOfRange } = input.check;
        return { row: 'R9', state, effects: [], answer: { kind: 'error', refusal: { code: 'confirm_needed', name: input.name, missing, ...(outOfRange ? { outOfRange } : {}) }, next: 'describe' } };
      }
      return { row: 'R10', state, effects: [{ kind: 'start', parallel: input.check.parallel, host: input.prompts ? 'pending' : 'none' }] };
    case 'call': {
      if (!state) return { row: 'R11', state, effects: [], answer: { kind: 'error', refusal: { code: 'not_skill_run', run: input.run }, next: null } };
      if (input.takeover) return { row: 'S4', state: takenOver(state, input.session, input.at), effects: [] };
      const owner = state.orchestrator.session;
      if (owner !== undefined && input.session !== undefined && owner !== input.session) {
        const idleSeconds = Math.round((Date.parse(input.at) - Date.parse(state.orchestrator.lastCallAt)) / 1000);
        return { row: 'S2', state, effects: [], answer: { kind: 'error', refusal: { code: 'orchestrator_active', run: state.run, idleSeconds }, next: 'takeover' } };
      }
      return { row: 'S1', state: { ...state, orchestrator: { session: state.orchestrator.session ?? input.session, lastCallAt: input.at } }, effects: [] };
    }
    case 'runner-call':
      if (!state) return undefined;
      return { row: 'S5', state, effects: [] };
    case 'report-call': {
      const open = state && openAttempt(state, input.attempt);
      // A report already stored may come again: its send was refused, and the child runs the same literal.
      if (!state || (!state.settled.includes(input.attempt) && !(open && (reportedByAgent(open) || open.phase === 'reporting')))) return undefined;
      return { row: 'S6', state, effects: [] };
    }
    case 'next':
      if (!state) return undefined;
      if (state.done) return { row: state.attempts.length > 0 ? 'X4' : 'X2', state, effects: [] };
      return tick(state, 'call');
    case 'tick':
      if (!state || state.done) return undefined;
      return tick(state, input.role);
    case 'choose':
      if (!state) return undefined;
      if (state.host.kind !== 'pending') return { row: 'R15', state, effects: [], answer: { kind: 'error', refusal: { code: 'unknown_choice', run: state.run }, next: 'next' } };
      return { row: 'R13', state: { ...state, host: { kind: 'chosen', id: input.choice, children: input.profile.children } }, effects: [] };
    case 'ack': {
      if (!state) return undefined;
      if (state.host.kind === 'pending') return choicePending(state);
      const open = openAttempt(state, input.attempt);
      if (open?.phase === 'offered') {
        const { reissued: _reissued, ...rest } = open;
        return { row: 'K1', state: withAttempt(state, { ...rest, phase: 'dispatched' }), effects: [] };
      }
      if (open?.phase === 'dispatched') return { row: 'K2', state, effects: [] };
      return { row: 'K3', state, effects: [], answer: { kind: 'error', refusal: { code: 'unknown_offer', run: state.run, attempt: input.attempt }, next: 'next' } };
    }
    case 'reply':
      return state && !state.done ? reply(state, input.reply, input.at) : undefined;
    case 'cancelled': {
      const open = state && !state.done ? openAttempt(state, input.attempt) : undefined;
      if (!state || !open) return undefined;
      const stopping = (by: 'runner' | 'agent'): AttemptState => ({ ...baseOf(open), phase: 'stopping', by, why: stopReason(open, input.at) });
      switch (open.phase) {
        case 'queued': {
          const others = state.attempts.filter((other) => other.attempt !== open.attempt);
          return { row: 'D2', state: withEvent({ ...state, attempts: others }, { kind: 'stopped', step: open.step, attempt: open.attempt, why: stopReason(open, input.at) }), effects: [] };
        }
        case 'preparing':
        case 'running':
          return { row: 'D3', state: withAttempt(state, stopping('runner')), effects: [] };
        case 'offered':
        case 'dispatched':
          return { row: 'D4', state: withAttempt(state, stopping('agent')), effects: [] };
        case 'stopping':
        case 'reporting':
          return { row: 'D5', state, effects: [] };
        default: {
          const unhandled: never = open;
          return unhandled;
        }
      }
    }
    case 'spawned':
      return state && !state.done ? { row: 'D18', state, effects: [{ kind: 'grace' }] } : undefined;
    case 'lock-busy':
      return { row: 'D19', state, effects: [], answer: { kind: 'error', refusal: { code: 'driver_running', run: input.run }, next: 'same' } };
    case 'turn':
      if (!state) return undefined;
      return { row: 'D20', state: { ...state, seen: { ...state.seen, [seenBy(input.session)]: state.seq } }, effects: [], answer: { kind: 'turn', events: 'unseen', poll: !state.done } };
    case 'poll': {
      if (state && !input.busy && waitsForAgent(state)) return { row: 'D22', state, effects: [], answer: { kind: 'turn', events: 'none', poll: false } };
      if (state?.done && !input.busy && state.attempts.length === 0 && (state.seen[seenBy(input.session)] ?? 0) < state.seq) {
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
    case 'offer': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'preparing') return undefined;
      return { row: 'C2', state: withAttempt(state, { ...open, phase: 'offered', dispatch: input.dispatch }), effects: [] };
    }
    case 'place-busy': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'preparing') return undefined;
      return { row: 'C4', state: withAttempt(state, { ...open, phase: 'queued', behind: input.behind }), effects: [] };
    }
    case 'unqueue': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'queued' || openAttempt(state, open.behind)) return undefined;
      const { behind: _behind, ...rest } = open;
      return { row: 'D9', state: withAttempt(state, { ...rest, phase: 'preparing', spawnedAt: input.at }), effects: [{ kind: 'spawn', attempt: open.attempt }] };
    }
    case 'prepare-failed':
    case 'model-failed': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running')) return undefined;
      const reporting: AttemptState = { ...baseOf(open), phase: 'reporting', body: input.body };
      return { row: input.kind === 'prepare-failed' ? 'C7' : 'C3', state: withAttempt(state, reporting), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
    }
    case 'exited': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'running') return undefined;
      const reporting: AttemptState = { ...open, phase: 'reporting', body: input.body, ...(input.tail ? { tail: input.tail } : {}) };
      return { row: 'C8', state: withAttempt(state, reporting), effects: [{ kind: 'send', attempt: input.attempt, body: input.body }] };
    }
    case 'runner-free': {
      const open = state && openAttempt(state, input.attempt);
      if (state && open?.phase === 'stopping' && open.by === 'runner') {
        const given = released(state, open, 'C11');
        return { ...given, effects: [{ kind: 'stop-left', attempt: open.attempt }, ...given.effects] };
      }
      if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running') || Date.parse(input.at) - Date.parse(open.spawnedAt) <= input.graceMs) return undefined;
      const respawned = withAttempt(state, { ...open, spawnedAt: input.at });
      return {
        row: 'C10', state: withEvent(respawned, { kind: 'restarted', step: open.step, attempt: open.attempt }),
        effects: [{ kind: 'stop-left', attempt: open.attempt }, { kind: 'spawn', attempt: open.attempt }],
      };
    }
    case 'runner-stop': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'stopping' || open.by !== 'runner') return undefined;
      return released(state, open, 'C9');
    }
    case 'reported': {
      const open = state && openAttempt(state, input.attempt);
      if (!state || open?.phase !== 'reporting') return undefined;
      const others = state.attempts.filter((other) => other.attempt !== open.attempt);
      if (input.reply.kind === 'error' && input.reply.error.code === 'lease_cancelled') {
        const why = open.stopped ?? stopReason(open, input.at);
        return { row: 'P9', state: withEvent({ ...state, attempts: others, settled: [...state.settled, open.attempt] }, { kind: 'stopped', step: open.step, attempt: open.attempt, why }), effects: [] };
      }
      if (input.reply.kind === 'error' && input.reply.error.code !== 'repeated_report') {
        return { row: 'P10', state, effects: [], answer: { kind: 'engine-error', error: input.reply.error, next: 'same' } };
      }
      const outcome = input.reply.kind === 'reported' ? input.reply.outcome : open.body.outcome;
      const dropped = { ...state, attempts: others, settled: [...state.settled, open.attempt] };
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
      if (!state) return undefined;
      if (state.settled.includes(input.attempt)) return { row: 'P1', state, effects: [] };
      const open = openAttempt(state, input.attempt);
      if (open?.phase === 'stopping' && open.by === 'agent') return released(state, open, 'P6');
      if (open?.phase === 'reporting') return { row: 'P11', state, effects: [{ kind: 'send', attempt: open.attempt, body: open.body }] };
      if (state.done) return undefined;
      if (state.host.kind === 'pending') return choicePending(state);
      if (!open) return { row: 'P2', state, effects: [], answer: { kind: 'error', refusal: { code: 'unknown_attempt', run: state.run, attempt: input.attempt }, next: 'next' } };
      if (open.phase !== 'offered' && open.phase !== 'dispatched') {
        return { row: 'P3', state, effects: [], answer: { kind: 'error', refusal: { code: 'not_dispatched', run: state.run, attempt: input.attempt, phase: open.phase }, next: 'next' } };
      }
      const { model } = open.dispatch;
      const base = { attempt: open.attempt, revision: open.revision, driver: state.driver };
      const unavailable = input.modelUnavailable && model.by !== 'definition';
      const failure = unavailable
        ? { code: 'model_unavailable', message: `Step "${open.step}" needs model ${model.name}, which the host of this coding session cannot run.` }
        : input.result.kind === 'failure' ? input.result.failure : undefined;
      const body: ReportBody = failure
        ? { ...base, outcome: 'failed', message: failure.message, failure }
        : { ...base, outcome: 'success', ...(input.result.kind === 'output' ? { outputs: input.result.output } : {}) };
      const { dispatch: _dispatch, ...rest } = open;
      return { row: unavailable ? 'P4' : 'P5', state: withAttempt(state, { ...rest, phase: 'reporting', body }), effects: [{ kind: 'send', attempt: open.attempt, body }] };
    }
    default: {
      const unhandled: never = input;
      return unhandled;
    }
  }
}

/** The most attempts `state` keeps open at once: `--parallel`, and one under a serial host. */
export function childCap(state: SkillState): number {
  return state.host.kind === 'chosen' && state.host.children === 'serial' ? 1 : state.options.parallel;
}

/** Whether `state` has room for another attempt. */
export function hasSlot(state: SkillState): boolean {
  return state.attempts.length < childCap(state);
}

function tick(state: SkillState, role: 'call' | 'runner'): Step {
  if (state.host.kind === 'pending') return { row: 'R12', state, effects: [] };
  return { row: 'D1', state, effects: [{ kind: 'next', running: state.attempts.map((open) => open.attempt), canTakeLease: role === 'call' && hasSlot(state) }] };
}

/**
 * `state` driven from session `session` from `at` on. Every dispatch an earlier session was shown is offered again, as
 * reissued, since that session may have started its child.
 */
function takenOver(state: SkillState, session: string | undefined, at: string): SkillState {
  const attempts = state.attempts.map((open): AttemptState => {
    if (open.phase !== 'offered' && open.phase !== 'dispatched') return open;
    return { ...open, phase: 'offered', reissued: true };
  });
  const from = state.orchestrator.session;
  return withEvent({ ...state, attempts, orchestrator: { ...(session !== undefined ? { session } : {}), lastCallAt: at } }, { kind: 'takeover', ...(from !== undefined ? { from } : {}) });
}

function choicePending(state: SkillState): Step {
  return { row: 'R14', state, effects: [], answer: { kind: 'error', refusal: { code: 'choice_pending', run: state.run }, next: 'next' } };
}

function reply(state: SkillState, engine: EngineReply, at: string): Step {
  switch (engine.kind) {
    case 'lease': {
      const { attempt, step: id, revision, executor, expiresAt } = engine.lease;
      const preparing = withAttempt(state, { attempt, step: id, revision, spawnedAt: at, ...(expiresAt !== undefined ? { expiresAt } : {}), phase: 'preparing' });
      return { row: executor === 'command' ? 'D6' : 'D7', state: withEvent(preparing, { kind: 'started', step: id, attempt }), effects: [{ kind: 'spawn', attempt, job: { lease: engine.raw } }] };
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
