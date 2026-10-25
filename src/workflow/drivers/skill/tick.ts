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
import type { EnvScope } from '../../requirements.js';
import { AttemptIdSchema, attemptDir, type AttemptId, type RunId, type RunLock } from '../../store.js';
import type { WorkflowEnvelope, WorkflowFailure } from '../../types.js';
import { readChildResult } from './child-brief.js';
import { canFor, HOST_PROFILES, judgeCan, type HostChoice } from './host-profiles.js';
import {
  ackLiteral, adoptLiteral, chooseHostLiteral, describeLiteral, localStartLiteral, nextLiteral, pollLiteral, reportLiteral, respondLiteral, takeoverLiteral, unavailableLiteral, type Invocation,
  type Literal,
} from './literals.js';
import { localPromptTool } from './preflight.js';
import { readSkillState, writeSkillState, type ReportBody, type SkillState, type TurnEvent } from './skill-state.js';
import {
  adoptRow, hasSlot, step, unseenEvents, type Answer, type EngineReply, type MachineInput, type ReadLease, type Refusal, type ReportReply, type RespondReply, type RowId, type ScoreReply,
  type Step, type TurnAnswer,
} from './transitions.js';
import { turnOf, type SkillAnswer, type SkillError, type Turn, type Waiting } from './turn.js';
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

/** The most steps the skill driver runs at once for `config`. */
export function ceilingOf(config: LocalConfig): number {
  return config.workflows?.max_parallel ?? SKILL_MAX_CHILDREN;
}

/** Takes the row `input` matches, and tells the context's trace which one. */
export function take(context: SkillContext, state: SkillState | undefined, input: MachineInput): Step | undefined {
  const taken = step(state, input);
  return taken && traced(context, taken);
}

/** Tells the context's trace the row `taken` names, for a row that answers with its own result. */
export function traced<T extends { row: RowId }>(context: SkillContext, taken: T): T {
  context.trace?.(taken.row);
  return taken;
}

const EnvScopeShape = z.object({ provide: z.array(z.string()), withhold: z.array(z.string()) }) satisfies z.ZodType<EnvScope>;
const LeaseBase = {
  attempt: AttemptIdSchema,
  step: z.string(),
  revision: z.number().int(),
  expiresAt: z.string().optional(),
  interactive: z.literal(true).optional(),
};
const LeaseSchema = z.union([
  z.object({ ...LeaseBase, command: z.string(), env: z.record(z.string()).optional(), envScope: EnvScopeShape.optional() }),
  z.object({
    ...LeaseBase, prompt: z.string(), workspace: z.object({ mode: z.string() }).optional(),
    agent: z.string().optional(), model: z.string().optional(), defaultModel: z.string().optional(), output: z.unknown().optional(),
  }),
]);

/** The lease `raw` the engine sent, as this driver runs it. Undefined when this teamai cannot run it. */
function readLease(raw: unknown): ReadLease | undefined {
  const read = LeaseSchema.safeParse(raw);
  if (!read.success) return undefined;
  const { attempt, step: id, revision, expiresAt } = read.data;
  const base = { attempt, step: id, revision, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  if ('command' in read.data) {
    const { command, env, envScope } = read.data;
    return { ...base, executor: 'command', command, env: env ?? {}, ...(envScope ? { envScope } : {}) };
  }
  const { prompt, workspace, agent, model, defaultModel, output, interactive } = read.data;
  return {
    ...base, executor: 'prompt', prompt, place: workspace === undefined ? 'checkout' : 'workspace', writes: workspace?.mode === 'new' || workspace?.mode === 'continue',
    ...(interactive ? { interactive } : {}),
    ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

const JobSchema = z.object({ lease: z.unknown() });
/** What a runner runs: its attempt's lease, masked, as the engine sent it (`raw`) and as this driver reads it. */
export interface Job {
  raw: unknown;
  lease: ReadLease;
}

function jobPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'job.json');
}

export async function readJob(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<Job | undefined> {
  try {
    const parsed = JobSchema.safeParse(JSON.parse(await readFileSafe(jobPath(config, run, attempt)) ?? 'null'));
    const lease = parsed.success ? readLease(parsed.data.lease) : undefined;
    return parsed.success && lease ? { raw: parsed.data.lease, lease } : undefined;
  } catch {
    return undefined;
  }
}

async function spawnRunner(context: SkillContext, state: SkillState, attempt: AttemptId, job: { lease: unknown } | undefined): Promise<void> {
  if (job) {
    await fs.mkdir(attemptDir(context.config, state.run, attempt), { recursive: true });
    await writeJsonAtomic(jobPath(context.config, state.run, attempt), redactJson(job, context.env.secrets));
  }
  await context.runners.spawn({ run: state.run, attempt, checkout: state.driver.workspace });
}

const FailureSchema = z.object({ code: z.string(), message: z.string() });
const NextDataSchema = z.object({
  /** The attempts this driver listed as running that the engine no longer leases to it. */
  cancelled: z.array(AttemptIdSchema).optional(),
  lease: z.unknown().optional(),
  hitl: z.object({
    step: z.string(), pass: z.number().int(), kind: z.enum(['approve', 'choose']), message: z.string(), options: z.array(z.string()), default: z.string().optional(), required: z.boolean(),
  }).optional(),
  wait: z.object({
    reason: z.string(), delivering: z.array(z.string()).optional(), held: z.array(z.object({ step: z.string(), missing: z.array(z.string()) })).optional(),
  }).optional(),
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional(), prs: z.array(z.string()).optional() }).optional(),
});

/** The engine's answer to `next`, and the attempts it no longer leases to this driver. */
function engineReply(run: RunId, answer: WorkflowEnvelope): { reply: EngineReply; cancelled: AttemptId[] } {
  if ('error' in answer) return { reply: { kind: 'error', error: { code: answer.error.code, message: answer.error.message } }, cancelled: [] };
  const data = NextDataSchema.safeParse(answer.data);
  if (!data.success) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} answered next with a reply this teamai cannot read: ${data.error.issues[0]?.message ?? 'invalid'}. Update teamai.` } }, cancelled: [] };
  }
  const { done, lease, hitl, wait, cancelled = [] } = data.data;
  if (done) return { reply: { kind: 'done', outcome: done.outcome, ...(done.failure ? { failure: done.failure } : {}), prs: done.prs ?? [] }, cancelled };
  if (hitl) {
    const { step: id, pass, kind, message, options, default: chosen, required } = hitl;
    return { reply: { kind: 'hitl', gate: { step: id, pass, kind, message, options, ...(chosen !== undefined ? { default: chosen } : {}), required } }, cancelled };
  }
  if (lease === undefined) {
    return { reply: { kind: 'wait', reason: wait?.reason ?? 'the next step is not available', delivering: wait?.delivering ?? [], held: wait?.held ?? [] }, cancelled };
  }
  const read = readLease(lease);
  if (!read) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} leased a step the skill driver cannot run. Ask the person to continue it in a terminal with teamai workflow resume ${run}.` } }, cancelled };
  }
  return { reply: { kind: 'lease', lease: read, raw: lease }, cancelled };
}

const AnsweredDataSchema = z.object({ answered: z.object({ step: z.string(), pass: z.number().int(), choice: z.string(), channel: z.string(), agent: z.boolean() }) });

function respondReply(answer: WorkflowEnvelope): RespondReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = AnsweredDataSchema.safeParse(answer.data);
  return data.success
    ? { kind: 'answered', ...data.data.answered }
    : { kind: 'error', error: { code: 'run_unreadable', message: 'The engine answered respond with a reply this teamai cannot read. Update teamai.' } };
}

const ReportDataSchema = z.object({ step: z.object({ outcome: z.enum(['success', 'failed', 'released']), failure: FailureSchema.optional() }) });

function reportReply(answer: WorkflowEnvelope): ReportReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = ReportDataSchema.safeParse(answer.data);
  if (!data.success) return { kind: 'error', error: { code: 'run_unreadable', message: 'The engine answered a report with a reply this teamai cannot read. Update teamai.' } };
  const { outcome, failure } = data.data.step;
  return { kind: 'reported', outcome, ...(failure ? { failure } : {}) };
}

/**
 * Saves `state`, which holds the report `body` of `attempt`, then sends that body under `lock` and applies the engine's
 * answer. A crash after the engine took the report leaves the body stored, and the next tick sends it again (P11).
 */
export async function sendReport(context: SkillContext, lock: RunLock, state: SkillState, attempt: AttemptId, body: ReportBody): Promise<{ state: SkillState; refused?: WorkflowFailure }> {
  await writeSkillState(context.config, lock, state, context.env.secrets);
  const reply = reportReply(await context.client.report(state.run, body, { lock }));
  const taken = take(context, state, { kind: 'reported', attempt, reply, at: context.now().toISOString() });
  const refused = taken?.answer?.kind === 'engine-error' ? taken.answer.error : undefined;
  return { state: taken?.state ?? state, ...(refused ? { refused } : {}) };
}

/** The error a row answers, with its message and the literal to run instead. `run` names the run of an engine error. */
/** `localTool`: the prompt tool a local start the refusal prints names (`localPromptTool`). */
export function errorOf(answer: Extract<Answer, { kind: 'error' | 'engine-error' }>, context: { invocation: Invocation; same: Literal; run?: RunId; localTool?: string }): SkillError {
  const { invocation, same } = context;
  if (answer.kind === 'engine-error') {
    const next = context.run === undefined || answer.next === 'same' ? same : answer.next === 'poll' ? pollLiteral(invocation, context.run) : nextLiteral(invocation, context.run);
    return { ...answer.error, next };
  }
  const { refusal } = answer;
  const next = answer.next === null ? null
    : answer.next === 'next' && 'run' in refusal ? nextLiteral(invocation, refusal.run)
      : answer.next === 'takeover' && 'run' in refusal ? takeoverLiteral(invocation, refusal.run)
        : answer.next === 'describe' && 'name' in refusal ? describeLiteral(invocation, refusal.name)
          : same;
  return { code: refusal.code, message: refusalMessage(refusal, { invocation, tool: context.localTool }), ...(refusal.code === 'orchestrator_active' ? { idleSeconds: refusal.idleSeconds } : {}), next };
}

/** The message of each refusal: what happened, and what the agent or the person does next. */
function refusalMessage(refusal: Refusal, local: { invocation: Invocation; tool?: string | undefined }): string {
  switch (refusal.code) {
    case 'needs_local_driver':
      return `Workflow ${refusal.name} must run with the local driver. ${refusal.reason} Ask the person to run ${localStartLiteral(local.invocation, refusal.name, { tool: local.tool })} in their own terminal.`;
    case 'confirm_needed': {
      const lacks = refusal.missing.map((answer) => ({ confirmed: '--confirmed, the person\'s yes', inputs: '--inputs', parallel: '--parallel', hitl: '--hitl or --auto-approve' })[answer]);
      const said = [
        ...(lacks.length > 0 ? [`it needs ${lacks.join(', ')}`] : []),
        ...(refusal.outOfRange ? [`--parallel ${refusal.outOfRange.parallel} is above the most this machine runs at once, ${refusal.outOfRange.ceiling}`] : []),
      ];
      return `Start ${refusal.name} from its describe reply: ${said.join('; ')}. Run the describe literal and ask the person.`;
    }
    case 'not_skill_run':
      return `Run ${refusal.run} is not driven by the skill driver on this machine. The person can continue it in a terminal with teamai workflow resume ${refusal.run}.`;
    case 'orchestrator_active':
      return `Run ${refusal.run} is driven by another coding session, which last called ${refusal.idleSeconds} s ago. Ask the person whether that session is gone, and run the command in next only when they agree to take the run over here; otherwise the run goes on from that session.`;
    case 'choice_pending':
      return `Run ${refusal.run} waits for the host question. Run the next literal, then the run of the option that fits your host.`;
    case 'unknown_choice':
      return `Run ${refusal.run} asks no host question now: its host is already chosen, or it has no prompt step. Run the next literal to see the run.`;
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

const ScoreDataSchema = z.object({
  lease: z.object({ ref: z.string(), subject: z.object({ step: z.string() }), scorer: z.string().optional(), scorers: z.array(z.string()).optional() }).optional(),
});

/** What `score --next` answered, with the lease read as the judge it opens. */
function scoreReply(answer: WorkflowEnvelope): ScoreReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = ScoreDataSchema.safeParse(answer.data);
  if (!data.success) return { kind: 'error', error: { code: 'run_unreadable', message: `score --next answered with a reply this teamai cannot read: ${data.error.issues[0]?.message ?? 'invalid'}. Update teamai.` } };
  const { lease } = data.data;
  if (!lease) return { kind: 'idle' };
  // A lease ref is `<entry>/<attempt>`: its attempt keys the judge's runner as a step's attempt keys its own.
  const attempt = AttemptIdSchema.safeParse(lease.ref.slice(lease.ref.indexOf('/') + 1));
  const scorers = lease.scorers ?? (lease.scorer !== undefined ? [lease.scorer] : []);
  if (!attempt.success || scorers.length === 0) return { kind: 'error', error: { code: 'run_unreadable', message: `score --next answered with judge lease ${lease.ref}, which this teamai cannot read. Update teamai.` } };
  return { kind: 'lease', judge: { ref: lease.ref, attempt: attempt.data, step: lease.subject.step, scorers } };
}

/**
 * The judge work of a tick: gives judging up when the open judge's runner is gone (J5), then renews its lease, or,
 * with no judge open, takes the next pass of this run to judge and spawns its runner (J1, J2).
 */
async function judgeTick(context: SkillContext, start: SkillState, role: 'call' | 'runner'): Promise<SkillState> {
  let state = start;
  const open = state.judging?.open;
  if (open && !(await context.runners.alive(state.run, open.attempt))) {
    const freed = take(context, state, { kind: 'judge-free', at: context.now().toISOString(), graceMs: WAIT_GRACE_MS });
    if (freed?.state) {
      state = freed.state;
      for (const effect of freed.effects) if (effect.kind === 'stop-left') await context.runners.stopLeft(state.run, effect.attempt);
    }
  }
  const score = take(context, state, { kind: 'judge-tick', role })?.effects.find((effect) => effect.kind === 'score');
  if (score?.kind !== 'score') return state;
  const answer = await context.client.scoreNext({ driver: { ...state.driver, can: { judge: judgeCan(score.tool) } }, run: state.run, running: score.running, canTakeLease: score.canTakeLease });
  const replied = take(context, state, { kind: 'score-reply', reply: scoreReply(answer), at: context.now().toISOString() });
  if (!replied?.state) return state;
  for (const effect of replied.effects) if (effect.kind === 'spawn') await spawnRunner(context, replied.state, effect.attempt, undefined);
  return replied.state;
}

/**
 * What a tick leaves: the state, whether it spawned runners, why the run leases nothing more, the turn a row of the tick
 * decided, and the error the engine answered.
 */
interface Ticked {
  state: SkillState;
  spawned: boolean;
  waiting?: Waiting;
  turn?: TurnAnswer;
  error?: SkillError;
}

/**
 * One tick under `lock`: the steps' tick, then the judge work's. Judge runners count as no spawn: a turn waits for
 * nothing of theirs.
 */
export async function runTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<Ticked> {
  const stepped = await stepTick(context, lock, start, role);
  return { ...stepped, state: await judgeTick(context, stepped.state, role) };
}

/**
 * The steps' tick: sends the reports a crash left stored, respawns runners that are gone and gives up the attempts a
 * gone runner was stopping, then, while the run drives, calls `next` while a lease comes back and a slot is free, and
 * once more after the last lease while a gate is journalled: with no slot, that reply says whether the gate still
 * waits. Each reply's `cancelled`, then its gate check, are taken before the reply itself. A runner's check
 * (`role: 'runner'`) takes no lease.
 */
async function stepTick(context: SkillContext, lock: RunLock, start: SkillState, role: 'call' | 'runner'): Promise<Ticked> {
  let state = start;
  let spawned = false;
  for (const open of start.attempts) {
    if (open.phase === 'reporting') {
      const resent = take(context, state, { kind: 'resend', attempt: open.attempt });
      if (resent?.state) state = (await sendReport(context, lock, resent.state, open.attempt, open.body)).state;
      continue;
    }
    if (open.phase === 'queued') {
      const unqueued = take(context, state, { kind: 'unqueue', attempt: open.attempt, at: context.now().toISOString() });
      if (!unqueued?.state) continue;
      state = unqueued.state;
      await spawnRunner(context, state, open.attempt, undefined);
      spawned = true;
      continue;
    }
    if (open.phase !== 'preparing' && open.phase !== 'running' && !(open.phase === 'stopping' && open.by === 'runner')) continue;
    if (await context.runners.alive(state.run, open.attempt)) continue;
    const freed = take(context, state, { kind: 'runner-free', attempt: open.attempt, at: context.now().toISOString(), graceMs: WAIT_GRACE_MS });
    if (!freed?.state) continue;
    state = freed.state;
    for (const effect of freed.effects) {
      if (effect.kind === 'stop-left') await context.runners.stopLeft(state.run, effect.attempt);
      if (effect.kind === 'spawn') {
        await spawnRunner(context, state, effect.attempt, undefined);
        spawned = true;
      }
      if (effect.kind === 'send') state = (await sendReport(context, lock, state, effect.attempt, effect.body)).state;
    }
  }
  let probed = false;
  for (;;) {
    const ticked = take(context, state, { kind: 'tick', role });
    const next = ticked?.effects.find((effect) => effect.kind === 'next');
    if (!next || next.kind !== 'next') return { state, spawned };
    probed = probed || !next.canTakeLease;
    const answer = await context.client.next(state.run, {
      driver: { ...state.driver, can: canFor(state.host.kind === 'chosen' ? state.host.id : undefined) }, running: next.running, canTakeLease: next.canTakeLease, ...(next.autoApprove ? { autoApprove: true } : {}),
    });
    const at = context.now().toISOString();
    const { reply, cancelled } = engineReply(state.run, answer);
    for (const attempt of cancelled) state = take(context, state, { kind: 'cancelled', attempt, at })?.state ?? state;
    state = take(context, state, { kind: 'gate-check', reply })?.state ?? state;
    const replied = take(context, state, { kind: 'reply', reply, at });
    if (!replied) return { state, spawned };
    state = replied.state ?? state;
    for (const effect of replied.effects) {
      if (effect.kind !== 'spawn') continue;
      await spawnRunner(context, state, effect.attempt, effect.job);
      spawned = true;
    }
    if (replied.answer?.kind === 'engine-error') {
      return { state, spawned, error: errorOf(replied.answer, { invocation: state.invocation, same: nextLiteral(state.invocation, state.run), run: state.run }) };
    }
    const leased = reply.kind === 'lease';
    if (!leased || (!hasSlot(state) && (state.gate === undefined || probed))) {
      return { state, spawned, ...(replied.waiting ? { waiting: replied.waiting } : {}), ...(replied.turn ? { turn: replied.turn } : {}) };
    }
  }
}

const BusySchema = z.object({ error: z.object({ code: z.literal('driver_running'), message: z.string() }) });

/** Whether a `locks.take` answered that another process holds the run lock. */
function busy(result: unknown): result is z.infer<typeof BusySchema> {
  return BusySchema.safeParse(result).success;
}

/** D19: the lock stayed busy. */
function lockBusy(context: SkillContext, run: RunId, same: Literal): SkillAnswer {
  const taken = take(context, undefined, { kind: 'lock-busy', run });
  const answer = taken?.answer?.kind === 'error' ? taken.answer : { kind: 'error' as const, refusal: { code: 'driver_running' as const, run }, next: 'same' as const };
  return { error: errorOf(answer, { invocation: context.invocation, same }) };
}

/**
 * Reads skill.json under the lock, and takes its S row, or R11 when there is none. `takeover` is a `next --takeover`;
 * `report` is the attempt an agent's report names, which skips the session check when the agent reports it (S6).
 */
async function called(context: SkillContext, run: RunId, same: Literal, input: { takeover?: true; report?: AttemptId } = {}): Promise<{ state: SkillState } | { answer: SkillAnswer }> {
  const read = await readSkillState(context.config, run);
  if ('kind' in read && read.kind === 'unreadable') {
    return { answer: { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} cannot be read (${read.reason}). The person can continue the run in a terminal with teamai workflow resume ${run}.`, next: null } } };
  }
  const state = 'kind' in read ? undefined : read;
  const exempt = input.report !== undefined ? take(context, state, { kind: 'report-call', attempt: input.report }) : undefined;
  if (exempt?.state) return { state: exempt.state };
  const taken = take(context, state, { kind: 'call', run, session: context.session, at: context.now().toISOString(), takeover: input.takeover === true });
  if (taken?.state && !taken.answer) return { state: taken.state };
  const refused = taken?.answer?.kind === 'error' || taken?.answer?.kind === 'engine-error' ? taken.answer : { kind: 'error' as const, refusal: { code: 'not_skill_run' as const, run }, next: null };
  return { answer: { error: errorOf(refused, { invocation: context.invocation, same, run }) } };
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

/** D20: saves `state` as shown to the calling session and answers its turn. */
async function finish(context: SkillContext, lock: RunLock, state: SkillState, ticked: Pick<Ticked, 'waiting' | 'turn'>): Promise<SkillAnswer> {
  const events = unseenEvents(state, context.session);
  const shown = take(context, state, { kind: 'turn', session: context.session })?.state ?? state;
  await writeSkillState(context.config, lock, shown, context.env.secrets);
  const { waiting, turn } = ticked;
  const localTool = localPromptTool(context.config, context.tool);
  if (turn) return { data: { turn: rendered(shown, turn, { events, ...(waiting ? { waiting } : {}), localTool }) } };
  return { data: { turn: turnOf(shown, { events, after: { kind: 'poll', run: pollLiteral(shown.invocation, shown.run) }, ...(waiting ? { waiting } : {}), localTool }) } };
}

/**
 * A call that answers with a turn at once: `next`, a takeover, an answer to the host question, an ack, a place the host
 * made, or an answer to a gate.
 */
export type ForegroundCall =
  | { kind: 'next' }
  | { kind: 'takeover' }
  | { kind: 'choose'; choice: HostChoice }
  | { kind: 'ack'; attempt: AttemptId }
  | { kind: 'adopt'; attempt: AttemptId; dir: string }
  | { kind: 'respond'; step: string; pass: number; choice: string };

function literalOf(invocation: Invocation, run: RunId, call: ForegroundCall): Literal {
  switch (call.kind) {
    case 'next':
      return nextLiteral(invocation, run);
    case 'takeover':
      return takeoverLiteral(invocation, run);
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

/**
 * The row `call` takes before the tick, under the lock: the state the tick starts from, and whether the row spawned a
 * runner, or the answer it gives instead.
 */
async function applyCall(context: SkillContext, lock: RunLock, state: SkillState, call: ForegroundCall, same: Literal): Promise<{ state: SkillState; spawned?: true } | { answer: SkillAnswer }> {
  let taken: Step | undefined;
  switch (call.kind) {
    case 'next':
    case 'takeover':
      return { state: state.done ? take(context, state, { kind: 'next' })?.state ?? state : state };
    case 'choose':
      taken = take(context, state, { kind: 'choose', choice: call.choice, profile: HOST_PROFILES[call.choice] });
      break;
    case 'ack':
      taken = take(context, state, { kind: 'ack', attempt: call.attempt });
      break;
    case 'adopt': {
      const adopted = traced(context, adoptRow(state, { attempt: call.attempt, dir: call.dir, at: context.now().toISOString() }));
      if ('answer' in adopted) {
        await writeSkillState(context.config, lock, state, context.env.secrets);
        return { answer: { error: errorOf(adopted.answer, { invocation: state.invocation, same, run: state.run }) } };
      }
      await spawnRunner(context, adopted.state, adopted.spawn, undefined);
      return { state: adopted.state, spawned: true };
    }
    case 'respond': {
      const answer = await context.client.respond(state.run, call.step, call.choice, { pass: call.pass, via: { kind: 'skill', driver: state.driver } });
      taken = take(context, state, { kind: 'responded', reply: respondReply(answer) });
      break;
    }
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
  if (taken?.answer?.kind === 'error' || taken?.answer?.kind === 'engine-error') {
    await writeSkillState(context.config, lock, state, context.env.secrets);
    return { answer: { error: errorOf(taken.answer, { invocation: state.invocation, same, run: state.run }) } };
  }
  return { state: taken?.state ?? state };
}

/**
 * A foreground call answers at once, after the tick its row leads to, or, when the tick spawned runners, after they
 * prepared or `WAIT_GRACE_MS` passed (D18).
 */
export async function foreground(context: SkillContext, run: RunId, call: ForegroundCall): Promise<SkillAnswer> {
  const same = literalOf(context.invocation, run, call);
  const first = await context.locks.take(run, async (lock): Promise<{ answer: SkillAnswer } | { grace: true }> => {
    const read = await called(context, run, same, call.kind === 'takeover' ? { takeover: true } : {});
    if ('answer' in read) return read;
    const applied = await applyCall(context, lock, read.state, call, same);
    if ('answer' in applied) return applied;
    const ticked = await runTick(context, lock, applied.state, 'call');
    const { state } = ticked;
    if (ticked.error) {
      await writeSkillState(context.config, lock, state, context.env.secrets);
      return { answer: { error: ticked.error } };
    }
    if (!(ticked.spawned || applied.spawned) || !take(context, state, { kind: 'spawned' })) return { answer: await finish(context, lock, state, ticked) };
    await writeSkillState(context.config, lock, state, context.env.secrets);
    return { grace: true };
  }, TICK_LOCK_WAIT_MS);
  if (busy(first)) return lockBusy(context, run, same);
  if ('answer' in first) return first.answer;
  const until = context.now().getTime() + WAIT_GRACE_MS;
  for (;;) {
    await context.runners.sleep(GRACE_CHECK_MS);
    const checked = await context.locks.take(run, async (lock): Promise<SkillAnswer | 'again'> => {
      const read = await readSkillState(context.config, run);
      if ('kind' in read) return { error: { code: 'run_unreadable', message: `The skill driver's state of run ${run} went missing while it ran.`, next: null } };
      if (read.attempts.some((open) => open.phase === 'preparing') && context.now().getTime() < until) return 'again';
      // The tick's reason to wait is stale once its runners moved, and while they have not, an attempt is open.
      return finish(context, lock, read, {});
    }, TICK_LOCK_WAIT_MS);
    if (checked === 'again') continue;
    return busy(checked) ? lockBusy(context, run, same) : checked;
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
    const read = await called(context, run, same, { report: attempt });
    if ('answer' in read) return read.answer;
    const { state } = read;
    const result = await readChildResult({ config: context.config, run, attempt });
    const taken = take(context, state, { kind: 'report', attempt, modelUnavailable: call.modelUnavailable, result });
    if (taken?.answer?.kind === 'error' || taken?.answer?.kind === 'engine-error') {
      await writeSkillState(context.config, lock, state, context.env.secrets);
      return { error: errorOf(taken.answer, { invocation: state.invocation, same, run }) };
    }
    if (taken?.row === 'P1') return { data: { runner: { attempt, status: 'repeated' } } };
    const send = taken?.effects.find((effect) => effect.kind === 'send');
    if (!taken?.state || send?.kind !== 'send') return { data: { runner: { attempt, status: 'gone' } } };
    const sent = await sendReport(context, lock, taken.state, attempt, send.body);
    await writeSkillState(context.config, lock, sent.state, context.env.secrets);
    if (sent.refused) return { error: { ...sent.refused, next: same } };
    return { data: { runner: { attempt, status: sent.state.settled.includes(attempt) ? 'reported' : 'gone' } } };
  }, WAIT_BOUND_MS);
  return busy(answered) ? lockBusy(context, run, same) : answered;
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
      const read = await called(context, run, same);
      if ('answer' in read) return read.answer;
      const result = await runTick(context, lock, read.state, 'call');
      const { state } = result;
      if (result.error) {
        await writeSkillState(context.config, lock, state, context.env.secrets);
        return { error: result.error };
      }
      const events = unseenEvents(state, context.session);
      const polled = take(context, state, { kind: 'poll', session: context.session, busy: false, boundReached, ...(result.turn ? { ticked: result.turn } : {}) });
      last = polled?.state ?? state;
      await writeSkillState(context.config, lock, last, context.env.secrets);
      const waiting = result.waiting ? { waiting: result.waiting, localTool: localPromptTool(context.config, context.tool) } : {};
      if (polled?.turn) return { data: { turn: rendered(last, polled.turn, { events, ...waiting }) } };
      if (polled?.row === 'D23') return { data: { turn: turnOf(last, { events, after: { kind: 'poll', run: same } }) } };
      if (polled?.row === 'D22') return { data: { turn: turnOf(last, { events: [], after: { kind: 'wake', run: nextLiteral(last.invocation, run) }, quiet: true }) } };
      if (polled?.row === 'D24') return { data: { turn: turnOf(last, { events: [], after: { kind: 'poll', run: same }, ...waiting, quiet: true }) } };
      if (polled?.row === 'D25') return { data: { turn: turnOf(last, { events, after: { kind: 'poll', run: same }, ...waiting, quiet: true }) } };
      return 'sleep';
    }, 0);
    if (busy(ticked)) {
      const polled = take(context, last, { kind: 'poll', session: context.session, busy: true, boundReached });
      if (polled?.row === 'D24') return last ? { data: { turn: turnOf(last, { events: [], after: { kind: 'poll', run: same }, quiet: true }) } } : lockBusy(context, run, same);
    } else if (ticked !== 'sleep') {
      return ticked;
    }
    await context.runners.sleep(WAIT_POLL_MS);
  }
}

/** The error a start answers when the protocol refused it: describe again to see why, unless only the person can start it, or no start runs from here. */
export function startRefused(context: SkillContext, name: string, error: WorkflowFailure): SkillAnswer {
  return { error: { ...error, next: error.code === 'invoke_denied' || error.code === 'nested_workflow' ? null : describeLiteral(context.invocation, name) } };
}
