import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import { LeaseSetupSchema } from '../requirements.js';
import { ChangesSchema, FailureSchema, ReadSchema } from '../step-state.js';
import { AttemptIdSchema, placeRecordPath, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { WorkspaceContractSchema } from '../workspace.js';

/**
 * How the attempt uses its place. The snapshot a reader is checked against is `before.json` beside the record, and the
 * branch's agent files kept while the base overlay is in place are in `overlay/`.
 */
const PlaceRoleSchema = z.discriminatedUnion('role', [
  /** A lease without a workspace contract, in the checkout itself: what it changes there fails it, unless it is interactive and may write. */
  z.object({ role: z.literal('checkout') }),
  /** A read-only lease in a copy of `workspace.branch`, which held `found` untracked when it was marked as read. */
  z.object({ role: z.literal('reader'), workspace: WorkspaceContractSchema, found: z.array(z.string()) }),
  /**
   * A lease that commits to `workspace.branch`, reporting the range from `rangeFrom`. `conflicts` hashes each file
   * that was unmerged when the step got it, and `conflictNote` is what its prompt adds about them.
   */
  z.object({
    role: z.literal('writer'),
    workspace: WorkspaceContractSchema,
    rangeFrom: z.string().optional(),
    conflicts: z.record(z.string()),
    conflictNote: z.string().optional(),
  }),
]);

/** What finishing a place made of the step's end, masked: the report the attempt settles with. */
export const PlaceFinishedSchema = z.object({
  outcome: z.enum(['success', 'failed']),
  message: z.string().optional(),
  failure: FailureSchema.optional(),
  changes: ChangesSchema.optional(),
  read: ReadSchema.optional(),
});

const PlaceBase = {
  version: z.literal(1),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  step: z.string(),
  executor: z.enum(['command', 'prompt']),
  /** The checkout the place belongs to: a copy is one of its worktrees. */
  root: z.string(),
  dir: z.string(),
  interactive: z.literal(true).optional(),
  readOnly: z.literal(true).optional(),
  place: PlaceRoleSchema,
};

export const PlaceRecordSchema = z.discriminatedUnion('phase', [
  /** Git and the overlay are done in a worktree prepare created, and `setup` runs there before the step. */
  z.object({ ...PlaceBase, phase: z.literal('staged'), setup: LeaseSetupSchema, expiresAt: z.string().optional() }),
  z.object({ ...PlaceBase, phase: z.literal('ready') }),
  z.object({ ...PlaceBase, phase: z.literal('finished'), at: z.string(), finished: PlaceFinishedSchema }),
  /** The step ended without a report to finish it: the copy is as it was found, and nothing was committed. */
  z.object({ ...PlaceBase, phase: z.literal('abandoned'), at: z.string() }),
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
