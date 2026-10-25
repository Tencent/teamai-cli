import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import { AttemptIdSchema, placeRecordPath, RunIdSchema, type AttemptId, type RunId } from '../store.js';

const PlaceBase = {
  version: z.literal(1),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  /** A lease without a workspace contract runs in the member's checkout, `dir`. */
  source: z.literal('checkout'),
  dir: z.string(),
  /** A step in the checkout reads it: what it changes there fails the step, unless it is interactive and may write. */
  place: z.object({
    role: z.literal('reader'),
    executor: z.enum(['command', 'prompt']),
    snapshot: z.literal('before.json'),
    interactive: z.literal(true).optional(),
    readOnly: z.literal(true).optional(),
  }),
};

export const PlaceRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...PlaceBase, phase: z.literal('ready') }),
  z.object({
    ...PlaceBase,
    phase: z.literal('finished'),
    finished: z.object({
      outcome: z.enum(['success', 'failed', 'released']),
      at: z.string(),
      failure: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  }),
]);
export type PlaceRecord = z.infer<typeof PlaceRecordSchema>;

/** The place an attempt was prepared in, from `attempts/<a>/place.json`. */
export async function readPlaceRecord(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<PlaceRecord | { kind: 'missing' } | { kind: 'unreadable'; reason: string }> {
  const raw = await readFileSafe(placeRecordPath(config, run, attempt));
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed = PlaceRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { kind: 'unreadable', reason: parsed.error.issues[0]?.message ?? 'invalid' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function writePlaceRecord(config: LocalConfig, record: PlaceRecord): Promise<void> {
  await writeJsonAtomic(placeRecordPath(config, record.run, record.attempt), record);
}
