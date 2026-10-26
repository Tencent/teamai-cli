/**
 * The engine's envelopes as the skill driver reads them: each answer to `next`, `respond`, a report and `score --next`,
 * parsed once into the reply its row takes, and a lease, read as the step this driver runs.
 */
import { z } from 'zod';
import { LeaseWireSchema } from '../../lease-wire.js';
import { FailureSchema } from '../../step-state.js';
import { AttemptIdSchema, type AttemptId, type RunId } from '../../store.js';
import type { WorkflowEnvelope } from '../../types.js';
import type { EngineReply, ReadLease, ReportReply, RespondReply, ScoreReply } from './transitions.js';

/** The lease `raw` the engine sent, as this driver runs it. Undefined when this teamai cannot run it. */
export function readLease(raw: unknown): ReadLease | undefined {
  const read = LeaseWireSchema.safeParse(raw);
  if (!read.success) return undefined;
  const { attempt, step: id, revision, expiresAt, command, env, envScope, prompt, workspace, agent, model, defaultModel, output, interactive, readOnly, requires } = read.data;
  const base = { attempt, step: id, revision, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  if (command !== undefined) return { ...base, executor: 'command', command, env: env ?? {}, ...(envScope ? { envScope } : {}) };
  // The schema reads a lease with a command or a prompt, so one without a command has its prompt.
  if (prompt === undefined) return undefined;
  return {
    ...base, executor: 'prompt', prompt, place: workspace === undefined ? 'checkout' : 'workspace', writes: workspace?.mode === 'new' || workspace?.mode === 'continue',
    ...(interactive ? { interactive } : {}), ...(readOnly ? { readOnly } : {}), ...(requires?.isolation === 'sandbox' ? { isolation: requires.isolation } : {}),
    ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

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
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional(), prs: z.array(z.string()).optional(), notPublished: z.object({ code: z.string() }).optional() }).optional(),
});

/** The engine's answer to `next`, and the attempts it no longer leases to this driver. */
export function engineReply(run: RunId, answer: WorkflowEnvelope): { reply: EngineReply; cancelled: AttemptId[] } {
  if ('error' in answer) return { reply: { kind: 'error', error: { code: answer.error.code, message: answer.error.message } }, cancelled: [] };
  const data = NextDataSchema.safeParse(answer.data);
  if (!data.success) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} answered next with a reply this teamai cannot read: ${data.error.issues[0]?.message ?? 'invalid'}. Update teamai.` } }, cancelled: [] };
  }
  const { done, lease, hitl, wait, cancelled = [] } = data.data;
  if (done) return { reply: { kind: 'done', outcome: done.outcome, ...(done.failure ? { failure: done.failure } : {}), prs: done.prs ?? [], out: done.notPublished === undefined || done.notPublished.code === 'not_owner' }, cancelled };
  if (hitl) {
    const { step: id, pass, kind, message, options, default: chosen, required } = hitl;
    return { reply: { kind: 'hitl', gate: { step: id, pass, kind, message, options, ...(chosen !== undefined ? { default: chosen } : {}), required } }, cancelled };
  }
  if (lease === undefined) {
    return { reply: { kind: 'wait', reason: wait?.reason ?? 'the next step is not available', delivering: wait?.delivering ?? [], held: wait?.held ?? [] }, cancelled };
  }
  const read = readLease(lease);
  if (!read) {
    return { reply: { kind: 'error', error: { code: 'run_unreadable', message: `Run ${run} leased a step this teamai cannot read. Update teamai.` } }, cancelled };
  }
  return { reply: { kind: 'lease', lease: read, raw: lease }, cancelled };
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
  return { kind: 'reported', outcome, ...(failure ? { failure } : {}) };
}

const ScoreDataSchema = z.object({
  lease: z.object({ ref: z.string(), subject: z.object({ step: z.string() }), scorer: z.string().optional(), scorers: z.array(z.string()).optional() }).optional(),
});

/** What `score --next` answered, with the lease read as the judge it opens. */
export function scoreReply(answer: WorkflowEnvelope): ScoreReply {
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
