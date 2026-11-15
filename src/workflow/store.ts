import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import { errnoCode, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { resolveReal } from '../utils/path-safety.js';
import { redact, redactJson } from '@teamai/shared/redact';
import { getDataHome, type LocalConfig } from '../types.js';
import type { JsonValue } from '@teamai/shared/json';
import { acquireLock, lockState, releaseLock, withFileLock } from '../update.js';
import { ArchivedPassSchema, FailureSchema, ReleasedTokensSchema, SessionContinuationSchema, StepStateSchema, StoppedAttemptSchema } from './step-state.js';
import type { HandoffOwner } from './snapshot.js';
import { uniqueOutcomes, WorkOutcomeSchema, type WorkOutcome } from '../outcomes.js';
import type { DriveOptions, RunState } from './types.js';
import { appendRegularFile, readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';
import { log } from '@teamai/shared/log';

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

/**
 * The directory that holds this scope's run files, `<run id>.json` each. It is spelled by its real path, so every
 * process of a run names the run's files alike, whatever spelling of HOME each one was given.
 */
export function runsDir(config: LocalConfig): string {
  return runsDirIn(getDataHome(config));
}

/** `runsDir` of the scope whose data home is `dataHome`, for a caller that has a data home and no config of it. */
export function runsDirIn(dataHome: string): string {
  return path.join(resolveReal(dataHome), 'workflows', 'runs');
}

export function runFilePath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.json`);
}

export function runLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.lock`);
}

/** What `withCleanupLock` did: ran its action, which answered `value`, or found the lock `busy` and ran nothing. */
export type CleanupLocked<T> = { kind: 'held'; value: T } | { kind: 'busy' };

/**
 * Runs `action` holding run `runId`'s cleanup lock, taken without waiting: by `doctor --fix` from its last check of the
 * run through removing what it left, and by a retry while it reopens the run, so neither runs inside the other. Never
 * the run lock, which no network call may hold.
 */
export async function withCleanupLock<T>(config: LocalConfig, runId: string, action: () => Promise<T>): Promise<CleanupLocked<T>> {
  const lock = path.join(runsDir(config), `${runId}.cleanup.lock`);

  if (!await acquireLock(lock)) return { kind: 'busy' };

  try {
    return { kind: 'held', value: await action() };
  } finally {
    await releaseLock(lock);
  }
}

/** Held while this machine delivers a run's pull requests: never the run lock, which no network call may hold. */
export function deliveryLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), `${runId}.delivery.lock`);
}

/**
 * The lock of data home `dataHome` an uninstall holds from its last check that nothing of its runs is live until it has
 * removed them. What an uninstall must see to refuse takes it as it starts: an attempt while it records the place it
 * opens, a driver while it takes its run's `driver.lock`. So neither starts between the check and the removal.
 */
export function runsRemovalLockIn(dataHome: string): string {
  return path.join(dataHome, '.places-lock');
}

export const RUNS_REMOVAL_LOCK_WAIT = { attempts: 50, delayMs: 200 } as const;

export function driverLockPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), runId, 'driver.lock');
}

/** `runs/<run>/scratch/`: the directory a run's steps share as `$TEAMAI_RUN_DIR`, from its first lease until it ends. */
export function runScratchDir(config: LocalConfig, run: string): string {
  return path.join(runsDir(config), run, 'scratch');
}

/** `runs/<run>/attempts/`: a directory for each attempt of the run. */
export function attemptsDir(config: LocalConfig, run: RunId): string {
  return attemptsDirIn(runsDir(config), run);
}

/** `attemptsDir` of run `run` in the runs directory `runs`. */
export function attemptsDirIn(runs: string, run: RunId): string {
  return path.join(runs, run, 'attempts');
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

/**
 * `attempts/<a>/out/`: what a step attempt leaves behind, read-write for its tool: the result file, and the evidence
 * archived with its session.
 */
export function attemptOutDir(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'out');
}

/**
 * `attempts/<a>/stdout.log`: the last lines a command step wrote to stdout that are not its outputs, masked, which stay
 * on this machine: a command can print a secret no mask knows.
 */
export function attemptStdoutPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'stdout.log');
}

/** How many of the last lines a command wrote to stdout, besides its outputs, its attempt keeps. */
const STDOUT_LINES = 200;

/**
 * Keeps the last non-empty lines of `stdout`, which a command step printed and which are not its outputs, in the
 * attempt's `stdout.log` (mode 0600), masked whole with `secrets` so a secret over lines is too. Answers the file, or
 * undefined when the command printed nothing or the file could not be written, which it warns of: the step's result
 * does not depend on it.
 */
export async function keepAttemptStdout(config: LocalConfig, { run, attempt, stdout, secrets }: { run: RunId; attempt: AttemptId; stdout: string; secrets: Record<string, string> }): Promise<string | undefined> {
  const printed = redact(stdout, { envSecrets: secrets, patterns: false }).split(/\r?\n/).filter((line) => line.trim() !== '').slice(-STDOUT_LINES);

  if (printed.length === 0) return undefined;
  const file = attemptStdoutPath(config, run, attempt);

  try {
    await writeRegularFile(file, `${printed.join('\n')}\n`, { mode: 0o600 });
  } catch (error) {
    log.warn(`Could not keep the lines attempt ${attempt} printed on stdout in ${file}: ${error instanceof Error ? error.message : String(error)}. The step's result stands; only those lines are not kept.`);

    return undefined;
  }

  return file;
}

/** The name of an attempt's result file in its `out/` directory. */
export const ATTEMPT_RESULT_FILE = 'result.json';

/**
 * `attempts/<a>/out/result.json`: what a prompt step's tool or child agent, or a command step's driver, wrote the step
 * produced. It has a directory of its own, which a step runtime gets read-write, because the attempt directory beside
 * it holds the place record and the saved overlay.
 */
export function attemptResultPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptOutDir(config, run, attempt), ATTEMPT_RESULT_FILE);
}

/**
 * `runs/<run>/outcomes/<attempt>.jsonl`: one outcome per line, appended by the attempt's own commands, such as
 * `contribute`. Not the result file, which a prompt step's tool writes whole at its end.
 */
export function attemptOutcomesPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(runsDir(config), run, 'outcomes', `${attempt}.jsonl`);
}

/**
 * Append `outcome` to the outcome file of attempt `attempt` of run `run`, as the attempt marker names them
 * (`markedAttempt`). `unknown_run` when this scope holds no such run, since the engine that settles the attempt reads
 * only its own scope.
 */
export async function appendAttemptOutcome(config: LocalConfig, { run, attempt }: { run: RunId; attempt: AttemptId }, outcome: WorkOutcome): Promise<'appended' | 'unknown_run'> {
  if (await readRegularFile(runFilePath(config, run), 'utf8').catch(() => null) === null) return 'unknown_run';
  const file = attemptOutcomesPath(config, run, attempt);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await appendRegularFile(file, `${JSON.stringify(outcome)}\n`);

  return 'appended';
}

/** What the attempt's commands appended to its outcome file, each once; a line that is not an outcome is skipped. */
export async function readAttemptOutcomes(config: LocalConfig, run: string, attempt: string): Promise<WorkOutcome[]> {
  const runId = RunIdSchema.safeParse(run);
  const attemptId = AttemptIdSchema.safeParse(attempt);

  if (!runId.success || !attemptId.success) return [];
  const text = await readRegularFile(attemptOutcomesPath(config, runId.data, attemptId.data), 'utf8').catch(() => null);

  return uniqueOutcomes((text ?? '').split('\n').flatMap((line) => {
    const parsed = WorkOutcomeSchema.safeParse(parsedJson(line));

    return parsed.success ? [parsed.data] : [];
  }));
}

function parsedJson(text: string | null): JsonValue | undefined {
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
 * A driver of run `run` found, as it took the run's lock, that the run, or the data home it was in, is gone: an
 * uninstall of the scope removed them while this teamai, which had read its configuration before, waited to drive it.
 * Nothing of the scope is left to drive, so it stops, and makes no data home again.
 */
export class RunRemovedError extends Error {
  constructor(readonly run: RunId, { wasRecorded, dataHome }: { wasRecorded: boolean; dataHome: string }) {
    super(wasRecorded
      ? `Run ${run} was removed from this machine while teamai waited to drive it: an uninstall of this scope removed its runs, so nothing drives it here.`
      : `Run ${run} is not on this machine: its data home ${dataHome} is not there, as after an uninstall of this scope, so nothing drives it here.`);
    this.name = 'RunRemovedError';
  }
}

/**
 * The data home's removal lock (`runsRemovalLockIn`) stayed taken while teamai waited to drive `run`. An attempt and
 * a driver hold it only for one write, and an uninstall of the scope while it removes the runs, so this is no driver
 * of the run: the run may be gone once it ends.
 */
export class RunsRemovalLockTakenError extends Error {
  constructor(readonly run: RunId, { lock, pid }: { lock: string; pid: number | undefined }) {
    super(`Run ${run} cannot be driven now: ${lock} stays taken${pid === undefined ? '' : ` by process ${pid}`}, as an uninstall of this scope holds it while it removes the runs. Try again once that uninstall ends.`);
    this.name = 'RunsRemovalLockTakenError';
  }
}

/** The envelope error of a run lock not taken because an uninstall removes, or removed, the runs; rethrows anything else. */
export function runRemovalRefusal(cause: unknown) {
  if (cause instanceof RunRemovedError) return { error: { code: 'run_not_found' as const, message: cause.message } };

  if (cause instanceof RunsRemovalLockTakenError) return { error: { code: 'busy' as const, message: cause.message } };
  throw cause;
}

/**
 * Whether this machine keeps anything of run `run`: its record, or its folder, which alone is what a fleet member keeps
 * of a run it claimed. Both go only when an uninstall, or retention, removes the run.
 */
export async function isRunHere(config: LocalConfig, run: RunId): Promise<boolean> {
  const kept = await Promise.all([runFilePath(config, run), path.join(runsDir(config), run)].map(async (file) => (await fs.stat(file).catch(() => undefined)) !== undefined));

  return kept.includes(true);
}

/** The pid lock file `lock` names, when it names one. */
async function lockPid(lock: string): Promise<number | undefined> {
  const owner = LockOwnerSchema.safeParse(parsedJson(await readRegularFile(lock, 'utf8').catch(() => null)));

  return owner.success ? owner.data.pid : undefined;
}

/**
 * The runs of `runs`, a data home's `workflows/runs`, that a live process of this machine drives: those whose
 * `driver.lock` it holds, or the `runner.lock` of one of their attempts, which a skill driver's runner holds for its
 * whole life, with its pid when the lock names one. None when the folder is not there.
 */
export async function runsDrivenIn(runs: string): Promise<Array<{ run: RunId; pid: number | undefined }>> {
  let names: string[];

  try {
    names = (await fs.readdir(runs)).sort();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }

  const driven: Array<{ run: RunId; pid: number | undefined }> = [];

  for (const name of names) {
    const run = RunIdSchema.safeParse(name);

    if (!run.success) continue;

    const attempts = await fs.readdir(attemptsDirIn(runs, run.data)).catch((cause: unknown) => {
      if (errnoCode(cause) === 'ENOENT') return [];
      throw cause;
    });

    const runners = attempts.sort().flatMap((entry) => {
      const attempt = AttemptIdSchema.safeParse(entry);

      return attempt.success ? [runnerLockIn(runs, run.data, attempt.data)] : [];
    });

    const locks = [path.join(runs, run.data, 'driver.lock'), ...runners];

    for (const lock of locks) {
      if (await lockState(lock) !== 'live') continue;
      driven.push({ run: run.data, pid: await lockPid(lock) });
      break;
    }
  }

  return driven;
}

/**
 * Runs `body` holding `runs/<run>/driver.lock`, the one lock every driver of `run` on this machine takes, or answers
 * `busy` when another live process still holds it after `waitMs`. `waitMs: 0` tries once. Each try is made under the
 * data home's removal lock (`runsRemovalLockIn`), so an uninstall sees this driver, or removed the run before it: then
 * it throws `RunRemovedError`, and makes no data home again. A removal lock that stays taken throws
 * `RunsRemovalLockTakenError`, never `busy`, which callers read as a live driver of the run.
 */
export async function takeRunLock<T>(config: LocalConfig, run: RunId, body: (lock: RunLock) => Promise<T>, { waitMs }: { waitMs: number }): Promise<LockTaken<T>> {
  const lock = driverLockPath(config, run);
  const until = Date.now() + waitMs;

  for (let tried = await tryDriverLock(config, run); tried !== 'held'; tried = await tryDriverLock(config, run)) {
    if (Date.now() >= until) {
      const pid = await lockPid(lock);

      return { kind: 'busy', error: { code: 'driver_running', message: pid !== undefined
        ? `Run ${run} is already driven by process ${pid} on this machine. Stop that driver, or wait for it.`
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

/**
 * One try at run `run`'s `driver.lock`, made holding its data home's removal lock, which is taken without making the
 * data home: `held`, or `busy` while a live process holds it. Throws `RunRemovedError` when the run, or its data home,
 * is gone, and `RunsRemovalLockTakenError` when the removal lock stays taken.
 */
async function tryDriverLock(config: LocalConfig, run: RunId): Promise<'held' | 'busy'> {
  const dataHome = getDataHome(config);
  const removal = runsRemovalLockIn(dataHome);
  const wasRecorded = await isRunHere(config, run);

  const tried = await withFileLock(removal, RUNS_REMOVAL_LOCK_WAIT, async () => {
    if (wasRecorded && !await isRunHere(config, run)) return 'removed';

    return await acquireLock(driverLockPath(config, run)) ? 'held' : 'busy';
  }, { createParent: false });

  if (tried.held ? tried.value === 'removed' : tried.isDirectoryGone) throw new RunRemovedError(run, { wasRecorded, dataHome });

  if (tried.held && tried.value !== 'removed') return tried.value;

  throw new RunsRemovalLockTakenError(run, { lock: removal, pid: await lockPid(removal) });
}

/**
 * `takeRunLock` for a caller whose body answers an envelope: a busy lock answers as the `driver_running` error, and a
 * lock an uninstall keeps from it as `runRemovalRefusal` does.
 */
export async function withRunLock<T>(
  config: LocalConfig,
  run: RunId,
  body: (lock: RunLock) => Promise<T>,
  options: { waitMs: number },
): Promise<T | { error: { code: 'driver_running' | 'run_not_found' | 'busy'; message: string } }> {
  const taken = await takeRunLock(config, run, body, options).catch(runRemovalRefusal);

  if (!('kind' in taken)) return taken;

  return taken.kind === 'held' ? taken.value : { error: taken.error };
}

function runnerLockPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return runnerLockIn(runsDir(config), run, attempt);
}

function runnerLockIn(runs: string, run: RunId, attempt: AttemptId): string {
  return path.join(attemptsDirIn(runs, run), attempt, 'runner.lock');
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

/**
 * The team revision a run started from (`team-pin.ts`). `patch`: the sha256 of the patch the run keeps beside its file,
 * absent when the checkout held only `revision`.
 */
export const TeamPinSchema = z.object({ revision: z.string().regex(/^[0-9a-f]{40,64}$/), patch: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();

/** The fields a run file must hold to be read as a run; every other field passes through as written. */
const RunFileSchema = z.looseObject({
  schemaVersion: z.literal('v1alpha1'),
  id: z.string().regex(RUN_ID),
  name: z.string(),
  revision: z.number(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  definition: z.looseObject({
    schemaVersion: z.literal('v1alpha1'),
    name: z.string(),
    description: z.string(),
    steps: z.array(z.unknown()),
  }),
  steps: z.array(z.unknown()),
  settledAttempts: z.array(z.unknown()),
});

export function isRunState(value: unknown): value is RunState {
  return RunFileSchema.safeParse(value).success;
}

/**
 * The attempt of another run's step a run is part of: the attempt a `command` step's process ran in when that process
 * started the run and drove it, as the shortcut of `teamai score` or `recall maintenance --update-quality` does there.
 * The run ends with that attempt (`part-of-step.ts`). A run file written before it has none: it is part of no step.
 */
export const PartOfStepSchema = z.object({ run: RunIdSchema, attempt: AttemptIdSchema }).strict();

export type PartOfStep = z.infer<typeof PartOfStepSchema>;

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
  teamPin: TeamPinSchema.optional(),
  finalizing: z.object({
    outcome: z.enum(['succeeded', 'failed', 'cancelled']), end: z.string().optional(), failure: FailureSchema.optional(), since: z.string(), until: z.string(),
  }).optional(),
  /** The owner's run a fleet member runs this one for, whose id its steps read as `run.id`. */
  nestedIn: RunIdSchema.optional(),
  partOf: PartOfStepSchema.optional(),
  timeout: z.number().int().positive().optional(),
  /** A workflow folder's sourceHash names its copy under the data home, so the run reads only one of those. */
  folder: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  folders: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  driveOptions: (z.object({
    tools: z.record(z.string(), z.string()).optional(), autoApprove: z.boolean().optional(), sandbox: z.literal(true).optional(), driver: z.string().min(1).optional(),
  }) satisfies z.ZodType<DriveOptions>).optional(),
});

export async function readRun(config: LocalConfig, runId: string): Promise<RunState | 'missing' | 'corrupt'> {
  const raw = await readRegularFile(runFilePath(config, runId), 'utf8').catch(() => null);

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

/** Every run of this scope whose file this machine can read. */
export async function readRuns(config: LocalConfig): Promise<RunState[]> {
  const files = await fs.readdir(runsDir(config)).catch(() => []);
  const ids = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).filter(isRunId);
  const runs = await Promise.all(ids.map((id) => readRun(config, id)));

  return runs.filter((run): run is RunState => run !== 'missing' && run !== 'corrupt');
}

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a locked run update found: the value its change returned, or why the change did not run. */
export type RunUpdate<T> = { status: 'done'; value: T } | { status: 'busy' } | { status: 'corrupt' };

/**
 * The definitions a run pins as they were pulled, which the run file keeps byte for byte. An admitted workflow output is
 * frozen with the run, so masking never rewrites it; admission refuses what holds a secret.
 */
const PINNED: ReadonlySet<string> = new Set(['definition', 'workflows', 'admitted'] satisfies Array<keyof RunState>);

/** `run` as its file holds it: each of `secrets` masked in every field but the pinned definitions. */
function maskedRun(run: RunState, secrets: Record<string, string>) {
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
  let id = ownerId(await readRegularFile(file, 'utf8').catch(() => null));

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

    id = ownerId(await readRegularFile(file, 'utf8').catch(() => null));
  }

  if (id === undefined) throw new Error(`${file} does not hold an install id. Move it aside and try again.`);

  return { id, user: config.username };
}

const OwnerFileSchema = z.object({ id: z.string().min(1) });

function ownerId(text: string | null): string | undefined {
  const owner = OwnerFileSchema.safeParse(parsedJson(text));

  return owner.success ? owner.data.id : undefined;
}
