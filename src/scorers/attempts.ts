/**
 * Judge attempts: `<dataHome>/scores/attempts/<entryId>/<attemptId>.json`, one file per lease, rewritten when it settles.
 * Attempts hold codes, numbers and the label chosen, never the judge's reasoning. One lock serializes every change to them.
 * The text of each rubric a lease was taken with is kept by its hash in `<dataHome>/scores/rubrics/`; the attempt says
 * which revision and file it was pinned from, since one text may be pinned from many.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { ACCESS_LEVELS, ISOLATIONS, JudgeUsageSchema, RunSubjectSchema, SessionLabelContextSchema, SessionSubjectSchema } from './label.js';
import { PinnedScorerSchema } from './pin.js';

const ENTRY_ID = /^s[0-9a-f]{13}$/;
const ATTEMPT_ID = /^a[0-9a-f]{8}$/;
const SOURCE_HASH = /^[0-9a-f]{64}$/;

const RubricSchema = PinnedScorerSchema.pick({ sourceHash: true, content: true });
type Rubric = z.infer<typeof RubricSchema>;

/** Why a judge attempt closed without a label. */
export const JUDGE_FAILURES = ['judge_failed', 'lease_expired', 'evidence_empty', 'judge_answer_invalid', 'judge_tool_unavailable'] as const;
export type JudgeFailureCode = (typeof JUDGE_FAILURES)[number];

export type JudgeDriver = z.infer<typeof DriverSchema>;

const JudgeChoiceSchema = z.object({
  tool: z.string().min(1),
  model: z.object({ name: z.string().min(1), effort: z.string().optional() }).optional(),
  by: z.enum(['scorer', 'tool_default']),
  noModel: z.enum(['local', 'switched']).optional(),
  /** The scorer's `model` when it is an alias, also when the tool default judges in its place. */
  alias: z.string().optional(),
  isolation: z.enum(ISOLATIONS),
  access: z.enum(ACCESS_LEVELS),
});

const AttemptBase = {
  attempt: z.string().regex(ATTEMPT_ID),
  entry: z.string().regex(ENTRY_ID),
  scorer: z.string().min(1),
  rubric: PinnedScorerSchema.omit({ content: true }),
  driver: DriverSchema,
  judge: JudgeChoiceSchema,
  leasedAt: z.string(),
  expiresAt: z.string(),
  /** What the lease's judge calls spent so far, on the first scorer of a batch only; a failed local call adds to it. */
  usage: JudgeUsageSchema.optional(),
  /** In a batch, the entries of every scorer the lease judges, in the step's order; each has an attempt of this id. */
  batch: z.array(z.string().regex(ENTRY_ID)).min(2).optional(),
};
const Settled = { settledAt: z.string() };
const Verdict = {
  labelId: z.string().min(1),
  verdict: z.object({ label: z.string().min(1), score: z.number(), passed: z.boolean(), version: z.string().min(1) }),
};

/** A workflow attempt names no source, as every attempt file written before session attempts did. */
const RunPart = { ...AttemptBase, source: z.literal('workflow').optional(), subject: RunSubjectSchema };

const RunAttemptSchema = z.discriminatedUnion('status', [
  z.object({ ...RunPart, status: z.literal('leased') }),
  z.object({ ...RunPart, ...Settled, status: z.literal('succeeded'), ...Verdict }),
  z.object({ ...RunPart, ...Settled, status: z.literal('failed'), code: z.enum(JUDGE_FAILURES) }),
  z.object({ ...RunPart, ...Settled, status: z.literal('released') }),
]);

/**
 * A session attempt keeps the context its label is built from, read when its lease was taken: the evidence directory
 * is removed on settle. Only a session that could not be read before the lease closes without one.
 */
const SessionPart = { ...AttemptBase, source: z.literal('session'), subject: SessionSubjectSchema, session: SessionLabelContextSchema };

const SessionAttemptSchema = z.union([
  /** `judgingSince`: a local judge started on it then, so no other local judge starts; a session is judged once. */
  z.object({ ...SessionPart, status: z.literal('leased'), judgingSince: z.string().optional() }),
  z.object({ ...SessionPart, ...Settled, status: z.literal('succeeded'), ...Verdict }),
  z.object({ ...SessionPart, ...Settled, status: z.literal('released') }),
  z.object({ ...SessionPart, ...Settled, status: z.literal('failed'), code: z.literal('evidence_empty'), session: SessionLabelContextSchema.optional() }),
  z.object({ ...SessionPart, ...Settled, status: z.literal('failed'), code: z.enum(JUDGE_FAILURES).exclude(['evidence_empty']) }),
]);

/** A file without `source` reads as a run attempt; `source: 'session'` fails each of those. */
export const AttemptRecordSchema = z.union([RunAttemptSchema, SessionAttemptSchema]);
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;
export type RunAttempt = z.infer<typeof RunAttemptSchema>;
export type SessionAttempt = z.infer<typeof SessionAttemptSchema>;
export type LeasedAttempt = Extract<AttemptRecord, { status: 'leased' }>;
export type LeasedRunAttempt = Extract<RunAttempt, { status: 'leased' }>;
export type LeasedSessionAttempt = Extract<SessionAttempt, { status: 'leased' }>;
export type SucceededAttempt = Extract<AttemptRecord, { status: 'succeeded' }>;

export function isRunAttempt(attempt: AttemptRecord): attempt is RunAttempt {
  return attempt.source !== 'session';
}

/**
 * `<entryId>/request.json`: a member asked for this (scorer, pass) to be judged, whatever sampling says. Attempts and
 * labels older than `requestedAt` no longer close the entry. `pin` is the rubric that judges it.
 */
export const ScoreRequestSchema = z.object({
  entry: z.string().regex(ENTRY_ID),
  scorer: z.string().min(1),
  subject: RunSubjectSchema,
  pin: PinnedScorerSchema,
  requestedAt: z.string(),
  /** `--batch`: whether this pass's scorers share one judge call, over what the step says. */
  batch: z.boolean().optional(),
});
export type ScoreRequest = z.infer<typeof ScoreRequestSchema>;

export function newAttemptId(): string {
  return `a${randomBytes(4).toString('hex')}`;
}

export function scoresDir(config: LocalConfig): string {
  return path.join(getDataHome(config), 'scores');
}

function attemptsDir(config: LocalConfig): string {
  return path.join(scoresDir(config), 'attempts');
}

function rubricPath(config: LocalConfig, sourceHash: string): string {
  return path.join(scoresDir(config), 'rubrics', `${sourceHash}.json`);
}

/** What a local judge printed when its answer did not settle the lease. */
export function rawOutputPath(config: LocalConfig, attempt: string): string {
  return path.join(scoresDir(config), 'raw', `${attempt}.txt`);
}

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

async function readRecord<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | undefined> {
  const raw = await readFileSafe(file);
  if (raw === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).sort();
}

export const AttemptStore = {
  /** Every readable attempt, by entry. A file this teamai cannot read is left out. */
  async read(config: LocalConfig): Promise<Map<string, AttemptRecord[]>> {
    const byEntry = new Map<string, AttemptRecord[]>();
    for (const entry of (await listDir(attemptsDir(config))).filter((name) => ENTRY_ID.test(name))) {
      byEntry.set(entry, await AttemptStore.ofEntry(config, entry));
    }
    return byEntry;
  },

  async ofEntry(config: LocalConfig, entry: string): Promise<AttemptRecord[]> {
    const dir = path.join(attemptsDir(config), entry);
    const files = (await listDir(dir)).filter((name) => ATTEMPT_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
    const records = await Promise.all(files.map((name) => readRecord(path.join(dir, name), AttemptRecordSchema)));
    return records.filter((record): record is AttemptRecord => record !== undefined && record.entry === entry);
  },

  async get(config: LocalConfig, entry: string, attempt: string): Promise<AttemptRecord | undefined> {
    if (!ENTRY_ID.test(entry) || !ATTEMPT_ID.test(attempt)) return undefined;
    const record = await readRecord(path.join(attemptsDir(config), entry, `${attempt}.json`), AttemptRecordSchema);
    return record?.entry === entry && record.attempt === attempt ? record : undefined;
  },

  async write(config: LocalConfig, record: AttemptRecord): Promise<void> {
    await writeJsonAtomic(path.join(attemptsDir(config), record.entry, `${record.attempt}.json`), record);
  },

  /** Every readable request. */
  async requests(config: LocalConfig): Promise<ScoreRequest[]> {
    const entries = (await listDir(attemptsDir(config))).filter((name) => ENTRY_ID.test(name));
    const requests = await Promise.all(entries.map((entry) => AttemptStore.request(config, entry)));
    return requests.filter((request): request is ScoreRequest => request !== undefined);
  },

  async request(config: LocalConfig, entry: string): Promise<ScoreRequest | undefined> {
    if (!ENTRY_ID.test(entry)) return undefined;
    const request = await readRecord(path.join(attemptsDir(config), entry, 'request.json'), ScoreRequestSchema);
    return request?.entry === entry ? request : undefined;
  },

  async writeRequest(config: LocalConfig, request: ScoreRequest): Promise<void> {
    await writeJsonAtomic(path.join(attemptsDir(config), request.entry, 'request.json'), request);
  },

  /** Keeps the text a lease judges with under `scores/rubrics/<sourceHash>.json`, so a later pin cannot take it away. */
  async keepRubric(config: LocalConfig, { sourceHash, content }: Rubric): Promise<void> {
    if (!SOURCE_HASH.test(sourceHash) || await readFileSafe(rubricPath(config, sourceHash)) !== null) return;
    await writeJsonAtomic(rubricPath(config, sourceHash), { sourceHash, content } satisfies Rubric);
  },

  async rubric(config: LocalConfig, sourceHash: string): Promise<Rubric | undefined> {
    if (!SOURCE_HASH.test(sourceHash)) return undefined;
    const rubric = await readRecord(rubricPath(config, sourceHash), RubricSchema);
    return rubric?.sourceHash === sourceHash ? rubric : undefined;
  },

  /** Removes the request of an entry that closed, unless a newer request reopened it since `requestedAt`. Call under `locked`. */
  async closeRequest(config: LocalConfig, entry: string, requestedAt: string): Promise<void> {
    if ((await AttemptStore.request(config, entry))?.requestedAt === requestedAt) await fs.rm(path.join(attemptsDir(config), entry, 'request.json'), { force: true });
  },

  /** Removes rubrics no attempt names and the raw output of attempts a newer attempt of their entry replaced. Call under `locked`. */
  async sweep(config: LocalConfig): Promise<void> {
    const attempts = [...(await AttemptStore.read(config)).values()];
    const named = new Set(attempts.flat().map((attempt) => attempt.rubric.sourceHash));
    const latest = new Set(attempts.flatMap((ofEntry) => ofEntry.reduce<AttemptRecord | undefined>((newest, attempt) => (newest && newest.leasedAt >= attempt.leasedAt ? newest : attempt), undefined)?.attempt ?? []));
    const remove = async (dir: string, pattern: RegExp, keep: ReadonlySet<string>) => {
      for (const name of await listDir(dir)) {
        const id = pattern.exec(name)?.[1];
        if (id !== undefined && !keep.has(id)) await fs.rm(path.join(dir, name), { force: true });
      }
    };
    await remove(path.join(scoresDir(config), 'rubrics'), /^([0-9a-f]{64})\.json$/, named);
    await remove(path.join(scoresDir(config), 'raw'), /^(a[0-9a-f]{8})\.txt$/, latest);
  },

  /** Removes every attempt of `entry`. Call under `locked`. */
  async removeEntry(config: LocalConfig, entry: string): Promise<void> {
    if (ENTRY_ID.test(entry)) await fs.rm(path.join(attemptsDir(config), entry), { recursive: true, force: true });
  },

  /** Runs `change` under `scores/attempts.lock`; `change` re-reads what it decides on. */
  async locked<T>(config: LocalConfig, change: () => Promise<T>): Promise<{ status: 'done'; value: T } | { status: 'busy' }> {
    const lock = path.join(scoresDir(config), 'attempts.lock');
    await fs.mkdir(scoresDir(config), { recursive: true });
    let held = false;
    for (let tries = 0; tries < LOCK_ATTEMPTS && !held; tries += 1) {
      held = await acquireLock(lock);
      if (!held) await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
    if (!held) return { status: 'busy' };
    try {
      return { status: 'done', value: await change() };
    } finally {
      await releaseLock(lock);
    }
  },
} as const;
