import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import { readFileSafe, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { PinnedScorerSchema } from '../scorers/pin.js';
import { acquireLock, releaseLock } from '../update.js';
import { ArchivedPassSchema, SessionContinuationSchema, StepStateSchema } from './step-state.js';
import type { HandoffOwner } from './snapshot.js';
import type { RunState, WorkflowDefinition } from './types.js';

/**
 * Run ids: `r` + 16 hex digits. Records are a team-wide key on the reports
 * branch (#1083), and 8 hex digits reach ~1% collision odds by 10,000 runs —
 * a collision would overwrite another member's record, so new runs get 16.
 * The legacy 8-hex form still resolves for runs created before the switch.
 */
const RUN_ID = /^r[0-9a-f]{8}(?:[0-9a-f]{8})?$/;

export function isRunId(runId: string): boolean {
  return RUN_ID.test(runId);
}

/** A fresh run id: 16 hex digits (see RUN_ID for why not 8). */
export function generateRunId(): string {
  return `r${randomBytes(8).toString('hex')}`;
}

/** The directory that holds this scope's run files, `<run id>.json` each. */
export function runsDir(config: LocalConfig): string {
  return path.join(getDataHome(config), 'workflows', 'runs');
}

export function runFilePath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.json`);
}

export function runLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.lock`);
}

export function driverLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), runId, 'driver.lock');
}

function isDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const definition = value as WorkflowDefinition;
  return definition.schemaVersion === 'v1alpha1'
    && typeof definition.name === 'string'
    && typeof definition.description === 'string'
    && Array.isArray(definition.steps);
}

export function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== 'object') return false;
  const run = value as RunState;
  return run.schemaVersion === 'v1alpha1'
    && isRunId(run.id)
    && typeof run.name === 'string'
    && typeof run.revision === 'number'
    && (run.status === 'running' || run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')
    && isDefinition(run.definition)
    && Array.isArray(run.steps)
    && Array.isArray(run.settledAttempts);
}

/** The parts of a run file the step union governs, with what a file written before them reads as. */
const RunProgressSchema = z.object({
  steps: z.array(StepStateSchema),
  cancelledAttempts: z.array(z.string()).default([]),
  archive: z.array(ArchivedPassSchema).default([]),
  round: z.number().int().optional(),
  /** Latest driver that called next, absent in older run files. */
  driver: DriverSchema.optional(),
  publication: z.object({ stateRevision: z.number().int(), pending: z.string().optional(), reconcileCopies: z.literal(true).optional() }).optional(),
  sessionContinuations: z.array(SessionContinuationSchema).optional(),
  scorers: z.record(PinnedScorerSchema).optional(),
});

export async function readRun(config: LocalConfig, runId: string): Promise<RunState | 'missing' | 'corrupt'> {
  const raw = await readFileSafe(runFilePath(config, runId));
  if (raw === null) return 'missing';
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRunState(value)) return 'corrupt';
    const progress = RunProgressSchema.safeParse(value);
    return progress.success ? { ...value, ...progress.data } : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a locked run update found: the value its change returned, or why the change did not run. */
export type RunUpdate<T> = { status: 'done'; value: T } | { status: 'busy' } | { status: 'corrupt' };

/**
 * Reads run `runId` under its lock, `missing` when it has no file, and writes the run `change` returns, if any.
 * The only writer of run files, so no write lands between another process's read and its write.
 */
export async function updateRun<T>(
  config: LocalConfig,
  runId: string,
  change: (run: RunState | 'missing') => Promise<{ value: T; write?: RunState }>,
): Promise<RunUpdate<T>> {
  const lock = runLockPath(config, runId);
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    held = await acquireLock(lock);
    if (!held) await delay(LOCK_WAIT_MS);
  }
  if (!held) return { status: 'busy' };
  try {
    const loaded = await readRun(config, runId);
    if (loaded === 'corrupt') return { status: 'corrupt' };
    const { value, write } = await change(loaded);
    if (write) await writeJsonAtomic(runFilePath(config, runId), write);
    return { status: 'done', value };
  } finally {
    await releaseLock(lock);
  }
}

/** The install this data home belongs to. Its id is created once, by whichever process gets there first. */
export async function installOwner(config: LocalConfig): Promise<HandoffOwner> {
  const file = path.join(getDataHome(config), 'workflows', 'owner.json');
  let id = ownerId(await readFileSafe(file));
  if (id === undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const draft = `${file}.${randomUUID()}.tmp`;
    await writeFileAtomic(draft, `${JSON.stringify({ id: randomUUID() })}\n`);
    try {
      // A hard link never replaces an existing file, so two first runs agree on one id.
      await fs.link(draft, file);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
    } finally {
      await fs.rm(draft, { force: true });
    }
    id = ownerId(await readFileSafe(file));
  }
  if (id === undefined) throw new Error(`${file} does not hold an install id. Move it aside and try again.`);
  return { id, user: config.username };
}

function ownerId(text: string | null): string | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && value.id !== '' ? value.id : undefined;
  } catch {
    return undefined;
  }
}
