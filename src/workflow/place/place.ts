import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stepEnvironment } from '../../env-exec.js';
import type { RunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { gitCommonDir } from '../../utils/git.js';
import { redactJson } from '../../utils/redact.js';
import { attemptEnv } from '../attempt-marker.js';
import type { LeaseWire } from '../lease-wire.js';
import { attemptDir, AttemptIdSchema, attemptsDir, type AttemptId, type RunId, type RunLock } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import type { WorkspaceContract } from '../workspace.js';
import { clearWorktreeHooks, headCommit, markReadCopy, markSetup, removeWorktree, reopenConfigConflicts, stepCheckout, worktreePath } from '../worktree.js';
import { adoptRefusal, takeAdopted } from './adopted.js';
import { openWorktree } from './created.js';
import { applyOverlay, restoreOverlay, unrestoredConfig } from './overlay.js';
import { finishReader, leaveReadCopy, readCopyFailure, stageReader } from './reader.js';
import { PlaceFinishedSchema, readPlaceRecord, writePlaceRecord, type PlaceRecord } from './record.js';
import { runSetup } from './setup.js';
import { finishWriter, mergeBranches, rememberConflicts, withUnpushed } from './writer.js';

/**
 * The checkout a driver working from `cwd` makes its places in: `checkout`, the one the run started from, unless `cwd`
 * is a checkout of another repository, as a clone on a machine that took the run over is. A run that records no
 * checkout uses `cwd`.
 */
export async function placeRoot({ cwd, checkout }: { cwd: string; checkout: string | undefined }): Promise<string> {
  if (checkout === undefined) return cwd;
  const [here, there] = await Promise.all([gitCommonDir(cwd), gitCommonDir(checkout)]);
  return here !== null && here !== there ? cwd : checkout;
}

/** The place key two attempts of one driver must not share: the copy of the lease's branch, else the checkout. */
export function placeOf(lease: { cwd?: string; workspace?: Pick<WorkspaceContract, 'branch'> }, root: string): string {
  return lease.cwd ?? stepCheckout(root, lease.workspace?.branch);
}

/**
 * The attempt among `others` that holds the place `lease` would get under `root`, the place the host made for its
 * branch, or the place the host made at `adopt`, with the place it holds: one whose prepare began there and whose place
 * is not finished or given up, so a prepare killed before its git was done still holds it. Two attempts of one driver
 * never share a place.
 */
export async function placeHeldBy(input: { config: LocalConfig; run: RunId; root: string; lease: Pick<PlaceLease, 'workspace'>; others: AttemptId[]; adopt?: string }): Promise<{ behind: AttemptId; dir: string } | undefined> {
  const { config, run, lease, adopt } = input;
  const hosted = lease.workspace ? await adoptedPlaceOf({ config, run, branch: lease.workspace.branch }) : undefined;
  const places = [placeOf(lease, path.resolve(input.root)), ...(hosted !== undefined ? [hosted] : []), ...(adopt !== undefined ? [path.resolve(adopt)] : [])];
  for (const other of input.others) {
    const read = await readPlaceRecord(config, run, other);
    const recorded = read.kind === 'found' ? read.record : undefined;
    if (!recorded || recorded.phase === 'finished' || recorded.phase === 'abandoned') continue;
    if (places.includes(recorded.dir)) return { behind: other, dir: recorded.dir };
  }
  return undefined;
}

/**
 * The place the host made that the last attempt of `run` to finish on `branch` was prepared in: every later lease on
 * that branch goes on there while it passes the adopt checks, as one goes on in a worktree TeamAI made.
 */
export async function adoptedPlaceOf(input: { config: LocalConfig; run: RunId; branch: string }): Promise<string | undefined> {
  const { config, run, branch } = input;
  let last: { dir: string; at: string } | undefined;
  for (const name of await fs.readdir(attemptsDir(config, run)).catch(() => [])) {
    const attempt = AttemptIdSchema.safeParse(name);
    const read = attempt.success ? await readPlaceRecord(config, run, attempt.data) : undefined;
    const recorded = read?.kind === 'found' ? read.record : undefined;
    if (!recorded || recorded.phase !== 'finished' || !recorded.adopted || recorded.place.role === 'checkout') continue;
    if (recorded.place.workspace.branch === branch && (last === undefined || recorded.at > last.at)) last = { dir: recorded.dir, at: recorded.at };
  }
  return last?.dir;
}

/** The lease fields a place reads. Its `expiresAt` bounds setup. */
export type PlaceLease = Pick<LeaseWire, 'attempt' | 'step' | 'prompt' | 'interactive' | 'readOnly' | 'workspace' | 'setup' | 'expiresAt'> & { executor: 'command' | 'prompt' };

/** The place fields of `lease`, a lease `next` answered with. */
export function placeLeaseOf(lease: LeaseWire): PlaceLease {
  const { attempt, step, command, prompt, interactive, readOnly, workspace, setup, expiresAt } = lease;
  return {
    attempt, step, executor: command !== undefined ? 'command' : 'prompt',
    ...(prompt !== undefined ? { prompt } : {}),
    ...(interactive ? { interactive: true } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(workspace ? { workspace } : {}),
    ...(setup ? { setup } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * The directory the step runs in, and its prompt with what the place adds to it: a merge conflict to resolve. `refused`
 * when the place the host made cannot be adopted, which leaves the attempt as it was.
 */
export type PlacePrepared =
  | { kind: 'prepared'; dir: string; prompt?: string }
  | { kind: 'failed'; failure: WorkflowFailure }
  | { kind: 'refused'; failure: WorkflowFailure & { code: 'adopt_mismatch' } };

/** A record of a place whose git is done, from `preparing` on. */
type Placed = Exclude<PlaceRecord, { phase: 'opening' }>;

/** A record of every phase but its phase fields. */
type PlaceRecordBase = Omit<Extract<PlaceRecord, { phase: 'ready' }>, 'phase'>;

/** The files of an attempt's place beside its record: the snapshot a reader is checked against, and the kept branch agent files. */
function placeFiles(config: LocalConfig, run: RunId, attempt: AttemptId): { snapshot: string; overlay: string } {
  const dir = attemptDir(config, run, attempt);
  return { snapshot: path.join(dir, 'before.json'), overlay: path.join(dir, 'overlay') };
}

function preparedOf(record: Placed, prompt: string | undefined): PlacePrepared {
  const note = record.place.role === 'writer' ? record.place.conflictNote ?? '' : '';
  return { kind: 'prepared', dir: record.dir, ...(prompt !== undefined ? { prompt: `${prompt}${note}` } : {}) };
}

function baseOf(record: Placed): PlaceRecordBase {
  const { version, run, attempt, step, executor, root, dir, adopted, interactive, readOnly, place } = record;
  return { version, run, attempt, step, executor, root, dir, place, ...(adopted ? { adopted } : {}), ...(interactive ? { interactive } : {}), ...(readOnly ? { readOnly } : {}) };
}

/**
 * Prepares the place of `lease` under `root`, the checkout the run started from, and records it in
 * `attempts/<a>/place.json`, so any process can finish it. A lease without a workspace contract runs in `root`. Any
 * other gets the worktree of its branch, with its start, merges and the base agent configuration in place, and setup
 * left to `runPlaceSetup`. A second prepare of the attempt returns the recorded place, unless it was abandoned: then
 * the place is as prepare found it, and a resumed lease whose step stopped prepares it again. A prepare killed before
 * the place is ready is finished by the next. With `adopt`, a writer's copy is the place the host made there, once
 * `adoptRefusal` accepts it. Without it, a lease on a branch whose last attempt finished in a place the host made goes
 * on there while that place passes the same checks, and TeamAI makes the copy once it does not.
 */
export async function preparePlace(input: { config: LocalConfig; lock: RunLock; root: string; lease: PlaceLease; adopt?: string }): Promise<PlacePrepared> {
  const { config, lock: { run }, lease } = input;
  const root = path.resolve(input.root);
  const read = await readPlaceRecord(config, run, lease.attempt);
  if (read.kind === 'unreadable') {
    return { kind: 'failed', failure: { code: 'workspace_base', message: `The place record of attempt ${lease.attempt} cannot be read (${read.reason}). Retry the step with teamai workflow retry ${run} ${lease.step}.` } };
  }
  let recorded = read.kind === 'found' ? read.record : undefined;
  if (recorded?.phase === 'setting-up') {
    // A setup cut short is given up as a failed one is, so this prepare starts over from a place no setup touched.
    const given = await giveUpSetup(config, recorded);
    if (given.unrestored) {
      return { kind: 'failed', failure: { code: 'workspace_base', message: `Setup was cut short in ${recorded.dir}, so the step did not run there. ${given.unrestored}` } };
    }
    recorded = given.abandoned;
  }
  const reopened = recorded?.phase === 'opening' ? recorded : undefined;
  const { workspace } = lease;
  const hosted = workspace ? await adoptedPlaceOf({ config, run, branch: workspace.branch }) : undefined;
  // A prepare killed while it adopted a place goes on in that place.
  const asked = input.adopt !== undefined ? path.resolve(input.adopt) : reopened?.adopted ? reopened.dir : undefined;
  const refusal = await adoptRefusal({ root, run, recorded, lease, adopt: asked, hosted });
  if (refusal !== undefined) return { kind: 'refused', failure: { code: 'adopt_mismatch', message: refusal } };
  const result = await recordedResult(config, recorded, lease.prompt);
  if (result) return result;
  const base: OpeningBase = {
    version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root,
    ...(lease.interactive ? { interactive: true as const } : {}), ...(lease.readOnly ? { readOnly: true as const } : {}),
  };
  if (!workspace) {
    await stageReader(root, placeFiles(config, run, lease.attempt).snapshot);
    const record: PlaceRecord = { ...base, dir: root, place: { role: 'checkout' }, phase: 'ready' };
    await writePlaceRecord(config, record);
    return preparedOf(record, lease.prompt);
  }
  const passedOver = !reopened && hosted !== undefined ? await adoptRefusal({ root, run, recorded, lease, adopt: hosted, hosted }) : undefined;
  const goesOn = !reopened && hosted !== undefined && passedOver === undefined;
  const adopt = asked ?? (goesOn ? hosted : undefined);
  const opened = await openCopy({ config, base, lease, workspace, reopened, adopt, hosted });
  // While the host's place has the branch checked out, git refuses TeamAI's own worktree of it, so the failure leads with
  // why that place was passed over.
  const explained = (opening: WorkflowFailure): WorkflowFailure => adopt === undefined && hosted !== undefined && passedOver !== undefined
    ? { ...opening, message: `TeamAI did not go on in ${hosted}, the place the host made for branch ${workspace.branch}: ${passedOver} Making its own worktree of the branch failed too: ${opening.message}` }
    : opening;
  const prepared: PlacePrepared = 'code' in opened ? { kind: 'failed', failure: explained(opened) } : await stageRole({ config, base, lease, workspace, ...opened });
  // The step does not run in a place the host made whose prepare failed, so the host's own hooks run there again.
  if (prepared.kind === 'failed' && adopt !== undefined) await clearWorktreeHooks(adopt);
  return prepared;
}

/** The place a prepare recorded for the attempt before, unless it gave the place up or left its git undone. */
async function recordedResult(config: LocalConfig, recorded: PlaceRecord | undefined, prompt: string | undefined): Promise<PlacePrepared | undefined> {
  if (recorded === undefined || recorded.phase === 'abandoned' || recorded.phase === 'opening') return undefined;
  return recorded.phase === 'preparing' ? overlaid(config, recorded, prompt, { resume: true }) : preparedOf(recorded, prompt);
}

/**
 * Opens the copy of `workspace.branch`: `reopened`, the one a killed prepare recorded `opening`, else `adopt`, else the
 * worktree of the branch. `hosted` is the place the host made that the branch's last attempt finished in. The
 * `opening` record comes before git touches the copy.
 */
async function openCopy(input: {
  config: LocalConfig; base: OpeningBase; lease: PlaceLease; workspace: WorkspaceContract; reopened: Opening | undefined; adopt: string | undefined; hosted: string | undefined;
}): Promise<{ opening: Opening; dir: string; created: boolean } | WorkflowFailure> {
  const { config, base, lease, workspace, reopened, adopt, hosted } = input;
  let opening: Opening;
  if (reopened) opening = reopened;
  else if (adopt !== undefined) {
    // A place an earlier attempt set up for the branch is not set up again, as a worktree TeamAI made is not.
    opening = { ...base, dir: adopt, phase: 'opening', ...(adopt === hosted ? {} : { created: true as const }), adopted: true };
    await writePlaceRecord(config, opening);
  } else {
    const dir = worktreePath(base.root, workspace.branch);
    const present = await fs.stat(dir).then(() => true, () => false);
    opening = { ...base, dir, phase: 'opening', ...(present ? {} : { created: true as const }) };
    await writePlaceRecord(config, opening);
  }
  const opened = adopt !== undefined
    ? await takeAdopted({ root: base.root, dir: adopt, workspace })
    : await openWorktree({ root: base.root, run: base.run, step: lease.step, workspace, setup: lease.setup !== undefined });
  if ('code' in opened) return opened;
  return { opening, dir: opened.dir, created: opening.created === true || ('created' in opened && opened.created === true) };
}

/**
 * Stages the opened copy for the lease's role: a reader marks it in use, and a writer takes its range and merges. It is
 * then recorded `preparing`, with the lease's setup when the copy is new, and gets the base overlay.
 */
async function stageRole(input: {
  config: LocalConfig; base: OpeningBase; lease: PlaceLease; workspace: WorkspaceContract; opening: Opening; dir: string; created: boolean;
}): Promise<PlacePrepared> {
  const { config, base, lease, workspace, opening, dir, created } = input;
  let place: Preparing['place'];
  if (workspace.mode === 'read-only') {
    const marked = await markReadCopy(dir, { branch: workspace.branch, step: lease.step });
    if ('error' in marked) return { kind: 'failed', failure: { code: 'workspace_base', message: `Step "${lease.step}" cannot mark workspace ${dir} as in use by a reader: ${marked.error}` } };
    place = { role: 'reader', workspace, found: marked.found };
  } else {
    const rangeFrom = opening.rangeFrom ?? (await headCommit(dir))?.commit;
    if (rangeFrom !== undefined && opening.rangeFrom === undefined) await writePlaceRecord(config, { ...opening, rangeFrom });
    const merged = await mergeBranches({ dir, run: base.run, step: lease.step, executor: lease.executor, merge: workspace.merge });
    if (merged.kind === 'failed') return merged;
    place = { role: 'writer', workspace, ...(rangeFrom ? { rangeFrom } : {}), conflicts: {}, ...(merged.note ? { conflictNote: merged.note } : {}) };
  }
  const preparing: Preparing = {
    ...base, dir, place, phase: 'preparing', ...(opening.adopted ? { adopted: true as const } : {}),
    ...(lease.setup && created ? { setup: lease.setup, ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}) } : {}),
  };
  await writePlaceRecord(config, preparing);
  return overlaid(config, preparing, lease.prompt);
}

type Opening = Extract<PlaceRecord, { phase: 'opening' }>;
type Preparing = Extract<PlaceRecord, { phase: 'preparing' }>;
/** The fields every record of a lease's place shares, before its copy is known. */
type OpeningBase = Omit<PlaceRecordBase, 'dir' | 'place'>;

/**
 * Puts the base overlay over the copy of a place recorded `preparing`, then leaves it staged for its setup, or ready.
 * `resume` finishes an overlay a killed prepare left. An overlay git refused leaves the copy as prepare found it.
 */
async function overlaid(config: LocalConfig, record: Preparing, prompt: string | undefined, resume: { resume?: true } = {}): Promise<PlacePrepared> {
  const { root, dir, place, setup, expiresAt } = record;
  const failure = await applyOverlay({ root, dir, configCommit: place.workspace.configCommit, saved: placeFiles(config, record.run, record.attempt).overlay, ...resume });
  if (failure) {
    await writePlaceRecord(config, { ...baseOf(record), phase: 'abandoned', at: new Date().toISOString() });
    return { kind: 'failed', failure };
  }
  if (setup) {
    const staged: PlaceRecord = { ...baseOf(record), phase: 'staged', setup, ...(expiresAt !== undefined ? { expiresAt } : {}) };
    await writePlaceRecord(config, staged);
    return preparedOf(staged, prompt);
  }
  const ready = await settle(config, baseOf(record));
  return 'code' in ready ? { kind: 'failed', failure: ready } : preparedOf(ready, prompt);
}

/**
 * Takes what the step is checked against once its place is set up, and records the place `ready`: a reader's snapshot,
 * taken over the base overlay so only what the step itself changes differs from it, or the conflicts a writer gets.
 */
async function settle(config: LocalConfig, record: PlaceRecordBase): Promise<Placed | WorkflowFailure> {
  const files = placeFiles(config, record.run, record.attempt);
  const { place } = record;
  let settled = record;
  switch (place.role) {
    case 'checkout':
      break;
    case 'reader': {
      const before = await stageReader(record.dir, files.snapshot);
      if (before.ok && before.head) break;
      const unrestored = await restoreOverlay({ dir: record.dir, configCommit: place.workspace.configCommit, saved: files.overlay });
      await writePlaceRecord(config, { ...record, phase: 'abandoned', at: new Date().toISOString() });
      const message = `Step "${record.step}" could not read workspace ${place.workspace.branch}`;
      return { code: 'workspace_base', message: unrestored ? `${message}. ${unrestoredConfig(unrestored, record.dir)}` : message };
    }
    case 'writer':
      await reopenConfigConflicts(record.dir, files.overlay);
      settled = { ...record, place: { ...place, conflicts: await rememberConflicts(record.dir) } };
      break;
    default: {
      const unhandled: never = place;
      return unhandled;
    }
  }
  const ready: Placed = { ...settled, phase: 'ready' };
  await writePlaceRecord(config, ready);
  return ready;
}

/**
 * Runs the setup of a place `preparePlace` left `staged`, with the env `values` resolved for it, then makes it ready.
 * Setup gets its own keys and none of the step's, the attempt marker and the run's `mode`. `signal` stops setup, which then fails, and the worktree it was
 * preparing is removed, or, when the host made it, gets the branch agent files back. Nothing to do for any other place.
 */
export async function runPlaceSetup(input: { config: LocalConfig; run: RunId; attempt: AttemptId; mode: RunMode; values: ReadonlyMap<string, string>; signal?: AbortSignal }): Promise<WorkflowFailure | undefined> {
  const { config, run, attempt, mode, values, signal } = input;
  const read = await readPlaceRecord(config, run, attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;
  if (recorded?.phase !== 'staged') return undefined;
  const { setup, expiresAt } = recorded;
  const scope = setup.envScope ?? { provide: [], withhold: [] };
  const scoped = await stepEnvironment(values, scope);
  if (!scoped.ok) return setupFailed(config, recorded, scoped.failure);
  // The mark stays in the place until setup finishes, so a place the host made is not adopted again after a setup that did not.
  await markSetup(recorded.dir, 'unfinished');
  const settingUp: SettingUp = { ...baseOf(recorded), phase: 'setting-up' };
  await writePlaceRecord(config, settingUp);
  const failure = await runSetup({ command: setup.command, dir: recorded.dir, env: { ...scoped.env, ...attemptEnv(run, attempt, mode) }, keys: scope.provide, signal, groupDir: attemptDir(config, run, attempt), ...(expiresAt !== undefined ? { expiresAt } : {}) });
  if (failure) return setupFailed(config, settingUp, failure);
  await markSetup(recorded.dir, 'finished');
  const ready = await settle(config, baseOf(recorded));
  return 'code' in ready ? ready : undefined;
}

type SettingUp = Extract<PlaceRecord, { phase: 'setting-up' }>;

/** `failure`, the failure of the setup of `record`, once its place is given up. */
async function setupFailed(config: LocalConfig, record: Extract<PlaceRecord, { phase: 'staged' }> | SettingUp, failure: WorkflowFailure): Promise<WorkflowFailure> {
  const { unrestored } = await giveUpSetup(config, record);
  return unrestored ? { ...failure, message: `${failure.message} ${unrestored}` } : failure;
}

/**
 * Gives up the place of a setup that failed or was cut short: the worktree prepare created is removed, and a place
 * the host made gets the branch agent files back. `unrestored` is the sentence a failure adds when they are not back.
 */
async function giveUpSetup(config: LocalConfig, record: Extract<PlaceRecord, { phase: 'staged' }> | SettingUp): Promise<{ abandoned: PlaceRecord; unrestored?: string }> {
  const { place, dir } = record;
  const { overlay } = placeFiles(config, record.run, record.attempt);
  let unrestored: string | undefined;
  if (record.adopted && place.role !== 'checkout') {
    unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: overlay });
    await clearWorktreeHooks(dir);
  } else await removeWorktree(record.root, dir);
  await fs.rm(overlay, { recursive: true, force: true });
  const abandoned: PlaceRecord = { ...baseOf(record), phase: 'abandoned', at: new Date().toISOString() };
  await writePlaceRecord(config, abandoned);
  return { abandoned, ...(unrestored ? { unrestored: unrestoredConfig(unrestored, dir) } : {}) };
}

/** How a step ended, as its driver reports it, before its place is finished. */
export interface StepEnd {
  outcome: 'success' | 'failed';
  message?: string;
  failure?: WorkflowFailure;
}

/** The step's end once its place is finished: what the attempt reports, with its `changes` or `read`. */
type PlaceFinished = z.infer<typeof PlaceFinishedSchema>;

/**
 * Finishes the place of `attempt` once its step ended with `end`, and returns the report the attempt settles with. A
 * reader that changed the checkout or its copy fails; a writer's copy gets its branch agent files back and is
 * committed and pushed, failed steps included. The result is recorded masked with `secrets`, and a second finish
 * returns it. Only an attempt `preparePlace` recorded is finished, so a record gone since fails like an unreadable one.
 */
export async function finishPlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId; end: StepEnd; secrets: Record<string, string> }): Promise<PlaceFinished> {
  const { config, lock: { run }, attempt, end, secrets } = input;
  const read = await readPlaceRecord(config, run, attempt);
  if (read.kind !== 'found') {
    const failure = { code: 'workspace_base', message: `The place record of attempt ${attempt} cannot be read (${read.kind === 'missing' ? 'it is missing' : read.reason}), so the step's changes cannot be checked.` };
    return { outcome: 'failed', message: failure.message, failure };
  }
  const recorded = read.record;
  if (recorded.phase === 'finished') return recorded.finished;
  // A setup that failed gave the place up, and a prepare that failed in git made none: the report carries that failure.
  if ((recorded.phase === 'abandoned' || recorded.phase === 'opening') && end.outcome === 'failed') return end;
  if (recorded.phase !== 'ready') {
    const failure = { code: 'workspace_base', message: `Step "${recorded.step}" has no place to finish: ${unfinishedPlace(recorded.phase)}.` };
    return { outcome: 'failed', message: failure.message, failure };
  }
  const finished = await finishRole(placeFiles(config, run, attempt), recorded, end);
  await writePlaceRecord(config, { ...baseOf(recorded), phase: 'finished', at: new Date().toISOString(), finished: PlaceFinishedSchema.parse(redactJson(finished, secrets)) });
  // Once the step's work is committed, the host's own hooks run again in a place it made.
  if (recorded.adopted) await clearWorktreeHooks(recorded.dir);
  return finished;
}

/** Why a place in `phase` has nothing to finish. */
function unfinishedPlace(phase: 'opening' | 'preparing' | 'staged' | 'setting-up' | 'abandoned'): string {
  switch (phase) {
    case 'opening':
    case 'preparing':
      return 'its prepare was cut short before the step got it';
    case 'staged':
      return 'its setup never ran';
    case 'setting-up':
      return 'its setup never finished';
    case 'abandoned':
      return 'it was given up when the step stopped';
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

async function finishRole(files: { snapshot: string; overlay: string }, record: Placed, end: StepEnd): Promise<PlaceFinished> {
  const { place, dir, step, executor } = record;
  switch (place.role) {
    case 'checkout': {
      const failure = await finishReader({
        dir, file: files.snapshot, executor, outcome: end.outcome,
        ...(record.interactive ? { interactive: true } : {}), ...(record.readOnly ? { readOnly: true } : {}),
      });
      return failure ? { outcome: 'failed', message: failure.message, failure } : end;
    }
    case 'reader': {
      const left = await leaveReadCopy({ dir, file: files.snapshot, workspace: place.workspace, found: place.found, saved: files.overlay, attempt: record.attempt, step });
      if ('code' in left) return { outcome: 'failed', message: left.message, failure: left };
      if (left.state === 'untouched') return { ...end, read: left.read };
      const said = left.changed.length > 0 ? `Read-only ${executor} step changed repository paths: ${left.changed.join(', ')}.` : '';
      // A failing command keeps its own failure, and still says where the changes it made went.
      const own = executor === 'command' && end.outcome === 'failed';
      const copy = readCopyFailure(left, [own && end.message !== undefined ? `${end.message}.` : '', said].filter((part) => part !== '').join(' '));
      if (!own || copy.code === 'workspace_base') return { outcome: 'failed', message: copy.message, failure: copy, read: left.read };
      return { ...end, message: copy.message, ...(end.failure ? { failure: { ...end.failure, message: copy.message } } : {}), read: left.read };
    }
    case 'writer': {
      const written = await finishWriter({
        dir, step, workspace: place.workspace, conflicts: place.conflicts, saved: files.overlay, failed: end.outcome === 'failed',
        ...(place.rangeFrom !== undefined ? { rangeFrom: place.rangeFrom } : {}),
      });
      const changes = written.changes ? { changes: written.changes } : {};
      if (written.failure) return { outcome: 'failed', message: written.failure.message, failure: written.failure, ...changes };
      if (!written.unpushed) return { ...end, ...changes };
      return {
        ...end,
        message: withUnpushed(end.message ?? end.failure?.message ?? 'Step failed', written.unpushed),
        ...(end.failure ? { failure: { ...end.failure, message: withUnpushed(end.failure.message, written.unpushed) } } : {}),
        ...changes,
      };
    }
    default: {
      const unhandled: never = place;
      return unhandled;
    }
  }
}

/**
 * Leaves the place of `attempt`, whose step stopped without a report to finish it, as prepare found it, and commits
 * nothing: a reader's copy is put back, and a writer gets the branch agent files the step did not edit. The sentence a
 * failure adds when git could not list the copy's files to put those back.
 */
export async function abandonPlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<string | undefined> {
  const { config, lock: { run }, attempt } = input;
  const read = await readPlaceRecord(config, run, attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;
  if (!recorded || recorded.phase === 'finished' || recorded.phase === 'abandoned') return undefined;
  const { dir } = recorded;
  // Once the place is put back, the host's own hooks run again in a place it made.
  const left = async (unrestored: string | undefined): Promise<string | undefined> => {
    if (recorded.adopted) await clearWorktreeHooks(dir);
    return unrestored && unrestoredConfig(unrestored, dir);
  };
  // A prepare cut short in git put nothing over the copy, and the next prepare of the attempt goes on from its record.
  if (recorded.phase === 'opening') return left(undefined);
  const files = placeFiles(config, run, attempt);
  const { place } = recorded;
  const abandoned: PlaceRecord = { ...baseOf(recorded), phase: 'abandoned', at: new Date().toISOString() };
  if (recorded.phase === 'preparing') {
    // No step ran over an overlay a killed prepare left, so that overlay is all there is to put back.
    const unrestored = await restoreOverlay({ dir, configCommit: recorded.place.workspace.configCommit, saved: files.overlay, unfinished: true });
    await writePlaceRecord(config, abandoned);
    return left(unrestored);
  }
  let unrestored: string | undefined;
  switch (place.role) {
    case 'checkout':
      break;
    case 'reader':
      unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: files.overlay });
      // The copy keeps its mark while the branch agent files are not back, so later steps there are refused.
      if (!unrestored) await leaveReadCopy({ dir, file: files.snapshot, workspace: place.workspace, found: place.found, saved: files.overlay, attempt, step: recorded.step });
      break;
    case 'writer':
      unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: files.overlay });
      break;
    default: {
      const unhandled: never = place;
      return unhandled;
    }
  }
  await writePlaceRecord(config, abandoned);
  return left(unrestored);
}

/** Whether `preparePlace` recorded a place for `attempt`, readable or not. */
export async function placeRecorded(input: { config: LocalConfig; run: RunId; attempt: AttemptId }): Promise<boolean> {
  return (await readPlaceRecord(input.config, input.run, input.attempt)).kind !== 'missing';
}

/**
 * After an accepted success with `cleanup`: removes the worktree prepare created. A step in the checkout leaves it, and
 * so does one in a place the host made, a reader's included.
 */
export async function releasePlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<'removed' | 'left'> {
  const read = await readPlaceRecord(input.config, input.lock.run, input.attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;
  if (!recorded || recorded.phase === 'opening' || recorded.place.role === 'checkout' || recorded.adopted) return 'left';
  await removeWorktree(recorded.root, recorded.dir);
  return 'removed';
}
