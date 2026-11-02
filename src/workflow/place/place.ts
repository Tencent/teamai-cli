import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stepEnvironment } from '../../env-exec.js';
import type { WorkflowEnv } from '../../env-resolution.js';
import { observeCheckout, type PreparedAgent } from '../../agent-observation.js';
import { detectProjectConfig } from '../../config.js';
import type { RunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { gitCommonDir } from '../../utils/git.js';
import { redactJson } from '../../utils/redact.js';
import { attemptEnv } from '../attempt-marker.js';
import type { LeaseWire } from '../lease-wire.js';
import type { ReportInput } from '../engine.js';
import type { RunPass } from '../loop.js';
import { stageEvidence } from '../scoring-evidence.js';
import { attemptDir, AttemptIdSchema, attemptsDir, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import type { RunState, WorkflowFailure } from '../types.js';
import { type CopyContract, type WorkspaceContract } from '../workspace.js';
import { clearWorktreeHooks, headCommit, markReadCopy, markSetup, removeWorktree, reopenConfigConflicts, stepCheckout, worktreePath } from '../worktree.js';
import { adoptRefusal, takeAdopted } from './adopted.js';
import { cloneEnv, cloneKeyOf, commitClone, markCloneReady, openClone, preparedClone, removeClone, type CloneLease } from './clone.js';
import { openWorktree } from './created.js';
import { applyOverlay, restoreOverlay, unrestoredConfig } from './overlay.js';
import { cloneRoleProblem, launchedTools, releaseWorktreeRole, roleNotDeliveredFailure } from './role-copy.js';
import { finishReader, leaveReadCopy, readCopyFailure, stageReader } from './reader.js';
import { PlaceFinishedSchema, readPlaceRecord, writePlaceRecord, type PlaceRecord } from './record.js';
import { runSetup } from './setup.js';
import { finishTeamClone, openTeamClone, removeTeamClone, teamKeyOf } from './team.js';
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

export { attemptCloneHome, cloneDelivery, cloneHead, commitCacheOf, freshClone, preparedClone, scratchCloneRoot, stageSettledEvidence, sweepClones } from './clone.js';

export { cloneRoleProblem, roleNotDeliveredFailure, worktreeRoleProblem } from './role-copy.js';

/**
 * The place key two attempts of one driver must not share: the copy of the lease's branch, its clone, else the checkout.
 * A clone keeps its key once prepared, as its directory is not known before.
 */
export function placeOf(lease: { cwd?: string; workspace?: WorkspaceContract }, root: string): string {
  if ((lease.workspace?.mode === 'new' || lease.workspace?.mode === 'continue') && lease.workspace.clone) return cloneKeyOf(lease.workspace.branch);

  if (lease.workspace?.mode === 'team') return teamKeyOf(lease.workspace.branch);

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
  const places = new Set([placeOf(lease, path.resolve(input.root)), ...(hosted !== undefined ? [hosted] : []), ...(adopt !== undefined ? [path.resolve(adopt)] : [])]);

  for (const other of input.others) {
    const read = await readPlaceRecord(config, run, other);
    const recorded = read.kind === 'found' ? read.record : undefined;

    if (!recorded || recorded.phase === 'finished' || recorded.phase === 'abandoned') continue;

    if (places.has(recorded.dir)) return { behind: other, dir: recorded.dir };
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

/**
 * The lease fields a place reads. Its `expiresAt` bounds setup. A clone gets the step's `tool` installed, for its
 * `role` when it has one, and keeps `envScope.withhold` from its git and its install.
 */
export type PlaceLease = Pick<LeaseWire, 'attempt' | 'step' | 'prompt' | 'interactive' | 'readOnly' | 'workspace' | 'setup' | 'expiresAt' | 'tool' | 'role' | 'envScope'> & { executor: 'command' | 'prompt' };

/** The place fields of `lease`, a lease `next` answered with. */
export function placeLeaseOf(lease: LeaseWire): PlaceLease {
  const { attempt, step, command, prompt, interactive, readOnly, workspace, setup, expiresAt, tool, role, envScope } = lease;

  const place: PlaceLease = { attempt, step, executor: command !== undefined ? 'command' : 'prompt' };

  if (prompt !== undefined) place.prompt = prompt;

  if (tool !== undefined) place.tool = tool;

  if (role !== undefined) place.role = role;

  if (envScope) place.envScope = envScope;

  if (interactive) place.interactive = true;

  if (readOnly) place.readOnly = true;

  if (workspace) place.workspace = workspace;

  if (setup) place.setup = setup;

  if (expiresAt !== undefined) place.expiresAt = expiresAt;

  return place;
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
interface PlaceFiles {
  snapshot: string;
  overlay: string;
}

function placeFiles(config: LocalConfig, run: RunId, attempt: AttemptId): PlaceFiles {
  const dir = attemptDir(config, run, attempt);

  return { snapshot: path.join(dir, 'before.json'), overlay: path.join(dir, 'overlay') };
}

function preparedOf(record: Placed, prompt: string | undefined): PlacePrepared {
  const note = record.place.role === 'writer' ? record.place.conflictNote ?? '' : '';

  const prepared: Extract<PlacePrepared, { kind: 'prepared' }> = { kind: 'prepared', dir: record.dir };

  if (prompt !== undefined) prepared.prompt = `${prompt}${note}`;

  return prepared;
}

function baseOf(record: Placed): PlaceRecordBase {
  const { version, run, attempt, step, executor, root, dir, adopted, interactive, readOnly, place } = record;

  const base: PlaceRecordBase = { version, run, attempt, step, executor, root, dir, place };

  if (adopted) base.adopted = adopted;

  if (interactive) base.interactive = interactive;

  if (readOnly) base.readOnly = readOnly;

  return base;
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

  const { workspace } = lease;

  if (workspace?.mode === 'team') return prepareTeam({ config, run, root, lease, workspace, recorded });

  if (workspace && workspace.mode !== 'read-only' && workspace.clone) {
    return prepareClone({ config, run, root, lease, workspace: { ...workspace, clone: workspace.clone }, recorded });
  }

  const reopened = recorded?.phase === 'opening' ? recorded : undefined;
  const hosted = workspace ? await adoptedPlaceOf({ config, run, branch: workspace.branch }) : undefined;
  // A prepare killed while it adopted a place goes on in that place.
  const asked = input.adopt !== undefined ? path.resolve(input.adopt) : reopened?.adopted ? reopened.dir : undefined;
  const refusal = await adoptRefusal({ root, run, recorded, lease, adopt: asked, hosted });

  if (refusal !== undefined) return { kind: 'refused', failure: { code: 'adopt_mismatch', message: refusal } };
  const result = await recordedResult(config, recorded, lease);

  if (result) return result;

  const base: OpeningBase = { version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root };

  if (lease.interactive) base.interactive = true;

  if (lease.readOnly) base.readOnly = true;

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

/**
 * Prepares the clone `workspace` names: the one an earlier step prepared, or a fresh one, which is set up when the lease
 * carries setup. A clone this attempt made and could not prepare is given up with it, and one it made before it was
 * prepared again is replaced.
 */
async function prepareClone(input: {
  config: LocalConfig; run: RunId; root: string; lease: PlaceLease; recorded: PlaceRecord | undefined;
  workspace: Extract<WorkspaceContract, { mode: 'new' | 'continue' }> & { clone: NonNullable<Extract<WorkspaceContract, { mode: 'new' | 'continue' }>['clone']> };
}): Promise<PlacePrepared> {
  const { config, run, root, lease, workspace, recorded } = input;

  // An attempt prepared again made its clone, and what it ran there before is not this run of it: it gets a fresh one.
  if (recorded && recorded.phase !== 'opening' && recorded.phase !== 'abandoned' && recorded.place.role === 'clone' && recorded.place.created) {
    await removeClone(config, run, workspace.branch);
  } else {
    const result = await recordedResult(config, recorded, lease);

    if (result) return result;
  }

  const base: OpeningBase = { version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root };

  if (lease.interactive) base.interactive = true;

  // No opening record: the clone's receipt names its root before anything under it exists, for the sweep.
  const withhold = lease.envScope?.withhold ?? [];

  const cloneLease: CloneLease = { attempt: lease.attempt, step: lease.step, executor: lease.executor, branch: workspace.branch, clone: workspace.clone, start: workspace.start.commit, withhold };

  if (lease.tool !== undefined) cloneLease.tool = lease.tool;

  if (lease.role !== undefined) cloneLease.role = lease.role;

  if (lease.expiresAt !== undefined) cloneLease.expiresAt = lease.expiresAt;
  const opened = await openClone({ config, run, checkout: root, lease: cloneLease });
  const place: CloneRole = { role: 'clone', workspace, rangeFrom: workspace.start.commit, withhold };

  if ('created' in opened && opened.created) place.created = true;

  if (lease.expiresAt !== undefined) place.expiresAt = lease.expiresAt;

  const { dir } = opened;

  if ('failure' in opened) {
    await removeClone(config, run, workspace.branch);
    await writePlaceRecord(config, { ...base, dir, place, phase: 'abandoned', at: new Date().toISOString() });

    return { kind: 'failed', failure: opened.failure };
  }

  // A later step in the clone launches tools of its own, which the clone's setup checked the role for only when its
  // first step launched them.
  if (!opened.created && lease.role !== undefined) {
    const { role, step } = lease;
    const install = (await preparedClone(config, run, workspace.branch))?.install;

    const refused = install
      ? await cloneRoleProblem({ install, step, role, tools: launchedTools({ executor: lease.executor, tool: lease.tool, enabled: install.enabledAgents ?? [] }) })
      : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap: { kind: 'no_install' } } });

    if (refused !== undefined) {
      await writePlaceRecord(config, { ...base, dir, place, phase: 'abandoned', at: new Date().toISOString() });

      return { kind: 'failed', failure: refused };
    }
  }

  if (opened.created && lease.setup) {
    const staged: Extract<PlaceRecord, { phase: 'staged' }> = { ...base, dir, place, phase: 'staged', setup: lease.setup };

    if (lease.expiresAt !== undefined) staged.expiresAt = lease.expiresAt;
    await writePlaceRecord(config, staged);

    return preparedOf(staged, lease.prompt);
  }

  if (opened.created) await markCloneReady(config, run, workspace.branch);
  const ready: Placed = { ...base, dir, place, phase: 'ready' };
  await writePlaceRecord(config, ready);

  return preparedOf(ready, lease.prompt);
}

/**
 * Prepares the team clone `workspace` names, made afresh for every attempt so it starts from origin as it is now. A
 * second prepare of the attempt answers with the clone recorded ready.
 */
async function prepareTeam(input: {
  config: LocalConfig; run: RunId; root: string; lease: PlaceLease; recorded: PlaceRecord | undefined; workspace: Extract<WorkspaceContract, { mode: 'team' }>;
}): Promise<PlacePrepared> {
  const { config, run, root, lease, workspace, recorded } = input;

  if (recorded?.phase === 'ready' && recorded.place.role === 'team') return preparedOf(recorded, lease.prompt);
  const opened = await openTeamClone({ config, run, step: lease.step, branch: workspace.branch });

  const base: OpeningBase = {
    version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root,
  };

  if (lease.interactive) base.interactive = true;

  if ('code' in opened) {
    await removeTeamClone(config, run, workspace.branch);

    return { kind: 'failed', failure: opened };
  }

  const { dir, root: clone, base: commit, start, found } = opened;
  const ready: Placed = { ...base, dir, place: { role: 'team', workspace, clone, base: commit, start, found }, phase: 'ready' };
  await writePlaceRecord(config, ready);

  return preparedOf(ready, lease.prompt);
}

/** The place a prepare recorded for the attempt before, unless it gave the place up or left its git undone. */
async function recordedResult(config: LocalConfig, recorded: PlaceRecord | undefined, lease: OverlaidLease): Promise<PlacePrepared | undefined> {
  if (recorded === undefined || recorded.phase === 'abandoned' || recorded.phase === 'opening') return undefined;

  return recorded.phase === 'preparing' ? overlaid(config, recorded, lease, { resume: true }) : preparedOf(recorded, lease.prompt);
}

/**
 * Opens the copy of `workspace.branch`: `reopened`, the one a killed prepare recorded `opening`, else `adopt`, else the
 * worktree of the branch. `hosted` is the place the host made that the branch's last attempt finished in. The
 * `opening` record comes before git touches the copy.
 */
async function openCopy(input: {
  config: LocalConfig; base: OpeningBase; lease: PlaceLease; workspace: CopyContract; reopened: Opening | undefined; adopt: string | undefined; hosted: string | undefined;
}): Promise<{ opening: Opening; dir: string; created: boolean } | WorkflowFailure> {
  const { config, base, lease, workspace, reopened, adopt, hosted } = input;
  let opening: Opening;

  if (reopened) opening = reopened;
  else if (adopt !== undefined) {
    // A place an earlier attempt set up for the branch is not set up again, as a worktree TeamAI made is not.
    const adopting: Opening = { ...base, dir: adopt, phase: 'opening' };

    if (adopt !== hosted) adopting.created = true;
    adopting.adopted = true;
    opening = adopting;
    await writePlaceRecord(config, opening);
  } else {
    const dir = worktreePath(base.root, workspace.branch);
    const present = await fs.stat(dir).then(() => true, () => false);
    const making: Opening = { ...base, dir, phase: 'opening' };

    if (!present) making.created = true;
    opening = making;
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
  config: LocalConfig; base: OpeningBase; lease: PlaceLease; workspace: CopyContract; opening: Opening; dir: string; created: boolean;
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
    const range: Pick<Writer, 'rangeFrom'> = {};

    if (rangeFrom) range.rangeFrom = rangeFrom;
    const writer: Writer = { role: 'writer', workspace, ...range, conflicts: {} };

    if (merged.note) writer.conflictNote = merged.note;
    place = writer;
  }

  const preparing: Preparing = { ...base, dir, place, phase: 'preparing' };

  if (opening.adopted) preparing.adopted = true;

  if (lease.setup && created) {
    preparing.setup = lease.setup;

    if (lease.expiresAt !== undefined) preparing.expiresAt = lease.expiresAt;
  }

  await writePlaceRecord(config, preparing);

  return overlaid(config, preparing, lease);
}

/** What the overlay of a lease's copy reads of it: the prompt it adds to, and the role and tool it delivers for. */
type OverlaidLease = Pick<PlaceLease, 'prompt' | 'role' | 'tool'>;

type Opening = Extract<PlaceRecord, { phase: 'opening' }>;

type Preparing = Extract<PlaceRecord, { phase: 'preparing' }>;

type Writer = Extract<Preparing['place'], { role: 'writer' }>;

type CloneRole = Extract<Placed['place'], { role: 'clone' }>;

/** The fields every record of a lease's place shares, before its copy is known. */
type OpeningBase = Omit<PlaceRecordBase, 'dir' | 'place'>;

/**
 * Puts the base overlay over the copy of a place recorded `preparing`, then leaves it staged for its setup, or ready.
 * `resume` finishes an overlay a killed prepare left. An overlay git refused leaves the copy as prepare found it.
 */
async function overlaid(config: LocalConfig, record: Preparing, lease: OverlaidLease, resume: { resume?: true } = {}): Promise<PlacePrepared> {
  const { root, dir, place, setup, expiresAt, step, executor } = record;
  const { prompt, role, tool } = lease;

  const failure = await applyOverlay({
    root, dir, configCommit: place.workspace.configCommit, saved: placeFiles(config, record.run, record.attempt).overlay, step, executor, role, tool, ...resume,
  });

  if (failure) {
    await writePlaceRecord(config, { ...baseOf(record), phase: 'abandoned', at: new Date().toISOString() });

    return { kind: 'failed', failure };
  }

  if (setup) {
    const staged: Extract<PlaceRecord, { phase: 'staged' }> = { ...baseOf(record), phase: 'staged', setup };

    if (expiresAt !== undefined) staged.expiresAt = expiresAt;
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
    case 'clone':
    case 'team':
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
 * Runs the setup of a place `preparePlace` left `staged`, with the team env resolved for it, then makes it ready.
 * Setup gets its own keys and none of the step's, the attempt marker and the run's `mode`. `signal` stops setup, which then fails, and the worktree it was
 * preparing is removed, or, when the host made it, gets the branch agent files back. Nothing to do for any other place.
 */
export async function runPlaceSetup(input: { config: LocalConfig; run: RunId; attempt: AttemptId; mode: RunMode; env: Pick<WorkflowEnv, 'values' | 'facts'>; signal?: AbortSignal }): Promise<WorkflowFailure | undefined> {
  const { config, run, attempt, mode, env, signal } = input;
  const read = await readPlaceRecord(config, run, attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;

  if (recorded?.phase !== 'staged') return undefined;
  const { setup, expiresAt } = recorded;
  const scope = setup.envScope ?? { provide: [], withhold: [] };
  const scoped = await stepEnvironment(env, scope);

  if (!scoped.ok) return setupFailed(config, recorded, scoped.failure);
  // The mark stays in the place until setup finishes, so a place the host made is not adopted again after a setup that did not.
  await markSetup(recorded.dir, 'unfinished');
  const settingUp: SettingUp = { ...baseOf(recorded), phase: 'setting-up' };
  await writePlaceRecord(config, settingUp);
  const failure = await runSetup({ command: setup.command, dir: recorded.dir, env: { ...scoped.env, ...attemptEnv(run, attempt, mode) }, keys: scope.provide, signal, groupDir: attemptDir(config, run, attempt), expiresAt });

  if (failure) return setupFailed(config, settingUp, failure);
  await markSetup(recorded.dir, 'finished');

  if (recorded.place.role === 'clone') await markCloneReady(config, run, recorded.place.workspace.branch);
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

  // A copy's role goes before the copy does, as its entry is keyed by the copy's real path. A clone's goes with its root.
  if (isWorktreeCopy(place)) await releaseWorktreeRole(dir);

  if (place.role === 'clone') await removeClone(config, record.run, place.workspace.branch);
  else if (place.role === 'team') await removeTeamClone(config, record.run, place.workspace.branch);
  else if (record.adopted && place.role !== 'checkout') {
    unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: overlay });
    await clearWorktreeHooks(dir);
  } else await removeWorktree(record.root, dir);
  await fs.rm(overlay, { recursive: true, force: true });
  const abandoned: PlaceRecord = { ...baseOf(record), phase: 'abandoned', at: new Date().toISOString() };
  await writePlaceRecord(config, abandoned);

  return unrestored ? { abandoned, unrestored: unrestoredConfig(unrestored, dir) } : { abandoned };
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

/**
 * Stages, from the clone attempt `attempt` ran in, the evidence the judges of its pass read, before `report`, the
 * report finishing the place made of it, settles the pass: the clone may be gone once it does. Answers the directory
 * staged, which the caller removes when the pass does not settle `success`.
 */
export async function stagePassEvidence(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId; report: ReportInput }): Promise<string | undefined> {
  const { config, lock, attempt, report } = input;

  if (report.outcome !== 'success') return undefined;
  const ran = await cloneRan(config, lock.run, attempt);
  const leased = ran && ran.run.steps.find((step) => step.status === 'leased' && step.attempt === attempt);

  if (!ran || !leased) return undefined;
  const pass = leased.pass ?? 1;

  const settling: RunPass = { step: leased.id, pass, attempt, outcome: 'success', tool: report.tool, session: report.session };

  if (report.changes) settling.changes = report.changes;

  if (report.outputs !== undefined) settling.outputs = report.outputs;

  return stageEvidence(config, ran.run, { runId: lock.run, step: leased.id, pass }, { ...ran.source, settling });
}

/** How git reads a clone: in its checkout, with the environment it gets there, until the place's deadline. */
interface CloneSource {
  checkout: string;
  untrustedEnv: NodeJS.ProcessEnv;
  expiresAt?: string;
}

/** The clone attempt `attempt` ran in, when its place is one, the run read now, and how git reads the clone. */
async function cloneRan(config: LocalConfig, runId: RunId, attempt: AttemptId): Promise<{ run: RunState; source: CloneSource } | undefined> {
  const read = await readPlaceRecord(config, runId, attempt);
  const place = read.kind === 'found' && read.record.phase !== 'opening' ? read.record.place : undefined;

  if (read.kind !== 'found' || place?.role !== 'clone') return undefined;
  const [run, scoped] = await Promise.all([readRun(config, runId), cloneEnv(place.withhold)]);

  if (run === 'missing' || run === 'corrupt' || !scoped.ok) return undefined;
  const source: CloneSource = { checkout: read.record.dir, untrustedEnv: scoped.env };

  if (place.expiresAt !== undefined) source.expiresAt = place.expiresAt;

  return { run, source };
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

async function finishRole(files: PlaceFiles, record: Placed, end: StepEnd): Promise<PlaceFinished> {
  const { place, dir, step, executor } = record;

  switch (place.role) {
    case 'checkout': {
      const failure = await finishReader({
        dir, file: files.snapshot, executor, outcome: end.outcome,
        interactive: record.interactive ? true : undefined, readOnly: record.readOnly ? true : undefined,
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

      const finished: PlaceFinished = { ...end, message: copy.message };

      if (end.failure) finished.failure = { ...end.failure, message: copy.message };
      finished.read = left.read;

      return finished;
    }

    case 'team': {
      const finished = await finishTeamClone({ root: place.clone, dir, step, branch: place.workspace.branch, base: place.base, start: place.start, found: place.found });

      return 'code' in finished ? { outcome: 'failed', message: finished.message, failure: finished } : { ...end, changes: finished.changes };
    }

    case 'clone': {
      const committed = await commitClone({
        dir, branch: place.workspace.branch, step, base: place.workspace.base.commit, start: place.rangeFrom, withhold: place.withhold, expiresAt: place.expiresAt,
      });

      return 'code' in committed ? { outcome: 'failed', message: committed.message, failure: committed } : { ...end, changes: committed.changes };
    }

    case 'writer': {
      const written = await finishWriter({
        dir, step, workspace: place.workspace, conflicts: place.conflicts, saved: files.overlay, failed: end.outcome === 'failed', rangeFrom: place.rangeFrom,
      });

      const changes = written.changes ? { changes: written.changes } : {};

      if (written.failure) return { outcome: 'failed', message: written.failure.message, failure: written.failure, ...changes };

      if (!written.unpushed) return { ...end, ...changes };

      const finished: PlaceFinished = { ...end, message: withUnpushed(end.message ?? end.failure?.message ?? 'Step failed', written.unpushed) };

      if (end.failure) finished.failure = { ...end.failure, message: withUnpushed(end.failure.message, written.unpushed) };

      return { ...finished, ...changes };
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
    case 'clone':
      // A clone this attempt made has no step's work yet, so the next attempt gets a fresh one.
      if (place.created) await removeClone(config, run, place.workspace.branch);
      break;
    case 'team':
      // The next attempt clones the team repo again, so nothing here is kept.
      await removeTeamClone(config, run, place.workspace.branch);
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

/** Whether `place` is a worktree copy, a reader's or a writer's, which runs with its own role, rather than the checkout or a clone. */
function isWorktreeCopy(place: Extract<PlaceRecord, { place: unknown }>['place']): boolean {
  switch (place.role) {
    case 'reader':
    case 'writer':
      return true;
    case 'checkout':
    case 'clone':
    case 'team':
      return false;
    default: {
      const unhandled: never = place;

      return unhandled;
    }
  }
}

/**
 * The team a prompt of `tool` gets in the worktree copy `attempt` was prepared in, as teamai reads it from the copy's own
 * pull record, the role it was delivered for included. Undefined when the attempt has no such copy, or it has no record.
 */
export async function preparedCopyTeam(input: { config: LocalConfig; run: RunId; attempt: AttemptId; tool: string }): Promise<PreparedAgent['team']> {
  const read = await readPlaceRecord(input.config, input.run, input.attempt);
  const recorded = read.kind === 'found' && read.record.phase !== 'opening' ? read.record : undefined;

  if (recorded === undefined || !isWorktreeCopy(recorded.place)) return undefined;
  const install = await detectProjectConfig(recorded.dir).catch(() => null);

  if (install?.scope !== 'project') return undefined;

  return (await observeCheckout({ config: install, tool: input.tool, cwd: recorded.dir })).team;
}

/** Whether `preparePlace` recorded a place for `attempt`, readable or not. */
export async function placeRecorded(input: { config: LocalConfig; run: RunId; attempt: AttemptId }): Promise<boolean> {
  return (await readPlaceRecord(input.config, input.run, input.attempt)).kind !== 'missing';
}

/**
 * After an accepted success with `cleanup`: removes the worktree prepare created, and the role it ran with. A step in
 * the checkout leaves it, and so does one in a place the host made, a reader's included.
 */
export async function releasePlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<'removed' | 'left'> {
  const read = await readPlaceRecord(input.config, input.lock.run, input.attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;

  if (recorded?.phase !== 'opening' && recorded?.place.role === 'team') {
    await removeTeamClone(input.config, input.lock.run, recorded.place.workspace.branch);

    return 'removed';
  }

  if (!recorded || recorded.phase === 'opening' || !isWorktreeCopy(recorded.place)) return 'left';
  // The role it ran with goes with the copy, and from a place the host made, which it leaves.
  await releaseWorktreeRole(recorded.dir);

  if (recorded.adopted) return 'left';
  await removeWorktree(recorded.root, recorded.dir);

  return 'removed';
}
