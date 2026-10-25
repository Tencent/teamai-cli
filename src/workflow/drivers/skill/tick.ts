/**
 * The shell around the transitions: it takes the run lock, reads and saves skill.json, calls the protocol for each
 * effect, and feeds each answer back as the next input. It holds the lock only while it ticks, never across a sleep.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../../utils/fs.js';
import { redactJson } from '../../../utils/redact.js';
import type { DriverCan } from '../../requirements.js';
import { AttemptIdSchema, attemptDir, type AttemptId, type RunId, type RunLock } from '../../store.js';
import type { WorkflowEnvelope, WorkflowFailure } from '../../types.js';
import { describeLiteral, nextLiteral, pollLiteral, reportLiteral, type Literal } from './literals.js';
import { readSkillState, writeSkillState, type ReportBody, type SkillState } from './skill-state.js';
import { hasSlot, step, unseenEvents, type Answer, type EngineReply, type MachineInput, type ReportReply, type Step } from './transitions.js';
import { turnOf, type SkillAnswer, type SkillError } from './turn.js';
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
/** The most steps the skill driver runs at once when the member set no `workflows.max_parallel`. */
export const SKILL_MAX_CHILDREN = 3;
const GRACE_CHECK_MS = 250;

/** What the skill driver declares on every `next`: it runs commands in the checkout, and no person answers through it. */
const CAN: DriverCan = { hitl: false, workspace: ['read-only'] };

/** The most steps the skill driver runs at once for `config`. */
export function ceilingOf(config: LocalConfig): number {
  return config.workflows?.max_parallel ?? SKILL_MAX_CHILDREN;
}

/** Takes the row `input` matches, and tells the context's trace which one. */
export function take(context: SkillContext, state: SkillState | undefined, input: MachineInput): Step | undefined {
  const taken = step(state, input);
  if (taken) context.trace?.(taken.row);
  return taken;
}

const JobSchema = z.object({ command: z.string(), env: z.record(z.string()) });
/** What a runner runs: the leased command and the env the lease rendered for it. */
export type Job = z.infer<typeof JobSchema>;

function jobPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'job.json');
}

export async function readJob(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<Job | undefined> {
  try {
    const parsed = JobSchema.safeParse(JSON.parse(await readFileSafe(jobPath(config, run, attempt)) ?? 'null'));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function spawnRunner(context: SkillContext, state: SkillState, attempt: AttemptId, job: Job | undefined): Promise<void> {
  if (job) {
    await fs.mkdir(attemptDir(context.config, state.run, attempt), { recursive: true });
    await writeJsonAtomic(jobPath(context.config, state.run, attempt), redactJson(job, context.env.secrets));
  }
  await context.runners.spawn({ run: state.run, attempt, checkout: state.driver.workspace });
}

const FailureSchema = z.object({ code: z.string(), message: z.string() });
const LeaseSchema = z.object({
  attempt: AttemptIdSchema,
  step: z.string(),
  revision: z.number().int(),
  command: z.string(),
  env: z.record(z.string()).optional(),
  prompt: z.undefined(),
  workspace: z.undefined(),
});
const NextDataSchema = z.object({
  lease: z.unknown().optional(),
  wait: z.object({ reason: z.string() }).optional(),
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional() }).optional(),
});

function engineReply(run: RunId, answer: WorkflowEnvelope): EngineReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = NextDataSchema.safeParse(answer.data);
  if (!data.success) {
    return { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} answered next with a reply this teamai cannot read: ${data.error.issues[0]?.message ?? 'invalid'}. Update teamai.` } };
  }
  const { done, lease, wait } = data.data;
  if (done) return { kind: 'done', outcome: done.outcome, ...(done.failure ? { failure: done.failure } : {}) };
  if (lease === undefined) return { kind: 'wait', reason: wait?.reason ?? 'the next step is not available' };
  const read = LeaseSchema.safeParse(lease);
  if (!read.success) {
    return { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} leased a step the skill driver cannot run. Ask the person to continue it in a terminal with teamai workflow resume ${run}.` } };
  }
  const { attempt, step: id, revision, command, env } = read.data;
  return { kind: 'lease', lease: { attempt, step: id, revision, command, env: env ?? {} } };
}

const ReportDataSchema = z.object({ step: z.object({ outcome: z.enum(['success', 'failed', 'released']) }) });

function reportReply(answer: WorkflowEnvelope): ReportReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = ReportDataSchema.safeParse(answer.data);
  return data.success
    ? { kind: 'reported', outcome: data.data.step.outcome }
    : { kind: 'error', error: { code: 'run_unreadable', message: 'The engine answered a report with a reply this teamai cannot read. Update teamai.' } };
}

/** Sends the stored report `body` of `attempt` under `lock`, and applies the engine's answer. */
export async function sendReport(context: SkillContext, lock: RunLock, state: SkillState, attempt: AttemptId, body: ReportBody): Promise<{ state: SkillState; refused?: WorkflowFailure }> {
  const reply = reportReply(await context.client.report(state.run, body, { lock }));
  const taken = take(context, state, { kind: 'reported', attempt, reply });
  const refused = taken?.answer?.kind === 'engine-error' ? taken.answer.error : undefined;
  return { state: taken?.state ?? state, ...(refused ? { refused } : {}) };
}

/** The error a row answers, with its message and the literal to run instead. */
export function errorOf(answer: Extract<Answer, { kind: 'error' | 'engine-error' }>, state: { run: RunId; invocation: SkillState['invocation'] }, same: Literal, message?: string): SkillError {
  const next = answer.next === null ? null
    : answer.next === 'same' ? same
      : answer.next === 'next' ? nextLiteral(state.invocation, state.run)
        : same;
  if (answer.kind === 'engine-error') return { ...answer.error, next };
  return { code: answer.code, message: message ?? ERROR_MESSAGES[answer.code](state.run), next };
}

const ERROR_MESSAGES: Record<Extract<Answer, { kind: 'error' }>['code'], (run: RunId) => string> = {
  needs_local_driver: () => 'This workflow has steps the skill driver does not run in a coding session yet. The person can run it in a terminal with the local driver.',
  confirm_needed: () => 'This start lacks an answer describe asks for. Run the describe literal and ask the person.',
  not_skill_run: (run) => `Run ${run} is not driven by the skill driver on this machine. The person can continue it in a terminal with teamai workflow resume ${run}.`,
  orchestrator_active: (run) => `Run ${run} is driven by another coding session. Continue it from that session.`,
  unknown_attempt: (run) => `That attempt is not open in run ${run}. Run the next literal to see the run.`,
  not_dispatched: (run) => `That attempt of run ${run} runs as a command, and its runner reports it. Run the next literal to see the run.`,
  driver_running: (run) => `Run ${run} is busy: another teamai process holds its driver lock. Run the same call again.`,
};

/**
 * One tick under `lock`: sends the reports a crash left stored, respawns runners that are gone, then calls `next` while
 * a lease comes back and a slot is free.
 */
async function runTick(context: SkillContext, lock: RunLock, start: SkillState): Promise<{ state: SkillState; spawned: boolean; waiting?: { reason: string }; error?: SkillError }> {
  let state = start;
  let spawned = false;
  for (const open of start.attempts) {
    if (open.phase === 'reporting') {
      const resent = take(context, state, { kind: 'resend', attempt: open.attempt });
      if (resent?.state) state = (await sendReport(context, lock, resent.state, open.attempt, open.body)).state;
      continue;
    }
    if (await context.runners.alive(state.run, open.attempt)) continue;
    const respawned = take(context, state, { kind: 'runner-free', attempt: open.attempt, at: context.now().toISOString(), graceMs: WAIT_GRACE_MS });
    if (!respawned?.state) continue;
    state = respawned.state;
    await spawnRunner(context, state, open.attempt, undefined);
    spawned = true;
  }
  for (;;) {
    const ticked = take(context, state, { kind: 'tick' });
    const next = ticked?.effects.find((effect) => effect.kind === 'next');
    if (!next || next.kind !== 'next') return { state, spawned };
    const answer = await context.client.next(state.run, { driver: { ...state.driver, can: CAN }, running: next.running, canTakeLease: next.canTakeLease });
    const replied = take(context, state, { kind: 'reply', reply: engineReply(state.run, answer), at: context.now().toISOString() });
    if (!replied) return { state, spawned };
    state = replied.state ?? state;
    for (const effect of replied.effects) {
      if (effect.kind !== 'spawn') continue;
      await spawnRunner(context, state, effect.attempt, effect.job);
      spawned = true;
    }
    if (replied.answer?.kind === 'engine-error') {
      return { state, spawned, error: errorOf(replied.answer, state, nextLiteral(state.invocation, state.run)) };
    }
    if (replied.row !== 'D6' || !hasSlot(state)) return { state, spawned, ...(replied.waiting ? { waiting: replied.waiting } : {}) };
  }
}

const BusySchema = z.object({ error: z.object({ code: z.literal('driver_running'), message: z.string() }) });

/** Whether a `locks.take` answered that another process holds the run lock. */
function busy(result: unknown): result is z.infer<typeof BusySchema> {
  return BusySchema.safeParse(result).success;
}

/** D19: the lock stayed busy. */
function lockBusy(context: SkillContext, run: RunId, same: Literal): SkillAnswer {
  const taken = take(context, undefined, { kind: 'lock-busy' });
  const answer = taken?.answer;
  if (answer?.kind !== 'error') return { error: { code: 'driver_running', message: ERROR_MESSAGES.driver_running(run), next: same } };
  return { error: errorOf(answer, { run, invocation: context.invocation }, same) };
}

/** Reads skill.json under the lock, and takes S1 or S2, or R11 when there is none. */
async function called(context: SkillContext, run: RunId, same: Literal): Promise<{ state: SkillState } | { answer: SkillAnswer }> {
  const read = await readSkillState(context.config, run);
  if ('kind' in read && read.kind === 'unreadable') {
    return { answer: { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} cannot be read (${read.reason}). The person can continue the run in a terminal with teamai workflow resume ${run}.`, next: null } } };
  }
  const state = 'kind' in read ? undefined : read;
  const taken = take(context, state, { kind: 'call', session: context.session, at: context.now().toISOString() });
  if (taken?.answer && (taken.answer.kind === 'error' || taken.answer.kind === 'engine-error')) {
    return { answer: { error: errorOf(taken.answer, { run, invocation: context.invocation }, same) } };
  }
  return taken?.state ? { state: taken.state } : { answer: { error: { code: 'not_skill_run', message: ERROR_MESSAGES.not_skill_run(run), next: null } } };
}

/** D20: saves `state` as shown to the calling session and answers its turn. */
async function finish(context: SkillContext, lock: RunLock, state: SkillState, waiting: { reason: string } | undefined): Promise<SkillAnswer> {
  const events = unseenEvents(state, context.session);
  const shown = take(context, state, { kind: 'turn', session: context.session })?.state ?? state;
  await writeSkillState(context.config, lock, shown, context.env.secrets);
  return { data: { turn: turnOf(shown, { events, poll: pollLiteral(shown.invocation, shown.run), ...(waiting ? { waiting } : {}) }) } };
}

/**
 * A foreground call: `next` ticks the run, `report` from the agent answers an error. Either answers at once, or, when
 * the tick spawned runners, after they prepared or `WAIT_GRACE_MS` passed (D18).
 */
export async function foreground(context: SkillContext, run: RunId, call: { kind: 'next' } | { kind: 'report'; attempt: AttemptId }): Promise<SkillAnswer> {
  const same = call.kind === 'report' ? reportLiteral(context.invocation, run, call.attempt) : nextLiteral(context.invocation, run);
  const first = await context.locks.take(run, async (lock): Promise<{ answer: SkillAnswer } | { grace: { waiting?: { reason: string } } }> => {
    const read = await called(context, run, same);
    if ('answer' in read) return read;
    let state = read.state;
    if (call.kind === 'report') {
      const refused = take(context, state, { kind: 'report', attempt: call.attempt });
      await writeSkillState(context.config, lock, state, context.env.secrets);
      if (refused?.answer?.kind === 'error') return { answer: { error: errorOf(refused.answer, state, same) } };
      return { answer: await finish(context, lock, state, undefined) };
    }
    if (state.done) {
      state = take(context, state, { kind: 'next' })?.state ?? state;
      return { answer: await finish(context, lock, state, undefined) };
    }
    const ticked = await runTick(context, lock, state);
    state = ticked.state;
    if (ticked.error) {
      await writeSkillState(context.config, lock, state, context.env.secrets);
      return { answer: { error: ticked.error } };
    }
    if (!ticked.spawned || !take(context, state, { kind: 'spawned' })) return { answer: await finish(context, lock, state, ticked.waiting) };
    await writeSkillState(context.config, lock, state, context.env.secrets);
    return { grace: ticked.waiting ? { waiting: ticked.waiting } : {} };
  }, call.kind === 'report' ? WAIT_BOUND_MS : TICK_LOCK_WAIT_MS);
  if (busy(first)) return lockBusy(context, run, same);
  if ('answer' in first) return first.answer;
  const until = context.now().getTime() + WAIT_GRACE_MS;
  for (;;) {
    await context.runners.sleep(GRACE_CHECK_MS);
    const checked = await context.locks.take(run, async (lock): Promise<SkillAnswer | 'again'> => {
      const read = await readSkillState(context.config, run);
      if ('kind' in read) return { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} went missing while it ran.`, next: null } };
      if (read.attempts.some((open) => open.phase === 'preparing') && context.now().getTime() < until) return 'again';
      return finish(context, lock, read, first.grace.waiting);
    }, TICK_LOCK_WAIT_MS);
    if (checked === 'again') continue;
    return busy(checked) ? lockBusy(context, run, same) : checked;
  }
}

/** `next --wait`: ticks every `WAIT_POLL_MS`, holding the lock only while it ticks, until the run is done or the bound. */
export async function poll(context: SkillContext, run: RunId): Promise<SkillAnswer> {
  const same = pollLiteral(context.invocation, run);
  const started = context.now().getTime();
  let last: SkillState | undefined;
  for (;;) {
    const boundReached = context.now().getTime() - started >= WAIT_BOUND_MS;
    const ticked = await context.locks.take(run, async (lock): Promise<SkillAnswer | 'sleep'> => {
      const read = await called(context, run, same);
      if ('answer' in read) return read.answer;
      let state = read.state;
      if (!state.done) {
        const result = await runTick(context, lock, state);
        state = result.state;
        if (result.error) {
          await writeSkillState(context.config, lock, state, context.env.secrets);
          return { error: result.error };
        }
      }
      const events = unseenEvents(state, context.session);
      const polled = take(context, state, { kind: 'poll', session: context.session, busy: false, boundReached });
      last = polled?.state ?? state;
      await writeSkillState(context.config, lock, last, context.env.secrets);
      if (polled?.row === 'D23') return { data: { turn: turnOf(last, { events }) } };
      if (polled?.row === 'D24') return { data: { turn: turnOf(last, { events: [], poll: same, quiet: true }) } };
      return 'sleep';
    }, 0);
    if (busy(ticked)) {
      const polled = take(context, last, { kind: 'poll', session: context.session, busy: true, boundReached });
      if (polled?.row === 'D24') return last ? { data: { turn: turnOf(last, { events: [], poll: same, quiet: true }) } } : lockBusy(context, run, same);
    } else if (ticked !== 'sleep') {
      return ticked;
    }
    await context.runners.sleep(WAIT_POLL_MS);
  }
}

/** The error a start answers when the protocol refused it: describe again to see why. */
export function startRefused(context: SkillContext, name: string, error: WorkflowFailure): SkillAnswer {
  return { error: { ...error, next: describeLiteral(context.invocation, name) } };
}
