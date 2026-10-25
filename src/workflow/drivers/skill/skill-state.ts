/** `runs/<run>/skill.json`: what the skill driver keeps of a run between calls. This module is its only reader and writer. */
import { z } from 'zod';
import { DriverSchema } from '../../../driver-identity.js';
import type { LocalConfig } from '../../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../../utils/fs.js';
import { redactJson } from '../../../utils/redact.js';
import { AttemptIdSchema, RunIdSchema, skillStatePath, type RunId, type RunLock } from '../../store.js';
import { INVOCATIONS } from './literals.js';

const FailureSchema = z.object({ code: z.string(), message: z.string() });

/** A report as the runner sends it, kept before it is sent so a crash between the two loses nothing. */
export const ReportBodySchema = z.object({
  attempt: AttemptIdSchema,
  revision: z.number().int(),
  outcome: z.enum(['success', 'failed']),
  driver: DriverSchema,
  exitCode: z.number().int().optional(),
  outputs: z.unknown().optional(),
  message: z.string().optional(),
  failure: FailureSchema.optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

const AttemptBase = { attempt: AttemptIdSchema, step: z.string(), revision: z.number().int(), spawnedAt: z.string() };
/** An open attempt: its runner prepares its place, runs its command, or has a report to send. */
export const AttemptStateSchema = z.discriminatedUnion('phase', [
  z.object({ ...AttemptBase, phase: z.literal('preparing') }),
  z.object({ ...AttemptBase, phase: z.literal('running') }),
  z.object({ ...AttemptBase, phase: z.literal('reporting'), body: ReportBodySchema, tail: z.string().optional() }),
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export const TurnEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), step: z.string(), attempt: AttemptIdSchema }),
  z.object({ kind: z.literal('restarted'), step: z.string(), attempt: AttemptIdSchema }),
  /** The engine cancelled the attempt's lease, so its report was not recorded. */
  z.object({ kind: z.literal('stopped'), step: z.string(), attempt: AttemptIdSchema }),
  z.object({
    kind: z.literal('settled'),
    step: z.string(),
    outcome: z.enum(['success', 'failed', 'released']),
    exitCode: z.number().int().optional(),
    failure: FailureSchema.optional(),
    /** The end of the step's masked output. */
    tail: z.string().optional(),
  }),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

export const SkillStateSchema = z.object({
  version: z.literal(1),
  run: RunIdSchema,
  /** The identity every `next` and report sends: kind `skill`, this machine, the checkout the run started from. */
  driver: DriverSchema,
  invocation: z.enum(INVOCATIONS),
  options: z.object({ parallel: z.number().int().min(1) }),
  /** The session that drives the run, when its host names one, and when it last called. */
  orchestrator: z.object({ session: z.string().optional(), lastCallAt: z.string() }),
  attempts: z.array(AttemptStateSchema),
  /** The sequence number of the last event. */
  seq: z.number().int(),
  events: z.array(z.object({ seq: z.number().int(), event: TurnEventSchema })),
  /** The last event each session was shown, by session. */
  seen: z.record(z.string(), z.number().int()),
  settled: z.array(AttemptIdSchema),
  done: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), failure: FailureSchema.optional() }).optional(),
});
export type SkillState = z.infer<typeof SkillStateSchema>;

export async function readSkillState(config: LocalConfig, run: RunId): Promise<SkillState | { kind: 'missing' } | { kind: 'unreadable'; reason: string }> {
  const raw = await readFileSafe(skillStatePath(config, run));
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed = SkillStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { kind: 'unreadable', reason: parsed.error.issues[0]?.message ?? 'invalid' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Saves `state`, masked with `secrets`. Only a holder of the run lock writes it. */
export async function writeSkillState(config: LocalConfig, lock: RunLock, state: SkillState, secrets: Record<string, string>): Promise<void> {
  await writeJsonAtomic(skillStatePath(config, lock.run), redactJson(state, secrets));
}
