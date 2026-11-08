/**
 * The engine's envelopes as the skill driver reads them: each answer to `next`, `respond` and a report, parsed
 * once into the reply its row takes, and a lease, read as the step this driver runs.
 */
import { z } from 'zod';
import { LeaseWireSchema } from '../../lease-wire.js';
import { StartedRunSchema, type StartedRun } from '../../protocol.js';
import { FailureSchema } from '../../step-state.js';
import { AttemptIdSchema, type AttemptId, type RunId } from '../../store.js';
import type { WorkflowEnvelope } from '../../types.js';
import type { AskedGate, EngineReply, ReadLease, ReportReply, RespondReply } from './transitions.js';

/** The lease `raw` the engine sent, as this driver runs it. Undefined when this teamai cannot run it. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: the engine's answer and a runner's job file carry the lease unread
export function readLease(raw: unknown): ReadLease | undefined {
  const read = LeaseWireSchema.safeParse(raw);

  if (!read.success) return undefined;
  const { attempt, step: id, revision, expiresAt, command, env, envScope, prompt, workspace, agent, model, defaultModel, output, interactive, readOnly, requires, confined } = read.data;
  let lease: ReadLease;

  if (command !== undefined) {
    lease = { attempt, step: id, revision, executor: 'command', command, env: env ?? {} };

    if (envScope) lease.envScope = envScope;
  } else {
    // The schema reads a lease with a command or a prompt, so one without a command has its prompt.
    if (prompt === undefined) return undefined;

    lease = {
      attempt, step: id, revision, executor: 'prompt', prompt, place: workspace === undefined ? 'checkout' : 'workspace',
      writes: workspace?.mode === 'new' || workspace?.mode === 'continue' || workspace?.mode === 'team',
    };

    if (workspace?.mode === 'team') lease.team = true;

    if (interactive) lease.interactive = interactive;

    if (readOnly) lease.readOnly = readOnly;

    if (requires?.isolation === 'sandbox') lease.isolation = requires.isolation;

    if (agent !== undefined) lease.agent = agent;

    if (model !== undefined) lease.model = model;

    if (defaultModel !== undefined) lease.defaultModel = defaultModel;

    if (output !== undefined) lease.output = output;

    if (confined) lease.confined = confined;
  }

  if (expiresAt !== undefined) lease.expiresAt = expiresAt;

  return lease;
}

const NextDataSchema = z.object({
  /** The attempts this driver listed as running that the engine no longer leases to it. */
  cancelled: z.array(AttemptIdSchema).optional(),
  /** The deadline of each attempt this driver listed as queued, counted from this call. */
  deadlines: z.record(z.string(), z.string()).optional(),
  lease: z.unknown().optional(),
  hitl: z.object({
    step: z.string(), pass: z.number().int(), kind: z.enum(['approve', 'choose']), message: z.string(), options: z.array(z.string()), default: z.string().optional(), required: z.boolean(),
  }).optional(),
  wait: z.object({
    reason: z.string(), delivering: z.array(z.string()).optional(), held: z.array(z.object({ step: z.string(), missing: z.array(z.string()) })).optional(),
  }).optional(),
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional(), prs: z.array(z.string()).optional(), outputs: z.record(z.string(), z.json()).optional(), notPublished: z.object({ code: z.string() }).optional() }).optional(),
});

/** What `engineReply` reads from an answer to `next`. */
interface NextAnswer {
  reply: EngineReply;
  cancelled: AttemptId[];
  deadlines: Array<{ attempt: AttemptId; deadline: string }>;
}

/** The engine's answer to `next`, and the attempts it no longer leases to this driver. */
export function engineReply(run: RunId, answer: WorkflowEnvelope): NextAnswer {
  if ('error' in answer) return { reply: { kind: 'error', error: { code: answer.error.code, message: answer.error.message } }, cancelled: [], deadlines: [] };
  const data = NextDataSchema.safeParse(answer.data);

  if (!data.success) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} answered next with a reply this teamai cannot read: ${data.error.issues[0]?.message ?? 'invalid'}. Update teamai.` } }, cancelled: [], deadlines: [] };
  }

  const { done, lease, hitl, wait, cancelled = [] } = data.data;

  const deadlines = Object.entries(data.data.deadlines ?? {}).flatMap(([key, deadline]) => {
    const attempt = AttemptIdSchema.safeParse(key);

    return attempt.success ? [{ attempt: attempt.data, deadline }] : [];
  });

  if (done) {
    const reply: EngineReply = { kind: 'done', outcome: done.outcome, prs: done.prs ?? [], out: done.notPublished === undefined || done.notPublished.code === 'not_owner' };

    if (done.failure) reply.failure = done.failure;

    if (done.outputs !== undefined) reply.outputs = done.outputs;

    return { reply, cancelled, deadlines };
  }

  if (hitl) {
    const { step: id, pass, kind, message, options, default: chosen, required } = hitl;

    const gate: AskedGate = { step: id, pass, kind, message, options, required };

    if (chosen !== undefined) gate.default = chosen;

    return { reply: { kind: 'hitl', gate }, cancelled, deadlines };
  }

  if (lease === undefined) {
    return { reply: { kind: 'wait', reason: wait?.reason ?? 'the next step is not available', delivering: wait?.delivering ?? [], held: wait?.held ?? [] }, cancelled, deadlines };
  }

  const read = readLease(lease);

  if (!read) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} leased a step this teamai cannot read. Update teamai.` } }, cancelled, deadlines };
  }

  return { reply: { kind: 'lease', lease: read, raw: lease }, cancelled, deadlines };
}

const AnsweredDataSchema = z.object({ answered: z.object({ step: z.string(), pass: z.number().int(), choice: z.string(), channel: z.string(), agent: z.boolean() }) });

export function respondReply(answer: WorkflowEnvelope): RespondReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = AnsweredDataSchema.safeParse(answer.data);

  return data.success
    ? { kind: 'answered', ...data.data.answered }
    : { kind: 'error', error: { code: 'run_unreadable', message: 'The engine answered respond with a reply this teamai cannot read. Update teamai.' } };
}

const ReportDataSchema = z.object({ step: z.object({ outcome: z.enum(['success', 'failed', 'released']), failure: FailureSchema.optional() }) });

export function reportReply(answer: WorkflowEnvelope): ReportReply {
  if ('error' in answer) return { kind: 'error', error: { code: answer.error.code, message: answer.error.message } };
  const data = ReportDataSchema.safeParse(answer.data);

  if (!data.success) return { kind: 'error', error: { code: 'run_unreadable', message: 'The engine answered a report with a reply this teamai cannot read. Update teamai.' } };
  const { outcome, failure } = data.data.step;

  const reply: ReportReply = { kind: 'reported', outcome };

  if (failure) reply.failure = failure;

  return reply;
}

const StartedDataSchema = z.object({ started: z.array(StartedRunSchema) });

/** The runs a `next` or report answer lists in `started`: those the run's settled passes started, which have not ended. */
export function startedOf(answer: WorkflowEnvelope): StartedRun[] {
  return 'data' in answer ? StartedDataSchema.safeParse(answer.data).data?.started ?? [] : [];
}

