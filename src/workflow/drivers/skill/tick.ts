/**
 * The shell around the transitions: it takes the run lock, reads and saves skill.json, calls the protocol for each
 * effect, and feeds each answer back as the next input. It holds the lock only while it ticks, never across a sleep.
 */
import { driverIdentity } from '../../../driver-identity.js';
import { scoredLabels } from '../../../scorers/engine-hooks.js';
import type { ToolId } from '../../../tools.js';
import { canonicalJson } from '../../../utils/canonical-json.js';
import type { PersonHandoff, ResumeClaim, RunReadied } from '../../protocol.js';
import { AttemptResult } from '../../attempt-result.js';
import { attemptResultPath, type AttemptId, type RunId, type RunLock } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import { readChildResult } from './child-brief.js';
import { engineReply, reportReply, respondReply, startedOf } from './engine-replies.js';
import { canFor, confinedCan, HOST_PROFILES, sessionJudgeTool, sessionOffers, sessionToolJudge, type ConfinedJudge, type HostChoice } from './host-profiles.js';
import { writeJob } from './job.js';
import {
  ackLiteral, adoptLiteral, chooseHostLiteral, nextLiteral, pollLiteral, reportLiteral, respondLiteral, resumeLiteral, skillResumeLiteral, skillResumeNextLiteral, takeoverLiteral, unavailableLiteral, type Invocation,
  type Literal,
} from './literals.js';
import { attendedReason, ceilingOf, localPromptTool, localReason, needsTool } from './preflight.js';
import { drivesRun, newSkillState, readSkillState, removeSkillState, scoringSkillState, writeSkillState, type AttemptState, type SkillState, type TurnEvent } from './skill-state.js';
import {
  ackRow, adoptRow, callRow, cancelledRow, chooseRow, doneRow, gateCheckRow, giveUpRow, graceRow, hasSlot, heldProbeRow, invokeRow, lockBusyRow, offeredRow, pollRow, queuedAttempts, readiedRow, reopenedRow, replyRow,
  deadlineRow, reportCallRow, reportedRow, reportRow, resendRow, respondedRow, runnerFreeRow, scoredRow, scoringTickRow, startedRow, tickRow, turnRow, unattendedRow, unqueueRow, unseenEvents, type Answer,
  type Effect, type MovedWithEffects, type ResumeAnswers, type RowId, type StartRun, type TickTurn, type TurnAnswer,
} from './transitions.js';
import { errorOf, scoringWaits, turnOf, type SkillAnswer, type SkillError, type Turn, type Waiting } from './turn.js';
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

/** Applies the effects of a row that moved the run to `start`, in order, under `lock`. `unqueued`: the attempts D9 unqueued this tick. */
export async function applyEffects(context: SkillContext, lock: RunLock, start: SkillState, effects: readonly Effect[], unqueued: readonly AttemptId[] = []): Promise<Applied> {
  let applied: Applied = { state: start, spawned: false };

  for (const effect of effects) {
    switch (effect.kind) {
      case 'spawn':
        await spawnRunner(context, applied.state, effect.attempt, effect.job);
        applied.spawned = true;
        break;
      case 'stop-left':
        await context.runners.stopLeft(applied.state.run, effect.attempt);
        break;
      case 'send': {
        const sent = await sendReport(context, lock, applied.state, effect, unqueued);
        applied.state = sent.state;

        if (sent.refused) applied.refused = sent.refused;
        break;
      }

      case 'give-up': {
        const answer = await context.client.giveUp(applied.state.run, effect.steps);

        if ('error' in answer) applied.refused = answer.error;
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
async function sendReport(context: SkillContext, lock: RunLock, state: SkillState, { attempt, body, changed }: Extract<Effect, { kind: 'send' }>, unqueued: readonly AttemptId[]): Promise<{ state: SkillState; refused?: WorkflowFailure }> {
  await writeSkillState(context.config, lock, state, context.env.secrets);
  // The attempts still waiting for their place keep their whole timeout through this report too.
  const sent = { ...body, queued: queuedAttempts(state, unqueued) };
  const answer = await context.client.report(state.run, sent, changed === undefined ? { lock } : { lock, changed });
  const taken = traced(context, reportedRow(state, { attempt, reply: reportReply(answer), at: context.now().toISOString() }));

  if (!taken) return { state };

  if ('answer' in taken) return { state, refused: taken.answer.error };

  return { state: traced(context, startedRow(taken.state, startedOf(answer)))?.state ?? taken.state };
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

/** One tick under `lock`: the steps' tick, then, for a call, each run `scoring` lists. */
export async function runTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<Ticked> {
  const stepped = await stepTick(context, lock, start, role);

  return { ...stepped, state: role === 'call' ? await scoringTick(context, stepped.state) : stepped.state };
}

/**
 * J8: ticks each run `scoring` lists as a call ticks its own run, under that run's lock, writing its skill.json from
 * `start`'s the first time; a run whose lock is busy waits for the next tick. J9 and J10 drop a run once it is done or
 * its tick fails.
 */
async function scoringTick(context: SkillContext, start: SkillState): Promise<SkillState> {
  let state = start;

  for (const run of traced(context, scoringTickRow(start))?.runs ?? []) {
    const taken = await context.locks.take(run, async (lock) => {
      const read = await readSkillState(context.config, run);
      const child = read.kind === 'found' ? read.state : scoringSkillState(state, run, context.now().toISOString());
      const ticked = await runTick(context, lock, child, 'call');
      await writeSkillState(context.config, lock, ticked.state, context.env.secrets);

      return ticked;
    }, 0);

    if (taken.kind === 'busy') continue;
    const { state: ticked, error } = taken.value;
    const labels = scoredLabels(ticked.done?.outputs);
    const row = traced(context, scoredRow(state, error ? { run, ticked, labels, error } : { run, ticked, labels }));

    if (row) state = row.state;
  }

  return state;
}

/** The skill states of the runs `state`'s `scoring` lists, as last saved; one not saved yet has nothing to show. */
async function scoringStates(context: SkillContext, state: SkillState): Promise<SkillState[]> {
  const read = await Promise.all(state.scoring.map(({ run }) => readSkillState(context.config, run)));

  return read.flatMap((found) => (found.kind === 'found' ? [found.state] : []));
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
    host: planned.host, session: context.session, tool: context.tool, at: context.now().toISOString(), judge: planned.judge,
  });
}

/** The end a `done` names, whether the engine answered it or the driver kept it, so the two compare as equal text. */
function endOf(done: KeptEnd): KeptEnd {
  return { outcome: done.outcome, failure: done.failure, prs: done.prs };
}

/** The parts of a run's end the driver compares with what the engine answers. */
type KeptEnd = Pick<NonNullable<SkillState['done']>, 'outcome' | 'failure' | 'prs'>;

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

  const unqueued: AttemptId[] = [];

  const apply = async (effects: readonly Effect[]): Promise<Applied> => {
    const applied = await applyEffects(context, lock, state, effects, unqueued);
    state = applied.state;
    spawned = spawned || applied.spawned;

    return applied;
  };

  for (const open of start.attempts) {
    const moved = traced(context, await attemptCheckRow(context, state, open));

    if (!moved) continue;

    if (moved.row === 'D9') unqueued.push(open.attempt);
    state = moved.state;
    await apply(moved.effects);
  }

  let probed = false;
  // Set once the run could not be offered to a person: the engine then fails the steps only one can take.
  let unoffered: PersonHandoff | undefined;

  for (;;) {
    const version = state.done ? await context.client.runVersion(state.run) : undefined;
    const ticked = traced(context, tickRow(state, { role, version, unqueued }));

    if (!('request' in ticked)) return { state, spawned };

    if ('state' in ticked) state = ticked.state;
    const { request } = ticked;
    probed = probed || !request.canTakeLease;

    // The engine reads an absent autoApprove and an undefined one alike, and the CLI's JSON drops it.
    const body = {
      driver: { ...state.driver, can: { ...canFor(state.host.kind === 'chosen' ? state.host.id : undefined), confined: confinedCan(state) } }, running: request.running, queued: request.queued, canTakeLease: request.canTakeLease,
      runMode: state.options.mode, autoApprove: request.autoApprove ? true : undefined,
    };

    const handoff = unoffered ?? request.handoff;
    const options = handoff === undefined ? undefined : { handoff };
    const answer = await context.client.next(state.run, body, options);
    const at = context.now().toISOString();
    const { reply, cancelled, deadlines } = engineReply(state.run, answer);
    state = traced(context, startedRow(state, startedOf(answer)))?.state ?? state;
    const sameEnd = reply.kind === 'done' && reply.out && state.done !== undefined && canonicalJson(endOf(reply)) === canonicalJson(endOf(state.done));
    state = traced(context, reopenedRow(state, { reply, sameEnd }))?.state ?? state;

    for (const attempt of cancelled) state = traced(context, cancelledRow(state, { attempt, at }))?.state ?? state;

    for (const restarted of deadlines) state = traced(context, deadlineRow(state, restarted))?.state ?? state;
    state = traced(context, gateCheckRow(state, reply))?.state ?? state;
    const givingUp = traced(context, giveUpRow(state, reply));

    // A step given up lets the run go on, so the engine is asked again; one it refused waits as D14 says.
    if (givingUp && (await apply(givingUp.effects)).refused === undefined) continue;
    const ended = reply.kind === 'done' && !state.done ? await context.client.runVersion(state.run) : undefined;
    const replied = traced(context, replyRow(state, { reply, at, version: ended }));

    if (!replied) return { state, spawned };

    if ('answer' in replied) {
      return { state, spawned, error: errorOf(replied.answer, { invocation: state.invocation, same: nextLiteral(state.invocation, state.run), run: state.run }) };
    }

    state = replied.state;
    await apply(replied.effects);

    if (replied.row === 'D30') {
      const offered = traced(context, offeredRow({ steps: replied.offer, offered: await context.client.offer(state.run, state.driver.workspace) }));

      if (offered.row === 'D32') {
        unoffered = offered.handoff;
        continue;
      }

      return { state, spawned, waiting: replied.waiting, turn: offered.turn };
    }

    if (!probed && traced(context, heldProbeRow(reply))) {
      probed = true;
      const probe = engineReply(state.run, await context.client.next(state.run, { ...body, canTakeLease: false }, options)).reply;
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
      const result: Ticked = { state, spawned };

      if (replied.waiting) result.waiting = replied.waiting;

      if (replied.turn) result.turn = replied.turn;

      return result;
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
      published: input.resume !== undefined, claim: input.resume !== undefined && input.resume.claim !== 'lacking', ceiling: ceilingOf(context.config), can: canFor(undefined),
    });

    const local = carried ? localReason(carried.description) : undefined;
    const attended = carried ? attendedNow(carried) : undefined;

    if (carried && (local !== undefined || attended !== undefined)) {
      const readied: RunReadied = { kind: 'ready', installed: false, ...carried, judging: { kind: 'none' } };
      const refused = traced(context, readiedRow({ run, readied, kept: false, mode: context.mode, local, attended, needsTool: false, answers, confirmed }));

      if (refused && 'answer' in refused) return { answer: { error: errorOf(refused.answer, { invocation: context.invocation, same, localTool }) } };
    }
  }

  if (input.resume !== undefined || (input.takeover && !state)) {
    const readied = await context.client.resume(run, {
      lock, claim: input.resume === undefined ? 'none' : input.resume.claim, checkout: context.cwd, ceiling: ceilingOf(context.config), can: { ...canFor(undefined), confined: await sessionOffers(context.tool) }, tool: context.tool,
    });

    const local = readied.kind === 'ready' ? localReason(readied.description) : undefined;
    const attended = readied.kind === 'ready' && context.mode === 'unattended' ? attendedNow(readied) : undefined;

    const taken = traced(context, readiedRow({
      run, readied, kept: state !== undefined, mode: context.mode, local, attended, answers, confirmed,
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

/** What still needs a person to continue a run: nothing once it ended, since a resume then only readies it as it ended. */
function attendedNow(run: Pick<Extract<RunReadied, { kind: 'ready' }>, 'description' | 'status'>): string | undefined {
  return run.status === 'running' ? attendedReason(run.description, 'continue') : undefined;
}

/**
 * The turn of `state` as `answer` renders it, from the events the session has not seen, why the run waits, and the runs
 * that score its passes (J8). A run that scores another's pass leads back to that run, which drives it.
 */
function rendered(state: SkillState, answer: TurnAnswer, input: { events: TurnEvent[]; waiting?: Waiting; localTool?: string; scoring?: readonly SkillState[] }): Turn {
  const back = state.scores ?? state.run;

  const after = answer.after === 'none' ? undefined
    : { kind: answer.after, run: answer.after === 'wake' ? nextLiteral(state.invocation, back) : pollLiteral(state.invocation, back) };

  return turnOf(state, {
    events: answer.events === 'unseen' ? input.events : [], after, waiting: input.waiting, quiet: answer.quiet ? true : undefined, localTool: input.localTool, scoring: input.scoring, offered: answer.offered,
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
  const scoring = await scoringStates(context, shown.state);

  return { data: { turn: rendered(shown.state, shown.turn, { events, waiting: shown.waiting, localTool: runPromptTool(context, shown.state), scoring }) } };
}

/**
 * A `resume --driver skill`: `claim`, which runs it takes from teamai-reports; `confirmed`, the person's yes to
 * continue a run of an `invoke: ask` workflow; `answers`, its options.
 */
interface Resume { claim: ResumeClaim; confirmed: boolean; answers: ResumeAnswers; tool?: ToolId }

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
    case 'resume': {
      const options = { ...call.answers, noJudge: call.answers.judge === false, confirmed: call.confirmed, tool: call.tool };

      switch (call.claim) {
        case 'offered':
          // A run `--next` picked is taken only while it is offered, so the same call picks again.
          return skillResumeNextLiteral(invocation, options);
        case 'any':
        case 'lacking':
          return skillResumeLiteral(invocation, run, { claim: call.claim === 'any', ...options });
        default: {
          const unhandled: never = call.claim;

          return unhandled;
        }
      }
    }

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
      return chooseRow(state, { choice: call.choice, profile: HOST_PROFILES[call.choice], judgeTool: sessionJudgeTool(state), judge: await sessionJudgeOn(state, call.choice) });
    case 'ack':
      return ackRow(state, call.attempt);
    case 'adopt':
      return adoptRow(state, { attempt: call.attempt, dir: call.dir, at: context.now().toISOString() });
    case 'respond': {
      const answer = await context.client.respond(state.run, call.step, call.choice, { pass: call.pass, via: { kind: 'skill', driver: state.driver, queued: queuedAttempts(state) } });

      return respondedRow(state, respondReply(answer));
    }

    default: {
      const unhandled: never = call;

      return unhandled;
    }
  }
}

/** The confined judge of the session's tool, probed only when `choice` is a host that starts no child agent for a session judge. */
async function sessionJudgeOn(state: SkillState, choice: HostChoice): Promise<ConfinedJudge | undefined> {
  const tool = sessionJudgeTool(state);

  return HOST_PROFILES[choice].startsChildAgent || tool === undefined ? undefined : sessionToolJudge(tool);
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
    await AttemptResult.mask(attemptResultPath(context.config, run, attempt), context.env.secrets);
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
      const scoring = await scoringStates(context, result.state);
      const polled = traced(context, pollRow(result.state, { session: context.session, busy: false, boundReached, ticked: result, scoringWaits: scoringWaits(scoring) }));
      last = 'state' in polled ? polled.state : result.state;
      await writeSkillState(context.config, lock, last, context.env.secrets);

      if (!('turn' in polled)) return 'sleep';

      return { data: { turn: rendered(last, polled.turn, { events, waiting: polled.waiting, localTool: runPromptTool(context, last), scoring }) } };
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

        const polled = traced(context, pollRow(last, { session: context.session, busy: true, boundReached, ticked: {}, scoringWaits: false }));

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
