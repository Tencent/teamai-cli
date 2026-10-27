/**
 * The shell around the transitions: it takes the run lock, reads and saves skill.json, calls the protocol for each
 * effect, and feeds each answer back as the next input. It holds the lock only while it ticks, never across a sleep.
 */
import { driverIdentity } from '../../../driver-identity.js';
import type { ToolId } from '../../../types.js';
import { canonicalJson } from '../../../utils/canonical-json.js';
import type { RunReadied } from '../../protocol.js';
import type { AttemptId, RunId, RunLock } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import { readChildResult } from './child-brief.js';
import { engineReply, reportReply, respondReply, scoreReply } from './engine-replies.js';
import { canFor, HOST_PROFILES, judgeCan, type HostChoice } from './host-profiles.js';
import { writeJob } from './job.js';
import {
  ackLiteral, adoptLiteral, chooseHostLiteral, nextLiteral, pollLiteral, reportLiteral, respondLiteral, resumeLiteral, skillResumeLiteral, takeoverLiteral, unavailableLiteral, type Invocation,
  type Literal,
} from './literals.js';
import { attendedReason, ceilingOf, localPromptTool, localReason, needsTool } from './preflight.js';
import { drivesRun, newSkillState, readSkillState, removeSkillState, writeSkillState, type AttemptState, type ReportBody, type SkillState, type TurnEvent } from './skill-state.js';
import {
  ackRow, adoptRow, callRow, cancelledRow, chooseRow, doneRow, gateCheckRow, graceRow, hasSlot, heldProbeRow, invokeRow, judgeFreeRow, judgeTickRow, lockBusyRow, pollRow, readiedRow, reopenedRow, replyRow,
  reportCallRow, reportedRow, reportRow, resendRow, respondedRow, runnerFreeRow, scoreReplyRow, tickRow, turnRow, unattendedRow, unqueueRow, unseenEvents, type Answer,
  type Effect, type MovedWithEffects, type ResumeAnswers, type RowId, type StartRun, type TickTurn, type TurnAnswer,
} from './transitions.js';
import { errorOf, turnOf, type SkillAnswer, type SkillError, type Turn, type Waiting } from './turn.js';
import type { SkillContext } from './skill-driver.js';

/** How long one poll waits for something to show the agent. */
export const WAIT_BOUND_MS = 100_000;
/** How long a poll sleeps between ticks. */
export const WAIT_POLL_MS = 2_000;
/** How long a call that spawned runners waits for them to prepare, and how young a runner may be without its lock. */
export const WAIT_GRACE_MS = 5_000;
/** How long a foreground call waits for the run lock. */
export const TICK_LOCK_WAIT_MS = 30_000;
/** How long a runner waits before it tries again: for the run lock, or to send a report the engine refused. */
export const RUNNER_POLL_MS = 10_000;
const GRACE_CHECK_MS = 250;

/** Tells the context's trace the row `taken` names, when a row applied. */
export function traced<T extends { row: RowId } | undefined>(context: SkillContext, taken: T): T {
  if (taken) context.trace?.(taken.row);
  return taken;
}

/** What applying a row's effects left: the state, whether a runner was spawned, and the engine's refusal of a report sent. */
interface Applied {
  state: SkillState;
  spawned: boolean;
  refused?: WorkflowFailure;
}

/** Applies the effects of a row that moved the run to `start`, in order, under `lock`. */
export async function applyEffects(context: SkillContext, lock: RunLock, start: SkillState, effects: readonly Effect[]): Promise<Applied> {
  let applied: Applied = { state: start, spawned: false };
  for (const effect of effects) {
    switch (effect.kind) {
      case 'spawn':
        await spawnRunner(context, applied.state, effect.attempt, effect.job);
        applied = { ...applied, spawned: true };
        break;
      case 'stop-left':
        await context.runners.stopLeft(applied.state.run, effect.attempt);
        break;
      case 'send': {
        const sent = await sendReport(context, lock, applied.state, effect.attempt, effect.body);
        applied = { ...applied, state: sent.state, ...(sent.refused ? { refused: sent.refused } : {}) };
        break;
      }
      default: {
        const unhandled: never = effect;
        return unhandled;
      }
    }
  }
  return applied;
}

async function spawnRunner(context: SkillContext, state: SkillState, attempt: AttemptId, job: { lease: unknown } | undefined): Promise<void> {
  if (job) await writeJob({ config: context.config, run: state.run, attempt, raw: job.lease, secrets: context.env.secrets });
  await context.runners.spawn({ run: state.run, attempt, checkout: state.driver.workspace, mode: state.options.mode });
}

/**
 * Saves `state`, which holds the report `body` of `attempt`, then sends that body under `lock` and applies the engine's
 * answer. A crash after the engine took the report leaves the body stored, and the next tick sends it again (P11).
 */
async function sendReport(context: SkillContext, lock: RunLock, state: SkillState, attempt: AttemptId, body: ReportBody): Promise<{ state: SkillState; refused?: WorkflowFailure }> {
  await writeSkillState(context.config, lock, state, context.env.secrets);
  const reply = reportReply(await context.client.report(state.run, body, { lock }));
  const taken = traced(context, reportedRow(state, { attempt, reply, at: context.now().toISOString() }));
  if (!taken) return { state };
  return 'answer' in taken ? { state, refused: taken.answer.error } : { state: taken.state };
}

/**
 * The judge work of a tick: gives judging up when the open judge's runner is gone (J5), then renews its lease, or,
 * with no judge open, takes the next pass of this run to judge and spawns its runner (J1, J2).
 */
async function judgeTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<SkillState> {
  let state = start;
  const open = state.judging?.open;
  if (open && !(await context.runners.alive(state.run, open.attempt))) {
    const freed = traced(context, judgeFreeRow(state, { at: context.now().toISOString(), graceMs: WAIT_GRACE_MS }));
    if (freed) state = (await applyEffects(context, lock, freed.state, freed.effects)).state;
  }
  const ticked = traced(context, judgeTickRow(state, role));
  if (!ticked) return state;
  const { tool, running, canTakeLease } = ticked.request;
  const answer = await context.client.scoreNext({ driver: { ...state.driver, can: { judge: judgeCan(tool) } }, run: state.run, running, canTakeLease });
  const replied = traced(context, scoreReplyRow(state, { reply: scoreReply(answer), at: context.now().toISOString() }));
  if (!replied) return state;
  return (await applyEffects(context, lock, replied.state, replied.effects)).state;
}

/**
 * What a tick leaves: the state, whether it spawned runners, why the run leases nothing more, the turn a row of the tick
 * decided, and the error the engine answered.
 */
interface Ticked extends TickTurn {
  state: SkillState;
  spawned: boolean;
  error?: SkillError;
}

/**
 * One tick under `lock`: the steps' tick, then the judge work's. Judge runners count as no spawn: a turn waits for
 * nothing of theirs.
 */
export async function runTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<Ticked> {
  const stepped = await stepTick(context, lock, start, role);
  return { ...stepped, state: await judgeTick(context, lock, stepped.state, role) };
}

/**
 * The row an open attempt takes as a tick starts: its stored report is sent again (P11), it leaves a queue whose holder
 * closed (D9), or its runner is gone (C10, C11).
 */
async function attemptCheckRow(context: SkillContext, state: SkillState, open: AttemptState): Promise<MovedWithEffects<'P11' | 'D9' | 'C10' | 'C11'> | undefined> {
  switch (open.phase) {
    case 'reporting':
      return resendRow(state, open.attempt);
    case 'queued':
      return unqueueRow(state, { attempt: open.attempt, at: context.now().toISOString() });
    case 'preparing':
    case 'running':
    case 'stopping':
      if (open.phase === 'stopping' && open.by !== 'runner') return undefined;
      if (await context.runners.alive(state.run, open.attempt)) return undefined;
      return runnerFreeRow(state, { attempt: open.attempt, at: context.now().toISOString(), graceMs: WAIT_GRACE_MS });
    case 'placing':
    case 'offered':
    case 'dispatched':
      return undefined;
    default: {
      const unhandled: never = open;
      return unhandled;
    }
  }
}

/** The skill state of `run` as this session starts to drive it, as R10 or R19 `planned` it. */
export function plannedState(context: SkillContext, run: RunId, planned: StartRun): SkillState {
  return newSkillState({
    run, driver: driverIdentity('skill', context.cwd), invocation: context.invocation, options: { parallel: planned.parallel, hitl: planned.hitl, mode: context.mode },
    host: planned.host, session: context.session, tool: context.tool, at: context.now().toISOString(), ...(planned.judge !== undefined ? { judge: planned.judge } : {}),
  });
}

/** The end a `done` names, whether the engine answered it or the driver kept it, so the two compare as equal text. */
function endOf(done: { outcome: string; failure?: WorkflowFailure; prs: string[] }): unknown {
  return { outcome: done.outcome, failure: done.failure, prs: done.prs };
}

/**
 * The steps' tick: sends the reports a crash left stored, respawns runners that are gone and gives up the attempts a
 * gone runner was stopping, then, while the run drives, calls `next` while a lease comes back and a slot is free, once
 * more when a reply to a `next` with no slot freed one (D2), and once more after the last lease while a gate is
 * journalled: with no slot, that reply says whether the gate still waits. A wait that holds a step gets that `next`
 * with no slot too (D27), as the engine answers a held step before a gate. A run that is done gets one `next` with no
 * slot once its run file moved since the end was kept, whose reply says whether the engine reopened it or another
 * driver ended it again; a reopened run then ticks as one that drives. Each reply's
 * reopen check, its `cancelled`, then its gate check, are taken before the reply itself. A runner's check
 * (`role: 'runner'`) takes no lease.
 */
async function stepTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<Ticked> {
  let state = start;
  let spawned = false;
  const apply = async (effects: readonly Effect[]): Promise<void> => {
    const applied = await applyEffects(context, lock, state, effects);
    state = applied.state;
    spawned = spawned || applied.spawned;
  };
  for (const open of start.attempts) {
    const moved = traced(context, await attemptCheckRow(context, state, open));
    if (!moved) continue;
    state = moved.state;
    await apply(moved.effects);
  }
  let probed = false;
  for (;;) {
    const version = state.done ? await context.client.runVersion(state.run) : undefined;
    const ticked = traced(context, tickRow(state, { role, ...(version ? { version } : {}) }));
    if (!('request' in ticked)) return { state, spawned };
    if ('state' in ticked) state = ticked.state;
    const { request } = ticked;
    probed = probed || !request.canTakeLease;
    const body = {
      driver: { ...state.driver, can: canFor(state.host.kind === 'chosen' ? state.host.id : undefined) }, running: request.running, canTakeLease: request.canTakeLease,
      runMode: state.options.mode, ...(request.autoApprove ? { autoApprove: true } : {}),
    };
    const answer = await context.client.next(state.run, body);
    const at = context.now().toISOString();
    const { reply, cancelled } = engineReply(state.run, answer);
    const sameEnd = reply.kind === 'done' && reply.out && state.done !== undefined && canonicalJson(endOf(reply)) === canonicalJson(endOf(state.done));
    state = traced(context, reopenedRow(state, { reply, sameEnd }))?.state ?? state;
    for (const attempt of cancelled) state = traced(context, cancelledRow(state, { attempt, at }))?.state ?? state;
    state = traced(context, gateCheckRow(state, reply))?.state ?? state;
    const ended = reply.kind === 'done' && !state.done ? await context.client.runVersion(state.run) : undefined;
    const replied = traced(context, replyRow(state, { reply, at, ...(ended ? { version: ended } : {}) }));
    if (!replied) return { state, spawned };
    if ('answer' in replied) {
      return { state, spawned, error: errorOf(replied.answer, { invocation: state.invocation, same: nextLiteral(state.invocation, state.run), run: state.run }) };
    }
    state = replied.state;
    await apply(replied.effects);
    if (!probed && traced(context, heldProbeRow(reply))) {
      probed = true;
      const probe = engineReply(state.run, await context.client.next(state.run, { ...body, canTakeLease: false })).reply;
      state = traced(context, gateCheckRow(state, probe))?.state ?? state;
      const asked = probe.kind === 'hitl' ? traced(context, replyRow(state, { reply: probe, at })) : undefined;
      if (asked && 'state' in asked) {
        state = asked.state;
        await apply(asked.effects);
      }
    }
    const leased = reply.kind === 'lease';
    // A cancel in this reply gave up an attempt that waited, so a slot the request had no room for is free now. A run
    // that ended has no step left to fill it.
    const freed = !request.canTakeLease && role === 'call' && !state.done && hasSlot(state);
    if (!freed && (!leased || (!hasSlot(state) && (state.gate === undefined || probed)))) {
      return { state, spawned, ...(replied.waiting ? { waiting: replied.waiting } : {}), ...(replied.turn ? { turn: replied.turn } : {}) };
    }
  }
}

/** D19: the lock stayed busy. */
function lockBusy(context: SkillContext, run: RunId, same: Literal): SkillAnswer {
  return { error: errorOf(traced(context, lockBusyRow(run)).answer, { invocation: context.invocation, same }) };
}

/**
 * Reads skill.json under the run's `lock`, and takes its S row, or R11 when there is none. `takeover` is a
 * `next --takeover`; `report` is the attempt an agent's report names, which skips the session check when the agent
 * reports it (S6). `resume`, and a takeover with no skill.json, first ready the run here, claiming it as
 * `WorkflowClient.resume` does, and take R19, R20 or R21, or R8. An unattended resume or takeover of the skill.json kept
 * here takes R26 first.
 */
async function called(context: SkillContext, lock: RunLock, same: Literal, input: { takeover?: { confirmed: boolean }; report?: AttemptId; resume?: Resume } = {}): Promise<{ state: SkillState } | { answer: SkillAnswer }> {
  const { run } = lock;
  const read = await readSkillState(context.config, run);
  const localTool = localPromptTool(context);
  if (read.kind === 'unreadable') {
    return { answer: { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} cannot be read (${read.reason}). The person can continue the run in a terminal with ${resumeLiteral(context.invocation, run, { tool: localTool })}.`, next: null } } };
  }
  const state = read.kind === 'found' ? read.state : undefined;
  const answers = input.resume?.answers ?? {};
  const confirmed = input.resume?.confirmed ?? input.takeover?.confirmed ?? false;
  if (context.mode === 'unattended' && (input.resume !== undefined || input.takeover)) {
    // Nobody is there to take a run that needs a person or the local driver over from here, so it is refused before the
    // claim, which would leave this install owning it, and before a takeover makes this session its orchestrator.
    const carried = await context.client.carried(run, {
      published: input.resume !== undefined, claim: input.resume?.claim === true, ceiling: ceilingOf(context.config), can: canFor(undefined),
    });
    const local = carried ? localReason(carried.description) : undefined;
    const attended = carried ? attendedReason(carried.description, 'continue', new Set(carried.settled)) : undefined;
    if (carried && (local !== undefined || attended !== undefined)) {
      const readied: RunReadied = { kind: 'ready', installed: false, description: carried.description, settled: carried.settled, judging: { kind: 'none' } };
      const refused = traced(context, readiedRow({ run, readied, kept: false, mode: context.mode, ...(local !== undefined ? { local } : {}), ...(attended !== undefined ? { attended } : {}), needsTool: false, answers, confirmed }));
      if (refused && 'answer' in refused) return { answer: { error: errorOf(refused.answer, { invocation: context.invocation, same, localTool }) } };
    }
  }
  if (input.resume !== undefined || (input.takeover && !state)) {
    const readied = await context.client.resume(run, {
      lock, claim: input.resume === undefined ? 'none' : input.resume.claim ? 'any' : 'lacking', checkout: context.cwd, ceiling: ceilingOf(context.config), can: canFor(undefined),
      ...(context.tool !== undefined ? { tool: context.tool } : {}),
    });
    const local = readied.kind === 'ready' ? localReason(readied.description) : undefined;
    const attended = readied.kind === 'ready' && context.mode === 'unattended' ? attendedReason(readied.description, 'continue', new Set(readied.settled)) : undefined;
    const taken = traced(context, readiedRow({
      run, readied, kept: state !== undefined, mode: context.mode, ...(local !== undefined ? { local } : {}), ...(attended !== undefined ? { attended } : {}), answers, confirmed,
      needsTool: readied.kind === 'ready' && needsTool(readied.description, { tool: context.tool, judged: answers.judge !== false }),
    }));
    if (taken && 'answer' in taken) {
      // R28 with a skill.json kept here comes after the resume installed the published run over it, which made it stale: the
      // resume its next names must ready the run anew, as R19 would have.
      if (taken.row === 'R28' && state !== undefined) await removeSkillState(context.config, lock);
      return { answer: { error: errorOf(taken.answer, { invocation: context.invocation, same, localTool, tool: input.resume?.tool }) } };
    }
    if (taken) {
      return { state: plannedState(context, run, taken.start) };
    }
  }
  const unattended = state && context.mode === 'unattended' && (input.resume !== undefined || input.takeover) ? traced(context, unattendedRow(state, answers)) : undefined;
  const kept = unattended?.state ?? state;
  if (kept && input.report !== undefined && traced(context, reportCallRow(kept, input.report))) return { state: kept };
  const taken = traced(context, callRow(kept, { run, session: context.session, tool: context.tool, declared: input.resume?.tool, at: context.now().toISOString(), takeover: input.takeover !== undefined }));
  if ('answer' in taken) return { answer: { error: errorOf(taken.answer, { invocation: context.invocation, same, run, localTool }) } };
  return { state: taken.state };
}

/** The turn of `state` as `answer` renders it, from the events the session has not seen and why the run waits. */
function rendered(state: SkillState, answer: TurnAnswer, input: { events: TurnEvent[]; waiting?: Waiting; localTool?: string }): Turn {
  const after = answer.after === 'none' ? undefined
    : { kind: answer.after, run: answer.after === 'wake' ? nextLiteral(state.invocation, state.run) : pollLiteral(state.invocation, state.run) };
  return turnOf(state, {
    events: answer.events === 'unseen' ? input.events : [], ...(after ? { after } : {}), ...(input.waiting ? { waiting: input.waiting } : {}), ...(answer.quiet ? { quiet: true } : {}),
    localTool: input.localTool,
  });
}

/** The prompt tool a local start or resume of `state`'s run names: the tool of the session that drives it, when known. */
function runPromptTool(context: SkillContext, state: SkillState): string | undefined {
  return localPromptTool({ ...context, tool: state.orchestrator.tool ?? context.tool });
}

/** D20: saves `state` as shown to the calling session and answers its turn. */
async function finish(context: SkillContext, lock: RunLock, state: SkillState, ticked: TickTurn): Promise<SkillAnswer> {
  const events = unseenEvents(state, context.session);
  const shown = traced(context, turnRow(state, { session: context.session, ticked }));
  await writeSkillState(context.config, lock, shown.state, context.env.secrets);
  return { data: { turn: rendered(shown.state, shown.turn, { events, ...(shown.waiting ? { waiting: shown.waiting } : {}), localTool: runPromptTool(context, shown.state) }) } };
}

/**
 * A `resume --driver skill`: `claim` takes the run from another install that owns it; `confirmed`, the person's yes to
 * continue a run of an `invoke: ask` workflow; `answers`, its options.
 */
interface Resume { claim: boolean; confirmed: boolean; answers: ResumeAnswers; tool?: ToolId }

/**
 * A call that answers with a turn at once: `next`, a takeover, a resume, an answer to the host question, an ack, a place
 * the host made, or an answer to a gate.
 */
export type ForegroundCall =
  | { kind: 'next' }
  | { kind: 'takeover'; confirmed: boolean }
  | ({ kind: 'resume' } & Resume)
  | { kind: 'choose'; choice: HostChoice }
  | { kind: 'ack'; attempt: AttemptId }
  | { kind: 'adopt'; attempt: AttemptId; dir: string }
  | { kind: 'respond'; step: string; pass: number; choice: string };

function literalOf(invocation: Invocation, run: RunId, call: ForegroundCall): Literal {
  switch (call.kind) {
    case 'next':
      return nextLiteral(invocation, run);
    case 'takeover':
      return takeoverLiteral(invocation, run, { confirmed: call.confirmed });
    case 'resume':
      return skillResumeLiteral(invocation, run, { claim: call.claim, ...call.answers, noJudge: call.answers.judge === false, confirmed: call.confirmed, tool: call.tool });
    case 'choose':
      return chooseHostLiteral(invocation, run, call.choice);
    case 'ack':
      return ackLiteral(invocation, run, call.attempt);
    case 'adopt':
      return adoptLiteral(invocation, run, call.attempt, call.dir);
    case 'respond':
      return respondLiteral(invocation, run, call);
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
}

/** The row `call` takes before the tick: the state it leaves and the effects it has, or the error the call answers. */
async function callRowOf(context: SkillContext, state: SkillState, call: ForegroundCall): Promise<{ row: RowId; state: SkillState; effects?: Effect[] } | { row: RowId; answer: Answer } | undefined> {
  switch (call.kind) {
    case 'next':
    case 'takeover':
    case 'resume':
      return undefined;
    case 'choose':
      return chooseRow(state, { choice: call.choice, profile: HOST_PROFILES[call.choice] });
    case 'ack':
      return ackRow(state, call.attempt);
    case 'adopt':
      return adoptRow(state, { attempt: call.attempt, dir: call.dir, at: context.now().toISOString() });
    case 'respond': {
      const answer = await context.client.respond(state.run, call.step, call.choice, { pass: call.pass, via: { kind: 'skill', driver: state.driver } });
      return respondedRow(state, respondReply(answer));
    }
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
}

/**
 * The row `call` takes before the tick, under the lock, and its effects: the state the tick starts from, and whether
 * the row spawned a runner, or the answer it gives instead.
 */
async function applyCall(context: SkillContext, lock: RunLock, state: SkillState, call: ForegroundCall, same: Literal): Promise<Applied | { answer: SkillAnswer }> {
  const taken = traced(context, await callRowOf(context, state, call));
  if (!taken) return { state, spawned: false };
  if ('answer' in taken) {
    await writeSkillState(context.config, lock, state, context.env.secrets);
    return { answer: { error: errorOf(taken.answer, { invocation: state.invocation, same, run: state.run }) } };
  }
  return applyEffects(context, lock, taken.state, taken.effects ?? []);
}

/**
 * R22: why a resume or a takeover may not continue the run, checked before the run lock, whose file would leave
 * `runs/<run>/` behind a refusal on a machine that lacks the run. The session skill.json names as the run's owner is
 * not checked again, as the local resume does not check it (`sessionDrivesRun`).
 */
async function invokeRefused(context: SkillContext, run: RunId, call: Extract<ForegroundCall, { kind: 'resume' | 'takeover' }>): Promise<SkillAnswer | undefined> {
  const read = await readSkillState(context.config, run);
  if (drivesRun(read.kind === 'found' ? read.state : undefined, context.session)) return undefined;
  const caller = { evidence: context.evidence, confirmed: call.confirmed, mode: context.mode };
  const refused = traced(context, invokeRow(await context.client.resumeRefusal(run, { caller, published: call.kind === 'resume' })));
  if (!refused) return undefined;
  const confirmed = literalOf(context.invocation, run, { ...call, confirmed: true });
  return { error: errorOf(refused.answer, { invocation: context.invocation, same: confirmed, localTool: localPromptTool(context) }) };
}

/**
 * A foreground call answers at once, after the tick its row leads to, or, when the tick spawned runners, after they
 * prepared or `WAIT_GRACE_MS` passed (D18).
 */
export async function foreground(context: SkillContext, run: RunId, call: ForegroundCall): Promise<SkillAnswer> {
  const same = literalOf(context.invocation, run, call);
  const refused = call.kind === 'resume' || call.kind === 'takeover' ? await invokeRefused(context, run, call) : undefined;
  if (refused) return refused;
  const first = await context.locks.take(run, async (lock): Promise<{ answer: SkillAnswer } | { grace: true }> => {
    const read = await called(context, lock, same, call.kind === 'takeover' ? { takeover: call } : call.kind === 'resume' ? { resume: call } : {});
    if ('answer' in read) return read;
    const applied = await applyCall(context, lock, read.state, call, same);
    if ('answer' in applied) return applied;
    const ticked = await runTick(context, lock, applied.state, 'call');
    const { state } = ticked;
    // Only the tick knows whether a run that was done still is: the engine may have reopened it (X6).
    if (call.kind === 'next' || call.kind === 'takeover' || call.kind === 'resume') traced(context, doneRow(state));
    if (ticked.error) {
      await writeSkillState(context.config, lock, state, context.env.secrets);
      return { answer: { error: ticked.error } };
    }
    if (!(ticked.spawned || applied.spawned) || !traced(context, graceRow(state))) return { answer: await finish(context, lock, state, ticked) };
    await writeSkillState(context.config, lock, state, context.env.secrets);
    return { grace: true };
  }, TICK_LOCK_WAIT_MS);
  switch (first.kind) {
    case 'held':
      if ('answer' in first.value) return first.value.answer;
      break;
    case 'busy':
      return lockBusy(context, run, same);
    default: {
      const unhandled: never = first;
      return unhandled;
    }
  }
  const until = context.now().getTime() + WAIT_GRACE_MS;
  for (;;) {
    await context.runners.sleep(GRACE_CHECK_MS);
    const checked = await context.locks.take(run, async (lock): Promise<SkillAnswer | 'again'> => {
      const read = await readSkillState(context.config, run);
      if (read.kind !== 'found') return { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} went missing while it ran.`, next: null } };
      if (read.state.attempts.some((open) => open.phase === 'preparing') && context.now().getTime() < until) return 'again';
      // The tick's reason to wait is stale once its runners moved, and while they have not, an attempt is open.
      return finish(context, lock, read.state, {});
    }, TICK_LOCK_WAIT_MS);
    switch (checked.kind) {
      case 'held':
        if (checked.value === 'again') continue;
        return checked.value;
      case 'busy':
        return lockBusy(context, run, same);
      default: {
        const unhandled: never = checked;
        return unhandled;
      }
    }
  }
}

/**
 * An agent's `report --attempt`: the child of the attempt, in whatever session it runs, or the orchestrator. It answers
 * as a runner does, with no turn, so the session's events stay for the orchestrator's own next call to show.
 */
export async function agentReport(context: SkillContext, run: RunId, call: { attempt: AttemptId; modelUnavailable: boolean }): Promise<SkillAnswer> {
  const { attempt } = call;
  const same = (call.modelUnavailable ? unavailableLiteral : reportLiteral)(context.invocation, run, attempt);
  const answered = await context.locks.take(run, async (lock): Promise<SkillAnswer> => {
    const read = await called(context, lock, same, { report: attempt });
    if ('answer' in read) return read.answer;
    const { state } = read;
    const result = await readChildResult({ config: context.config, run, attempt });
    const taken = traced(context, reportRow(state, { attempt, modelUnavailable: call.modelUnavailable, result }));
    if (!taken) return { data: { runner: { attempt, status: 'gone' } } };
    if ('answer' in taken) {
      await writeSkillState(context.config, lock, state, context.env.secrets);
      return { error: errorOf(taken.answer, { invocation: state.invocation, same, run }) };
    }
    if ('repeated' in taken) return { data: { runner: { attempt, status: 'repeated' } } };
    const sent = await applyEffects(context, lock, taken.state, taken.effects);
    await writeSkillState(context.config, lock, sent.state, context.env.secrets);
    if (sent.refused) return { error: { ...sent.refused, next: same } };
    return { data: { runner: { attempt, status: sent.state.settled.includes(attempt) ? 'reported' : 'gone' } } };
  }, WAIT_BOUND_MS);
  switch (answered.kind) {
    case 'held':
      return answered.value;
    case 'busy':
      return lockBusy(context, run, same);
    default: {
      const unhandled: never = answered;
      return unhandled;
    }
  }
}

/**
 * `next --wait`: ticks every `WAIT_POLL_MS`, holding the lock only while it ticks, until work waits for the agent, a step
 * settled or stopped, the run is done, or the bound.
 */
export async function poll(context: SkillContext, run: RunId): Promise<SkillAnswer> {
  const same = pollLiteral(context.invocation, run);
  const started = context.now().getTime();
  let last: SkillState | undefined;
  for (;;) {
    const boundReached = context.now().getTime() - started >= WAIT_BOUND_MS;
    const ticked = await context.locks.take(run, async (lock): Promise<SkillAnswer | 'sleep'> => {
      const read = await called(context, lock, same);
      if ('answer' in read) return read.answer;
      const result = await runTick(context, lock, read.state, 'call');
      if (result.error) {
        await writeSkillState(context.config, lock, result.state, context.env.secrets);
        return { error: result.error };
      }
      const events = unseenEvents(result.state, context.session);
      const polled = traced(context, pollRow(result.state, { session: context.session, busy: false, boundReached, ticked: result }));
      last = 'state' in polled ? polled.state : result.state;
      await writeSkillState(context.config, lock, last, context.env.secrets);
      if (!('turn' in polled)) return 'sleep';
      return { data: { turn: rendered(last, polled.turn, { events, ...(polled.waiting ? { waiting: polled.waiting } : {}), localTool: runPromptTool(context, last) }) } };
    }, 0);
    switch (ticked.kind) {
      case 'held':
        if (ticked.value !== 'sleep') return ticked.value;
        break;
      case 'busy': {
        if (last === undefined) {
          if (boundReached) return lockBusy(context, run, same);
          break;
        }
        const polled = traced(context, pollRow(last, { session: context.session, busy: true, boundReached, ticked: {} }));
        if ('turn' in polled) return { data: { turn: rendered(polled.state, polled.turn, { events: [] }) } };
        break;
      }
      default: {
        const unhandled: never = ticked;
        return unhandled;
      }
    }
    await context.runners.sleep(WAIT_POLL_MS);
  }
}
