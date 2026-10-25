import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import { LeaseSetupSchema } from '../requirements.js';
import { ChangesSchema, FailureSchema, ReadSchema } from '../step-state.js';
import { AttemptIdSchema, placeRecordPath, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { WorkspaceContractSchema } from '../workspace.js';

/** A lease without a workspace contract, in the checkout itself: what it changes there fails it, unless it is interactive and may write. */
const CheckoutRoleSchema = z.object({ role: z.literal('checkout') });
/** A read-only lease in a copy of `workspace.branch`, which held `found` untracked when it was marked as read. */
const ReaderRoleSchema = z.object({ role: z.literal('reader'), workspace: WorkspaceContractSchema, found: z.array(z.string()) });
/**
 * A lease that commits to `workspace.branch`, reporting the range from `rangeFrom`. `conflicts` hashes each file
 * that was unmerged when the step got it, and `conflictNote` is what its prompt adds about them.
 */
const WriterRoleSchema = z.object({
  role: z.literal('writer'),
  workspace: WorkspaceContractSchema,
  rangeFrom: z.string().optional(),
  conflicts: z.record(z.string()),
  conflictNote: z.string().optional(),
});

/**
 * How the attempt uses its place. The snapshot a reader is checked against is `before.json` beside the record, and the
 * branch's agent files kept while the base overlay is in place are in `overlay/`.
 */
const PlaceRoleSchema = z.discriminatedUnion('role', [CheckoutRoleSchema, ReaderRoleSchema, WriterRoleSchema]);

/** What finishing a place made of the step's end, masked: the report the attempt settles with. */
export const PlaceFinishedSchema = z.object({
  outcome: z.enum(['success', 'failed']),
  message: z.string().optional(),
  failure: FailureSchema.optional(),
  changes: ChangesSchema.optional(),
  read: ReadSchema.optional(),
});

const PlaceFields = {
  version: z.literal(1),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  step: z.string(),
  executor: z.enum(['command', 'prompt']),
  /** The checkout the place belongs to: a copy is one of its worktrees. */
  root: z.string(),
  dir: z.string(),
  /** The host made the place at `dir`, whatever the lease does there, so TeamAI never removes it. */
  adopted: z.literal(true).optional(),
  interactive: z.literal(true).optional(),
  readOnly: z.literal(true).optional(),
};
const PlaceBase = { ...PlaceFields, place: PlaceRoleSchema };

const PlaceRecordSchema = z.discriminatedUnion('phase', [
  /**
   * Git is not done in the copy at `dir`. Recorded before git touches it, so the next prepare of an attempt killed
   * meanwhile knows what this one did there: `created` when the copy is new to TeamAI, so its setup still runs: one
   * that did not exist, or one the host made that no earlier attempt of the run finished in; and a writer's
   * `rangeFrom` once the copy is open, taken before any merge, so the merges stay in the step's changes.
   */
  z.object({ ...PlaceFields, phase: z.literal('opening'), created: z.literal(true).optional(), rangeFrom: z.string().optional() }),
  /**
   * Git is done in a copy, and the base overlay goes in next. Recorded before the overlay, so a prepare cut short is
   * finished by the next one, or given up. `setup` is what runs once it is staged, in a worktree prepare created.
   */
  z.object({
    ...PlaceBase, phase: z.literal('preparing'), place: z.discriminatedUnion('role', [ReaderRoleSchema, WriterRoleSchema]),
    setup: LeaseSetupSchema.optional(), expiresAt: z.string().optional(),
  }),
  /** Git and the overlay are done in a worktree prepare created, and `setup` runs there before the step. */
  z.object({ ...PlaceBase, phase: z.literal('staged'), setup: LeaseSetupSchema, expiresAt: z.string().optional() }),
  /**
   * Setup started in the place. Recorded before it starts, so a prepare that finds this phase gives the place up: what
   * a setup cut short left there would pass the next setup's checks as the place's own files.
   */
  z.object({ ...PlaceBase, phase: z.literal('setting-up') }),
  z.object({ ...PlaceBase, phase: z.literal('ready') }),
  z.object({ ...PlaceBase, phase: z.literal('finished'), at: z.string(), finished: PlaceFinishedSchema }),
  /** The step ended without a report to finish it: the copy is as it was found, and nothing was committed. */
  z.object({ ...PlaceBase, phase: z.literal('abandoned'), at: z.string() }),
]);
export type PlaceRecord = z.infer<typeof PlaceRecordSchema>;

/** The place an attempt was prepared in, from `attempts/<a>/place.json`. */
export async function readPlaceRecord(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<{ kind: 'found'; record: PlaceRecord } | { kind: 'missing' } | { kind: 'unreadable'; reason: string }> {
  const raw = await readFileSafe(placeRecordPath(config, run, attempt));
  if (raw === null) return { kind: 'missing' };
  try {
    const parsed = PlaceRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { kind: 'found', record: parsed.data } : { kind: 'unreadable', reason: parsed.error.issues[0]?.message ?? 'invalid' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function writePlaceRecord(config: LocalConfig, record: PlaceRecord): Promise<void> {
  await writeJsonAtomic(placeRecordPath(config, record.run, record.attempt), record);
}
