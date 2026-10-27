import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import { readFileSafe, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { redactJson } from '../utils/redact.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { PinnedScorerSchema } from '../scorers/pin.js';
import { acquireLock, releaseLock } from '../update.js';
import { ArchivedPassSchema, ReleasedTokensSchema, SessionContinuationSchema, StepStateSchema, StoppedAttemptSchema } from './step-state.js';
import type { HandoffOwner } from './snapshot.js';
import { uniqueOutcomes, WorkOutcomeSchema, type WorkOutcome } from '../outcomes.js';
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

export const RunIdSchema = z.string().regex(RUN_ID, 'Run id must look like r followed by 8 or 16 hex digits').brand<'RunId'>();
export type RunId = z.infer<typeof RunIdSchema>;
/** The attempt id the engine gives a lease: `a` + 8 hex digits. */
export const AttemptIdSchema = z.string().regex(/^a[0-9a-f]{8}$/, 'Attempt id must look like a followed by 8 hex digits').brand<'AttemptId'>();
export type AttemptId = z.infer<typeof AttemptIdSchema>;

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

/** Held while this machine delivers a run's pull requests: never the run lock, which no network call may hold. */
export function deliveryLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.delivery.lock`);
}

export function driverLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), runId, 'driver.lock');
}

/** `runs/<run>/attempts/`: a directory for each attempt of the run. */
export function attemptsDir(config: LocalConfig, run: RunId): string {
  return path.join(runsDir(config), run, 'attempts');
}

/** `runs/<run>/attempts/<attempt>/`: what a driver keeps for one attempt. */
export function attemptDir(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptsDir(config, run), attempt);
}

/** `runs/<run>/skill.json`: the skill driver's state of a run. */
export function skillStatePath(config: LocalConfig, run: RunId): string {
  return path.join(runsDir(config), run, 'skill.json');
}

/** `attempts/<attempt>/place.json`: where an attempt runs, from its prepare to its finish. */
export function placeRecordPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'place.json');
}

/** `attempts/<a>/result.json`: what a prompt step's tool or child agent, or a command step's driver, wrote the step produced. */
export function attemptResultPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'result.json');
}

/**
 * `runs/<run>/outcomes/<attempt>.jsonl`: one outcome per line, appended by the attempt's own commands, such as
 * `contribute`. Not the result file, which a prompt step's tool writes whole at its end.
 */
export function attemptOutcomesPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(runsDir(config), run, 'outcomes', `${attempt}.jsonl`);
}

/**
 * Append `outcome` to the outcome file of the attempt `marker` (`ATTEMPT_ENV`, `<run>/<attempt>`) names.
 * `unknown_run` when this scope holds no such run, since the engine that settles the attempt reads only its own scope.
 */
export async function appendAttemptOutcome(config: LocalConfig, marker: string, outcome: WorkOutcome): Promise<'appended' | 'bad_marker' | 'unknown_run'> {
  const [runPart, attemptPart, ...rest] = marker.split('/');
  const run = RunIdSchema.safeParse(runPart);
  const attempt = AttemptIdSchema.safeParse(attemptPart);
  if (!run.success || !attempt.success || rest.length > 0) return 'bad_marker';
  if (await readFileSafe(runFilePath(config, run.data)) === null) return 'unknown_run';
  const file = attemptOutcomesPath(config, run.data, attempt.data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(outcome)}\n`, 'utf8');
  return 'appended';
}

/** What the attempt's commands appended to its outcome file, each once; a line that is not an outcome is skipped. */
export async function readAttemptOutcomes(config: LocalConfig, run: string, attempt: string): Promise<WorkOutcome[]> {
  const runId = RunIdSchema.safeParse(run);
  const attemptId = AttemptIdSchema.safeParse(attempt);
  if (!runId.success || !attemptId.success) return [];
  const text = await readFileSafe(attemptOutcomesPath(config, runId.data, attemptId.data));
  return uniqueOutcomes((text ?? '').split('\n').flatMap((line) => {
    const parsed = WorkOutcomeSchema.safeParse(parsedJson(line));
    return parsed.success ? [parsed.data] : [];
  }));
}

function parsedJson(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

const RunLockSchema = z.object({ run: RunIdSchema }).brand<'RunLock'>();
/** Proof that the caller holds this machine's driver lock of `run`. Only `takeRunLock` makes one. */
export type RunLock = z.infer<typeof RunLockSchema>;

const LockOwnerSchema = z.object({ pid: z.number().int() });

/** What `takeRunLock` did: ran its body, which answered `value`, or found the lock `busy` and ran nothing. */
export type LockTaken<T> = { kind: 'held'; value: T } | { kind: 'busy'; error: { code: 'driver_running'; message: string } };

/**
 * Runs `body` holding `runs/<run>/driver.lock`, the one lock every driver of `run` on this machine takes, or answers
 * `busy` when another live process still holds it after `waitMs`. `waitMs: 0` tries once.
 */
export async function takeRunLock<T>(config: LocalConfig, run: RunId, body: (lock: RunLock) => Promise<T>, { waitMs }: { waitMs: number }): Promise<LockTaken<T>> {
  const lock = driverLockPath(config, run);
  const until = Date.now() + waitMs;
  while (!await acquireLock(lock)) {
    if (Date.now() >= until) {
      const owner = LockOwnerSchema.safeParse(parsedJson(await readFileSafe(lock)));
      return { kind: 'busy', error: { code: 'driver_running', message: owner.success
        ? `Run ${run} is already driven by process ${owner.data.pid} on this machine. Stop that driver, or wait for it.`
        : `Run ${run} has a local driver lock whose process id is unknown. Stop that driver, or inspect its driver.lock file.` } };
    }
    await delay(LOCK_WAIT_MS);
  }
  try {
    return { kind: 'held', value: await body(RunLockSchema.parse({ run })) };
  } finally {
    await releaseLock(lock);
  }
}

/** `takeRunLock` for a caller whose body answers an envelope: a busy lock answers as the `driver_running` error. */
export async function withRunLock<T>(
  config: LocalConfig,
  run: RunId,
  body: (lock: RunLock) => Promise<T>,
  options: { waitMs: number },
): Promise<T | { error: { code: 'driver_running'; message: string } }> {
  const taken = await takeRunLock(config, run, body, options);
  return taken.kind === 'held' ? taken.value : { error: taken.error };
}

function runnerLockPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'runner.lock');
}

/**
 * Runs `body` holding `attempts/<attempt>/runner.lock`, which the skill driver's runner of the attempt holds for its
 * whole life, or answers `held` when a live process holds it.
 */
export async function withRunnerLock<T>(config: LocalConfig, run: RunId, attempt: AttemptId, body: () => Promise<T>): Promise<T | 'held'> {
  const lock = runnerLockPath(config, run, attempt);
  if (!await acquireLock(lock)) return 'held';
  try {
    return await body();
  } finally {
    await releaseLock(lock);
  }
}

/** Whether a live process holds the runner lock of `attempt`. */
export async function runnerAlive(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<boolean> {
  return !await acquireLock(runnerLockPath(config, run, attempt), { dryRun: true });
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
  releasedTokens: z.array(ReleasedTokensSchema).optional(),
  stoppedAttempts: z.array(StoppedAttemptSchema).optional(),
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

/** The definitions a run pins as they were pulled, which the run file keeps byte for byte. */
const PINNED: ReadonlySet<string> = new Set(['definition', 'workflows', 'scorers'] satisfies Array<keyof RunState>);

/** `run` as its file holds it: each of `secrets` masked in every field but the pinned definitions. */
function maskedRun(run: RunState, secrets: Record<string, string>): unknown {
  if (Object.keys(secrets).length === 0) return run;
  return Object.fromEntries(Object.entries(run).map(([key, value]) => [key, PINNED.has(key) ? value : redactJson(value, secrets)]));
}

/**
 * Reads run `runId` under its lock, `missing` when it has no file, and writes the run `change` returns, if any, with
 * each of `secrets` masked. The caller resolves `secrets` before the lock, once per operation.
 * The only writer of run files, so no write lands between another process's read and its write.
 */
export async function updateRun<T>(
  config: LocalConfig,
  runId: string,
  secrets: Record<string, string>,
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
    if (write) await writeJsonAtomic(runFilePath(config, runId), maskedRun(write, secrets));
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
