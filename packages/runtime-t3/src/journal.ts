import fs from 'node:fs';
import path from 'node:path';
import { OpStateSchema, RuntimeHandleSchema, type OpState, type RuntimeFailure } from '@teamai/runtime-protocol';
import { recordStore, type RecordRead } from '@teamai/runtime-kit/journal';
import { z } from 'zod';
import { STEP_MODES } from './t3.js';

// ─── What the runtime keeps of each opened place, across its own restarts ───
//
//  One record per handle under the runtime's state directory, and one per operation apart from it, keyed by the
//  operation, each written whole through a rename, so a runtime killed mid-write leaves the previous record. teamai
//  reattaches a handle after it restarts; the records say which T3 thread each prompt launched, so the runtime
//  reconnects to it instead of launching another. An operation's record names its place, which is how a cancel that
//  names only the op finds it, and outlives the place when a later step continues its conversation:
//
//    places/<handle>.json        the place
//    places/<handle>/<op>.json   that the place holds the op (the place's index of its operations)
//    ops/<op>.json               the op: its place, its state, and the thread it launched
//

/** The model a launch names: none, T3 picks the member's default model, as it does for a thread the member starts. */
const ModelSelectionSchema = z.object({ instanceId: z.string(), model: z.string(), options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional() });

/** The T3 thread a prompt launched: what reconnecting to it, showing it and settling it need. */
const ThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string(),
  model: z.string(),
  tool: z.string(),
  /** The provider instance it runs on, whose tool home holds its session. Absent from a record before it was kept. */
  instanceId: z.string().optional(),
  launchedAt: z.number(),
  /** A judge's: the read-only copy of its directory, in the thread's own scratch folder, which close removes. */
  copy: z.string().optional(),
  /**
   * A step's: what a later prompt that continues the thread's conversation shares with it, the folder its tool works in
   * and the model selection its launch named. Absent from a record before it was kept: such a thread is not continued.
   */
  conversation: z.object({
    cwd: z.string(), modelSelection: ModelSelectionSchema.optional(),
    /** The model T3 launched the thread on, as it said back, which a later step that names no model sets it back to. */
    launchedOn: ModelSelectionSchema.optional(),
  }).optional(),
  /**
   * This op's turn of the conversation an earlier prompt launched the thread for: that prompt's place and op, how many
   * runs the thread had before the turn was sent, so a run that ended before it is not taken for the turn's, and the
   * model selection set on the thread before the send when the turn asks for another model of its provider instance,
   * and when the turn was journaled, just before its send, from which on the session's requests are the turn's. Absent
   * from a record kept before it was: such a turn reports no tokens. The thread stays the earlier place's to settle while
   * that place is open.
   */
  turnOf: z.object({ handle: RuntimeHandleSchema, op: z.string(), runsBefore: z.number().int().nonnegative(), sentAt: z.number().optional(), configure: ModelSelectionSchema.optional() }).optional(),
  /**
   * The runtime saw the thread's run, and the work it delegated, settle, or a stop it asked for take effect. Until then
   * the thread is the runtime's to stop, whatever ended its op and whichever runtime process launched it: close stops it
   * first, and keeps the place, and a judge's copy, while T3 will not; nothing settles it before then.
   */
  ended: z.object({
    /**
     * How asking T3 to settle the thread went, once the runtime asked; it asks once. `skipped`: it never asks, since T3
     * would run the project's settle script in the step's folder.
     */
    settlement: z.enum(['settled', 'failed', 'skipped']).optional(),
  }).optional(),
});

export type ThreadRecord = z.infer<typeof ThreadSchema>;

/**
 * A launch T3 has not answered yet, journaled before it is sent: the thread it may have launched is found again by
 * repeating it, since T3 answers a repeated clientRequestId (the op) with the thread it launched for it.
 */
const LaunchSchema = z.object({
  title: z.string(),
  modelSelection: ModelSelectionSchema.optional(),
  runtimeMode: z.enum(STEP_MODES),
  tool: z.string(),
  launchedAt: z.number(),
  /** A step's on an existing worktree: the worktree its thread runs on. A judge's thread runs in a scratch folder of T3's own. */
  worktreePath: z.string().optional(),
  /** Which T3 Code sign-in sent it: T3 answers a repeat with the thread it launched only under that same sign-in. */
  signIn: z.string(),
});

export type LaunchRecord = z.infer<typeof LaunchSchema>;

const placeFields = {
  handle: RuntimeHandleSchema,
  run: z.string(),
  attempt: z.string(),
};

/**
 * An attempt's folder in a T3 project, or a confined prompt's place, which has no view of the host. Its threads bind
 * the folder as a worktree of the project, or as the project's own folder (`root`): a checkout, a clone, or a worktree
 * T3 would otherwise run the project's setup script in. `settleScript`: the script T3 runs when one of them is settled.
 * Strict, so a record that still holds its operations, as a place's record once did, is unreadable, not read without them.
 */
const PlaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('worktree'), ...placeFields, projectId: z.string(), projectTitle: z.string(),
    binding: z.enum(['existing_worktree', 'root']).default('existing_worktree'), settleScript: z.string().optional(),
    /** The project whose T3 settings the step's threads follow: the checkout's, when the threads run on one teamai added. */
    settingsProjectId: z.string().optional(),
    /**
     * Through a sandbox: the sandbox's handle, whose attempt socket the step's tool is registered on, and the attempt's
     * tool home by the variable its tool reads, where the tool the sandbox starts keeps its session.
     */
    through: z.strictObject({ outer: z.string(), toolHome: z.record(z.string(), z.string()) }).optional(),
  }),
  z.strictObject({ kind: z.literal('confined'), ...placeFields }),
]);

/**
 * One operation, in a record of its own: how it stands, as `reattach` reports it, the thread it launched, and its
 * launch while T3 has not answered it. Two runtime processes that write different operations never lose each other's
 * write, and an update holds its operation, so two that write the same one never lose one either.
 */
const OpRecordSchema = z.object({ state: OpStateSchema, thread: ThreadSchema.optional(), launch: LaunchSchema.optional() });

export type OpRecord = z.infer<typeof OpRecordSchema>;

/** An operation's record as kept, keyed by the op apart from its place: the place it ran in, which may be gone. */
const KeptOpSchema = OpRecordSchema.extend({ handle: RuntimeHandleSchema });

export type KeptOp = z.infer<typeof KeptOpSchema>;

/** An operation's record as an update reads it: the record without its place. */
function withoutPlace({ handle: _handle, ...record }: KeptOp): OpRecord {
  return record;
}

/** A place's own record, which `open` writes. */
type Place = z.infer<typeof PlaceSchema>;

/** A place with its operations: each one's state, the thread of each prompt that launched one, and each unanswered launch. */
export type PlaceRecord = Place & {
  ops: Record<string, OpState>;
  threads: Record<string, ThreadRecord>;
  launches: Record<string, LaunchRecord>;
};

/**
 * A place's record: none once it was removed, or one that is there but cannot be read, which is not the same. An
 * unreadable one names its place when the journal knows it.
 */
export type PlaceRead = { kind: 'found'; place: PlaceRecord } | { kind: 'missing' } | { kind: 'unreadable'; file: string; why: string; handle?: string };

/** The keys of `store`, kept in `dir`, or why that folder cannot be listed. */
function keysIn(store: { keys(): string[] }, dir: string): { kind: 'listed'; keys: string[] } | { kind: 'unreadable'; file: string; why: string } {
  try {
    return { kind: 'listed', keys: store.keys() };
  } catch (error) {
    return { kind: 'unreadable', file: dir, why: error instanceof Error ? error.message : String(error) };
  }
}

export interface Journal {
  read(handle: string): PlaceRead;
  /** The place's record, to write to: none when it is missing or cannot be read, which is never written over. */
  writable(handle: string): PlaceRecord | undefined;
  /**
   * The place of `op`, from that op's record alone: a restarted runtime is asked to cancel an op before it reattaches.
   * An op record, or its place's, that cannot be read may hold the op's thread, so the answer is unreadable then.
   */
  placeOf(op: string): PlaceRead;
  /**
   * `op`'s record as kept, by the op alone: the conversation a prompt launched, which a later prompt that continues it
   * names by that op.
   */
  conversation(op: string): RecordRead<KeptOp>;
  /** Writes the place's own record; its operations' records are written by `update`. */
  open(place: PlaceRecord): void;
  /**
   * Writes `op`'s record in the place `handle` as `change` makes it from the one there, holding the op across runtime
   * processes meanwhile; `undefined` writes nothing. A record there that cannot be read is never written over: that
   * rejects.
   */
  update(at: { handle: string; op: string }, change: (record: OpRecord | undefined) => OpRecord | undefined): Promise<void>;
  /** Forgets the place and its operations. */
  remove(handle: string): void;
  /** The file that holds the place's record, which the person deletes once they stopped what it may still run. */
  file(handle: string): string;
  /** The file that holds `op`'s record. */
  opFile(op: string): string;
}

/** The places and operations under `dir`, the runtime's state directory, laid out as the header says. */
export function journal(dir: string): Journal {
  const placesDir = path.join(dir, 'places');
  const places = recordStore(placesDir, PlaceSchema);
  const ops = recordStore(path.join(dir, 'ops'), KeptOpSchema);
  const indexDir = (handle: string): string => path.join(placesDir, encodeURIComponent(handle));
  const indexOf = (handle: string) => recordStore(indexDir(handle), z.strictObject({}));

  const read = (handle: string): PlaceRead => {
    const own = places.read(handle);

    if (own.kind === 'unreadable') return { ...own, handle };

    if (own.kind === 'missing') return own;
    const place: PlaceRecord = { ...own.record, ops: {}, threads: {}, launches: {} };
    const listed = keysIn(indexOf(handle), indexDir(handle));

    if (listed.kind === 'unreadable') return { ...listed, handle };

    for (const op of listed.keys) {
      const found = ops.read(op);

      if (found.kind === 'unreadable') return { ...found, handle };

      // Indexed before its record was written, by a runtime that stopped there; or a conversation that moved on.
      if (found.kind === 'missing' || found.record.handle !== handle) continue;
      const { state, thread, launch } = found.record;
      place.ops[op] = state;

      if (thread) place.threads[op] = thread;

      if (launch) place.launches[op] = launch;
    }

    return { kind: 'found', place };
  };

  return {
    read,
    writable(handle) {
      const found = read(handle);

      return found.kind === 'found' ? found.place : undefined;
    },
    placeOf(op) {
      const found = ops.read(op);

      return found.kind === 'found' ? read(found.record.handle) : found;
    },
    conversation: (op) => ops.read(op),
    open: ({ ops: _ops, threads: _threads, launches: _launches, ...place }) => places.write(place.handle, place),
    async update({ handle, op }, change) {
      // Indexed first, so a place never holds a record its index misses.
      indexOf(handle).write(op, {});
      await ops.update(op, (kept) => {
        const next = change(kept === undefined ? undefined : withoutPlace(kept));

        return next && { ...next, handle };
      });
    },
    // The operations first: a place whose removal stopped halfway is still there, and a later close removes the rest.
    remove(handle) {
      const listed = keysIn(indexOf(handle), indexDir(handle));

      for (const op of listed.kind === 'listed' ? listed.keys : []) ops.remove(op);

      fs.rmSync(indexDir(handle), { recursive: true, force: true });
      places.remove(handle);
    },
    file: places.file,
    opFile: ops.file,
  };
}

/** What a request that needs a place answers when its record is there but cannot be read: it may hold live threads. */
export function unreadableFailure(handle: string, read: Extract<PlaceRead, { kind: 'unreadable' }>): RuntimeFailure {
  return {
    code: 'journal_unreadable',
    message: `Runtime t3 cannot read its record of ${handle}, ${read.file} (${read.why.replace(/\.$/, '')}), so it cannot tell which T3 threads it launched there, and it keeps the place. Stop that run's threads in T3 Code (their titles end with "teamai" and the run id), then delete the file and cancel the run again.`,
  };
}
