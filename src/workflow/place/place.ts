import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stepEnvironment } from '../../env-exec.js';
import type { WorkflowEnv } from '../../env-resolution.js';
import { observeCheckout, type PreparedAgent } from '../../agent-observation.js';
import { detectProjectConfig } from '../../config.js';
import type { RunMode } from '../../launch-context.js';
import { isDataBranch, type LocalConfig } from '../../types.js';
import { log } from '@teamai/shared/log';
import { gitCommonDir } from '../../utils/git.js';
import { redactJson } from '@teamai/shared/redact';
import { parseJson } from '@teamai/shared/json';
import { attemptEnv } from '../attempt-marker.js';
import type { LeaseWire } from '../lease-wire.js';
import type { ReportInput } from '../engine.js';
import type { RunPass } from '../loop.js';
import { stageEvidence } from '../../scorers/engine-hooks.js';
import { attemptDir, AttemptIdSchema, attemptsDir, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import type { RunState, WorkflowFailure } from '../types.js';
import { type CopyContract, type WorkspaceContract } from '../workspace.js';
import { clearWorktreeHooks, headCommit, hostGitEnv, markReadCopy, markSetup, readMemberConfig, releaseReadCopy, removeWorktree, reopenConfigConflicts, stepCheckout, unchangedOverlayPaths, untrustedGit, worktreePath, type MemberConfig, type UntrustedGit } from '../worktree.js';
import { adoptRefusal, takeAdopted } from './adopted.js';
import { cloneEnv, cloneKeyOf, commitClone, markCloneReady, openClone, preparedClone, removeClone, type CloneLease } from './clone.js';
import { openWorktree } from './created.js';
import { applyOverlay, restoreOverlay, unrestoredConfig } from './overlay.js';
import { cloneRoleProblem, launchedTools, releaseWorktreeRole, roleNotDeliveredFailure } from './role-copy.js';
import { finishReader, leaveReadCopy, readCopyFailure, stageReader } from './reader.js';
import { PlaceFinishedSchema, readPlaceRecord, writePlaceRecord, type PlaceRecord } from './record.js';
import { runSetup, type SetupElsewhere, type SetupExit } from './setup.js';
import { finishTeamClone, openTeamClone, removeTeamClone, teamKeyOf } from './team.js';
import { finishDataCheckout, openDataCheckout, removeDataCheckout } from './data.js';
import { commitPathsOf } from './worktree-snapshot.js';
import { finishWriter, mergeBranches, recordMergePreparation, rememberConflicts, unreportedChangesMessage, withUnpushed } from './writer.js';
import { readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';
import { retryCommand } from '../runtimes/retry-command.js';

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

export { attemptCloneHome, cloneDelivery, cloneHead, commitCacheOf, firstUnreachable, freshClone, preparedClone, scratchCloneRoot, stageSettledEvidence, sweepClones } from './clone.js';

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
 * The attempt among `others` that holds the place `lease` would get under `root`, the place the session host made for its
 * branch, or the place the session host made at `adopt`, with the place it holds: one whose prepare began there and whose place
 * is not finished or given up, so a prepare killed before its git was done still holds it. Two attempts of one driver
 * never share a place.
 */
export async function placeHeldBy(input: { config: LocalConfig; run: RunId; root: string; lease: Pick<PlaceLease, 'workspace'>; others: AttemptId[]; adopt?: string }): Promise<{ behind: AttemptId; dir: string } | undefined> {
  const { config, run, lease, adopt } = input;
  const sessionHostPlace = lease.workspace ? await adoptedPlaceOf({ config, run, branch: lease.workspace.branch }) : undefined;
  const places = new Set([placeOf(lease, path.resolve(input.root)), ...(sessionHostPlace !== undefined ? [sessionHostPlace] : []), ...(adopt !== undefined ? [path.resolve(adopt)] : [])]);

  for (const other of input.others) {
    const read = await readPlaceRecord(config, run, other);
    const recorded = read.kind === 'found' ? read.record : undefined;

    if (!recorded || recorded.phase === 'finished' || recorded.phase === 'abandoned' || recorded.phase === 'retired' || recorded.phase === 'kept') continue;

    if (places.has(recorded.dir)) return { behind: other, dir: recorded.dir };
  }

  return undefined;
}

/**
 * The place the session host made that the last attempt of `run` to finish on `branch` was prepared in: every later lease on
 * that branch goes on there while it passes the adopt checks, as one goes on in a worktree TeamAI made.
 */
export async function adoptedPlaceOf(input: { config: LocalConfig; run: RunId; branch: string }): Promise<string | undefined> {
  const { config, run, branch } = input;
  let last: { dir: string; at: string } | undefined;

  for (const name of await fs.readdir(attemptsDir(config, run)).catch(() => [])) {
    const attempt = AttemptIdSchema.safeParse(name);
    const read = attempt.success ? await readPlaceRecord(config, run, attempt.data) : undefined;
    const recorded = read?.kind === 'found' ? read.record : undefined;

    if (!recorded || recorded.phase !== 'finished' || !recorded.adopted || recorded.place.role === 'checkout' || recorded.place.role === 'data') continue;

    if (recorded.place.workspace.branch === branch && (last === undefined || recorded.at > last.at)) last = { dir: recorded.dir, at: recorded.at };
  }

  return last?.dir;
}

/**
 * The lease fields a place reads. Its `expiresAt` bounds setup. A clone gets the step's `tool` installed, for its
 * `role` when it has one, and keeps `envScope.withhold` from its git and its install.
 */
export type PlaceLease = Pick<LeaseWire, 'attempt' | 'step' | 'prompt' | 'answer' | 'interactive' | 'readOnly' | 'writes' | 'workspace' | 'setup' | 'expiresAt' | 'tool' | 'role' | 'envScope'> & { executor: 'command' | 'prompt' };

/** The place fields of `lease`, a lease `next` answered with. */
export function placeLeaseOf(lease: LeaseWire): PlaceLease {
  const { attempt, step, command, prompt, answer, interactive, readOnly, writes, workspace, setup, expiresAt, tool, role, envScope } = lease;

  const place: PlaceLease = { attempt, step, executor: command !== undefined ? 'command' : 'prompt' };

  if (prompt !== undefined) place.prompt = prompt;

  if (answer) place.answer = true;

  if (writes) place.writes = writes;

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
 * when the place the session host made cannot be adopted, which leaves the attempt as it was.
 */
export type PlacePrepared =
  | { kind: 'prepared'; dir: string; prompt?: string }
  | { kind: 'failed'; failure: WorkflowFailure }
  | { kind: 'refused'; failure: WorkflowFailure & { code: 'adopt_mismatch' } };

/** A record of a place whose git is done, from `preparing` on. */
type Placed = Exclude<PlaceRecord, { phase: 'opening' }>;

/** A record of every phase but its phase fields. */
type PlaceRecordBase = Omit<Extract<PlaceRecord, { phase: 'ready' }>, 'phase'>;

/** A place an attempt released after its tool ran keeps for the step's next attempt. */
type KeptPlace = Extract<PlaceRecord, { phase: 'kept' }>;

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
  const { version, run, attempt, step, executor, root, dir, adopted, interactive, readOnly, writes, keptFrom, place } = record;

  const base: PlaceRecordBase = { version, run, attempt, step, executor, root, dir, place };

  if (adopted) base.adopted = adopted;

  if (interactive) base.interactive = interactive;

  if (readOnly) base.readOnly = readOnly;

  if (writes) base.writes = writes;

  if (keptFrom) base.keptFrom = keptFrom;

  return base;
}

/** Whether `recorded` is a place whose setup was cut short, which a prepare gives up with its folder and makes again. */
function isCutShort(recorded: PlaceRecord | undefined): recorded is SettingUp {
  return recorded?.phase === 'setting-up';
}

/**
 * Whether the next prepare of `attempt` gives up a setup a teamai before this one cut short, making its folder again
 * (`preparePlace`): a runtime that mounted the old folder must close its place first.
 */
export async function isSetupCutShort({ config, run, attempt }: { config: LocalConfig; run: RunId; attempt: AttemptId }): Promise<boolean> {
  const read = await readPlaceRecord(config, run, attempt);

  return read.kind === 'found' && isCutShort(read.record);
}

/**
 * Prepares the place of `lease` under `root`, the checkout the run started from, and records it in
 * `attempts/<a>/place.json`, so any process can finish it. A lease without a workspace contract runs in `root`. Any
 * other gets the worktree of its branch, with its start, merges and the base agent configuration in place, and setup
 * left to `runPlaceSetup`. A second prepare of the attempt returns the recorded place, unless it was abandoned: then
 * the place is as prepare found it, and a resumed lease whose step stopped prepares it again. A prepare killed before
 * the place is ready is finished by the next. With `adopt`, a writer's copy is the place the session host made there, once
 * `adoptRefusal` accepts it. Without it, a lease on a branch whose last attempt finished in a place the session host made goes
 * on there while that place passes the same checks, and TeamAI makes the copy once it does not.
 */
export async function preparePlace(input: { config: LocalConfig; lock: RunLock; root: string; lease: PlaceLease; adopt?: string }): Promise<PlacePrepared> {
  const { config, lock: { run }, lease } = input;
  const root = path.resolve(input.root);
  const read = await readPlaceRecord(config, run, lease.attempt);

  if (read.kind === 'unreadable') {
    return { kind: 'failed', failure: { code: 'workspace_base', message: `The place record of attempt ${lease.attempt} cannot be read (${read.reason}). Retry the step with ${retryCommand({ run, step: lease.step })}.` } };
  }

  let recorded = read.kind === 'found' ? read.record : undefined;
  const unkept = await keepMemberConfig(config, run, root);

  if (unkept) return { kind: 'failed', failure: unkept };

  if (isCutShort(recorded)) {
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
  const sessionHostPlace = workspace ? await adoptedPlaceOf({ config, run, branch: workspace.branch }) : undefined;
  // A prepare killed while it adopted a place goes on in that place.
  const asked = input.adopt !== undefined ? path.resolve(input.adopt) : reopened?.adopted ? reopened.dir : undefined;
  const refusal = await adoptRefusal({ root, run, recorded, lease, adopt: asked, sessionHostPlace });

  if (refusal !== undefined) return { kind: 'refused', failure: { code: 'adopt_mismatch', message: refusal } };
  const result = await recordedResult(config, recorded, lease);

  if (result) return result;

  const base: OpeningBase = { version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root };

  if (lease.interactive) base.interactive = true;

  if (lease.readOnly) base.readOnly = true;

  if (lease.writes) base.writes = lease.writes;

  if (!workspace) {
    await stageReader(root, placeFiles(config, run, lease.attempt).snapshot, await copyGit(config, { run, root }));
    const record: PlaceRecord = { ...base, dir: root, place: { role: 'checkout' }, phase: 'ready' };
    await writePlaceRecord(config, record);

    return preparedOf(record, lease.prompt);
  }

  const passedOver = !reopened && sessionHostPlace !== undefined ? await adoptRefusal({ root, run, recorded, lease, adopt: sessionHostPlace, sessionHostPlace }) : undefined;
  const goesOn = !reopened && sessionHostPlace !== undefined && passedOver === undefined;
  const adopt = asked ?? (goesOn ? sessionHostPlace : undefined);
  const opened = await openCopy({ config, base, lease, workspace, reopened, adopt, sessionHostPlace });

  // While the session host's place has the branch checked out, git refuses TeamAI's own worktree of it, so the failure leads with
  // why that place was passed over.
  const explained = (opening: WorkflowFailure): WorkflowFailure => adopt === undefined && sessionHostPlace !== undefined && passedOver !== undefined
    ? { ...opening, message: `TeamAI did not go on in ${sessionHostPlace}, the place the session host made for branch ${workspace.branch}: ${passedOver} Making its own worktree of the branch failed too: ${opening.message}` }
    : opening;

  const prepared: PlacePrepared = 'code' in opened ? { kind: 'failed', failure: explained(opened) } : await stageRole({ config, base, lease, workspace, ...opened });

  // The step does not run in a place the session host made whose prepare failed, so the session host's own hooks run there again.
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
  if (recorded && recorded.phase !== 'opening' && recorded.phase !== 'abandoned' && recorded.phase !== 'retired' && recorded.place.role === 'clone' && recorded.place.created) {
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
  // A clone an earlier attempt of the step kept is the one its receipt opened again, so this attempt goes on in it.
  const kept = opened.created ? undefined : await keptPlaceOf({ config, run, step: lease.step, holds: (held) => held.role === 'clone' && held.workspace.branch === workspace.branch });
  const ready: Placed = { ...base, dir, place, ...(kept && { keptFrom: kept.attempt }), phase: 'ready' };

  if (kept) return goOnInKept(config, ready, kept, lease.prompt);
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

  if (recorded?.phase === 'ready' && (recorded.place.role === 'team' || recorded.place.role === 'data')) return preparedOf(recorded, lease.prompt);

  const base: OpeningBase = {
    version: 1, run, attempt: lease.attempt, step: lease.step, executor: lease.executor, root,
  };

  if (lease.interactive) base.interactive = true;

  if (workspace.publish) {
    const { branch } = workspace;

    if (!isDataBranch(branch)) return { kind: 'failed', failure: { code: 'workspace_base', message: `Step "${lease.step}" publishes to ${branch}, which is not a teamai data branch. Publish to teamai-reports or teamai-learnings.` } };
    const kept = await keptPlaceOf({ config, run, step: lease.step, holds: (held) => held.role === 'data' && held.branch === branch });

    if (kept) return goOnInKept(config, readyInKept(base, kept), kept, lease.prompt);
    const { dir, at } = await openDataCheckout({ config, run, attempt: lease.attempt, branch });
    const ready: Placed = { ...base, dir, place: { role: 'data', branch, at }, phase: 'ready' };
    await writePlaceRecord(config, ready);

    return preparedOf(ready, lease.prompt);
  }

  const onBranch = (held: KeptPlace['place']): boolean => held.role === 'team' && held.workspace.branch === workspace.branch;
  const kept = await keptPlaceOf({ config, run, step: lease.step, holds: onBranch });

  if (kept) return goOnInKept(config, readyInKept(base, kept), kept, lease.prompt);

  // A run has one team clone per branch, and the fresh one replaces what another step's attempt kept there: that step starts afresh.
  for (const replaced of await keptPlacesOf({ config, run, holds: onBranch })) await retireKeptPlace(config, replaced);
  const opened = await openTeamClone({ config, run, step: lease.step, branch: workspace.branch });

  if ('code' in opened) {
    await removeTeamClone(config, run, workspace.branch);

    return { kind: 'failed', failure: opened };
  }

  const { dir, root: clone, base: commit, start, found } = opened;
  const ready: Placed = { ...base, dir, place: { role: 'team', workspace, clone, base: commit, start, found, withhold: lease.envScope?.withhold ?? [] }, phase: 'ready' };
  await writePlaceRecord(config, ready);

  return preparedOf(ready, lease.prompt);
}

/** The place a prepare recorded for the attempt before, unless it gave the place up or left its git undone. */
async function recordedResult(config: LocalConfig, recorded: PlaceRecord | undefined, lease: OverlaidLease): Promise<PlacePrepared | undefined> {
  if (recorded === undefined || recorded.phase === 'abandoned' || recorded.phase === 'retired' || recorded.phase === 'opening') return undefined;

  return recorded.phase === 'preparing' ? overlaid(config, recorded, lease, { resume: true }) : preparedOf(recorded, lease.prompt);
}

/**
 * Opens the copy of `workspace.branch`: `reopened`, the one a killed prepare recorded `opening`, else `adopt`, else the
 * worktree of the branch. `sessionHostPlace` is the place the session host made that the branch's last attempt finished in. The
 * `opening` record comes before git touches the copy.
 */
async function openCopy(input: {
  config: LocalConfig; base: OpeningBase; lease: PlaceLease; workspace: CopyContract; reopened: Opening | undefined; adopt: string | undefined; sessionHostPlace: string | undefined;
}): Promise<{ opening: Opening; dir: string; created: boolean } | WorkflowFailure> {
  const { config, base, lease, workspace, reopened, adopt, sessionHostPlace } = input;
  let opening: Opening;

  if (reopened) opening = reopened;
  else if (adopt !== undefined) {
    // A place an earlier attempt set up for the branch is not set up again, as a worktree TeamAI made is not.
    const adopting: Opening = { ...base, dir: adopt, phase: 'opening' };

    if (adopt !== sessionHostPlace) adopting.created = true;
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
    const marked = await markReadCopy(dir, { branch: workspace.branch, step: lease.step }, await copyGit(config, base));

    if ('error' in marked) return { kind: 'failed', failure: { code: 'workspace_base', message: `Step "${lease.step}" cannot mark workspace ${dir} as in use by a reader: ${marked.error}` } };
    place = { role: 'reader', workspace, found: marked.found };
  } else {
    const rangeFrom = opening.rangeFrom ?? (await headCommit(dir))?.commit;

    if (rangeFrom !== undefined && opening.rangeFrom === undefined) await writePlaceRecord(config, { ...opening, rangeFrom });
    const merged = await mergeBranches({ dir, git: await copyGit(config, base), run: base.run, step: lease.step, executor: lease.executor, merge: workspace.merge });

    if (merged.kind === 'failed') return merged;

    if (opening.adopted) {
      const unreadable = await recordMergePreparation(dir, await copyGit(config, base));

      if (unreadable) return { kind: 'failed', failure: { code: 'workspace_base', message: `Step "${lease.step}" could not list the merge in ${dir}, so the step did not run. Git said: ${unreadable}.` } };
    }

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

/**
 * The git teamai runs in a place's copy while it prepares and finishes it. A step ran there, or one of an earlier attempt
 * on the branch did, so no hook, fsmonitor or replacement its config names runs, and what it still starts, such as a
 * filter, gets only `hostGitEnv`. The programs `keepMemberConfig` kept for the run's checkout still run.
 */
export async function copyGit(config: LocalConfig, place: { run: RunId; root: string }): Promise<UntrustedGit> {
  return untrustedGit(hostGitEnv(), undefined, await keptConfig(config, place));
}

async function keptConfig(config: LocalConfig, place: { run: RunId; root: string }): Promise<MemberConfig> {
  return new Set((await readKeptConfig(config, place.run))[place.root]);
}

/** `runs/<run>/member-config.json`: the `MemberConfig` of each checkout the run's steps were placed from. */
const KeptConfigSchema = z.record(z.string(), z.array(z.string()));

function keptConfigPath(config: LocalConfig, run: RunId): string {
  return path.join(path.dirname(attemptsDir(config, run)), 'member-config.json');
}

async function readKeptConfig(config: LocalConfig, run: RunId): Promise<z.infer<typeof KeptConfigSchema>> {
  try {
    const parsed = KeptConfigSchema.safeParse(parseJson(await readRegularFile(keptConfigPath(config, run), 'utf8')));

    if (parsed.success) return parsed.data;
  } catch {
    // A run an older teamai started, or a file that does not parse, keeps nothing: each program its copies' config names is off.
  }

  return {};
}

/**
 * Keeps the `MemberConfig` of checkout `root` for the run, unless the run already did: every lease is prepared before
 * its step runs, so the first prepare from `root` reads the member's own config, before any step of the run could write it.
 */
async function keepMemberConfig(config: LocalConfig, run: RunId, root: string): Promise<WorkflowFailure | undefined> {
  const kept = await readKeptConfig(config, run);

  if (kept[root] !== undefined) return undefined;
  const read = await readMemberConfig(root);

  if ('error' in read) return { code: 'workspace_base', message: `teamai could not read the git config of ${root}, so the step did not run. Git said: ${read.error}.` };
  const file = keptConfigPath(config, run);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeRegularFile(file, `${JSON.stringify({ ...kept, [root]: read })}\n`);

  return undefined;
}

/** What the overlay of a lease's copy reads of it: the prompt it adds to, the role and tool it delivers for, and whether an answer, which gets none, reads the copy. */
type OverlaidLease = Pick<PlaceLease, 'prompt' | 'role' | 'tool' | 'answer'>;

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
  const { prompt, role, tool, answer } = lease;

  // An answer is one call teamai marks as its own, which runs no hook and gets its context from its prompt, so its
  // copy stays as the run's base commit has it, with no team files delivered into it.
  const failure = answer ? undefined : await applyOverlay({
    root, dir, configCommit: place.workspace.configCommit, saved: placeFiles(config, record.run, record.attempt).overlay, step, executor, role, tool, run: await copyGit(config, record), ...resume,
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
    case 'data':
      break;
    case 'reader': {
      const before = await stageReader(record.dir, files.snapshot, await copyGit(config, record));

      if (before.ok && before.head) break;
      const unrestored = await restoreOverlay({ dir: record.dir, configCommit: place.workspace.configCommit, saved: files.overlay, run: await copyGit(config, record) });
      await writePlaceRecord(config, { ...record, phase: 'abandoned', at: new Date().toISOString() });
      const message = `Step "${record.step}" could not read workspace ${place.workspace.branch}`;

      return { code: 'workspace_base', message: unrestored ? `${message}. ${unrestoredConfig(unrestored, record.dir)}` : message };
    }

    case 'writer':
      await reopenConfigConflicts(record.dir, files.overlay, await copyGit(config, record));
      settled = { ...record, place: { ...place, conflicts: await rememberConflicts(record.dir, await copyGit(config, record)) } };
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
 * Runs setup's command on a step runtime: with `env` set over the runtime's own environment, without `unset`, in `dir`,
 * and settles once setup's work is back in `dir`, or with why it is not. It stops when `signal` aborts.
 */
export type SetupOn = (setup: { command: string; dir: string; env: Record<string, string>; unset: string[]; signal: AbortSignal | undefined }) => Promise<SetupExit | { failure: WorkflowFailure }>;

/**
 * Runs the setup of a place `preparePlace` left `staged`, with the team env resolved for it, then makes it ready.
 * Setup gets its own keys and none of the step's, the attempt marker and the run's `mode`. `signal` stops setup, which then fails, and the worktree it was
 * preparing is removed, or, when the session host made it, gets the branch agent files back. Nothing to do for any other place.
 * `on` runs setup's command on the step's runtime instead of here: it gets setup's keys over the runtime's own
 * environment, without the names setup withholds, and brings setup's work back before the checks read it.
 */
export async function runPlaceSetup(input: { config: LocalConfig; run: RunId; attempt: AttemptId; mode: RunMode; env: Pick<WorkflowEnv, 'values' | 'facts'>; signal?: AbortSignal; on?: SetupOn }): Promise<WorkflowFailure | undefined> {
  const { config, run, attempt, mode, env, signal, on } = input;
  const read = await readPlaceRecord(config, run, attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;

  if (recorded?.phase !== 'staged') return undefined;
  const { setup, expiresAt } = recorded;
  const scope = setup.envScope ?? { provide: [], withhold: [] };
  const scoped = await stepEnvironment(env, scope);

  if (!scoped.ok) return setupFailed(config, recorded, scoped.failure);
  // The mark stays in the place until setup finishes, so a place the session host made is not adopted again after a setup that did not.
  await markSetup(recorded.dir, 'unfinished');
  const settingUp: SettingUp = { ...baseOf(recorded), phase: 'setting-up' };
  await writePlaceRecord(config, settingUp);
  const marker = attemptEnv(config, run, attempt, mode);
  const given = Object.fromEntries(scope.provide.flatMap((key) => (scoped.env[key] === undefined ? [] : [[key, scoped.env[key]]])));
  const elsewhere: SetupElsewhere | undefined = on && ((stop) => on({ command: setup.command, dir: recorded.dir, env: { ...given, ...marker }, unset: [...scope.withhold], signal: stop }));
  const failure = await runSetup({ command: setup.command, dir: recorded.dir, env: { ...scoped.env, ...marker }, keys: scope.provide, signal, groupDir: attemptDir(config, run, attempt), expiresAt, ...(elsewhere && { elsewhere }) });

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
 * the session host made gets the branch agent files back. `unrestored` is the sentence a failure adds when they are
 * not back, or when the worktree stays.
 */
async function giveUpSetup(config: LocalConfig, record: Extract<PlaceRecord, { phase: 'staged' }> | SettingUp): Promise<{ abandoned: PlaceRecord; unrestored?: string }> {
  const { place, dir } = record;
  const { overlay } = placeFiles(config, record.run, record.attempt);
  let unrestored: string | undefined;
  let kept: string | undefined;

  // A copy's role goes before the copy does, as its entry is keyed by the copy's real path. A clone's goes with its root.
  if (isWorktreeCopy(place)) await releaseWorktreeRole(dir);

  if (place.role === 'clone') await removeClone(config, record.run, place.workspace.branch);
  else if (place.role === 'team') await removeTeamClone(config, record.run, place.workspace.branch);
  else if (place.role === 'data') await removeDataCheckout(config, dir);
  else if (record.adopted && place.role !== 'checkout') {
    unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: overlay, run: await copyGit(config, record) });
    await clearWorktreeHooks(dir);
  } else {
    const removed = await removeWorktree(record.root, dir);

    // A prepare that started over would open this worktree again, setup half run.
    if (!removed.ok) kept = `Worktree ${dir} was not removed (${removed.reason}), so the step cannot start over in a fresh one. Fix that, then retry the step.`;
  }

  await fs.rm(overlay, { recursive: true, force: true });
  const abandoned: PlaceRecord = { ...baseOf(record), phase: 'abandoned', at: new Date().toISOString() };
  await writePlaceRecord(config, abandoned);

  if (kept !== undefined) return { abandoned, unrestored: kept };

  return unrestored ? { abandoned, unrestored: unrestoredConfig(unrestored, dir) } : { abandoned };
}

/**
 * The paths of place `dir` of `attempt` that git would commit, less the base agent files prepare put there that still
 * match the overlay it recorded: what the place holds that teamai did not deliver.
 */
export async function placeEditsOf(input: { config: LocalConfig; run: RunId; attempt: AttemptId; dir: string }): Promise<{ paths: string[] } | { error: string }> {
  const listed = await commitPathsOf(input.dir);

  if ('error' in listed) return listed;
  const overlay = await unchangedOverlayPaths(input.dir, placeFiles(input.config, input.run, input.attempt).overlay, listed.paths);

  return 'error' in overlay ? overlay : { paths: listed.paths.filter((relative) => !overlay.paths.has(relative)) };
}

/**
 * Why a command must not start in an adopted place, or undefined when it may. A file written after adopt, such as a
 * session host's background setup, is already there: the command does not run, and nothing is committed. The base agent files
 * prepare checked out over the branch are not that file when they still match the overlay it recorded. A file the
 * command itself writes during the run is still committed afterwards.
 */
export async function refuseDirtyAdoptedCommand(input: { config: LocalConfig; run: RunId; attempt: AttemptId }): Promise<WorkflowFailure | undefined> {
  const read = await readPlaceRecord(input.config, input.run, input.attempt);

  if (read.kind !== 'found' || read.record.phase !== 'ready' || !read.record.adopted || read.record.executor !== 'command') return undefined;
  const { dir, step } = read.record;
  const listed = await commitPathsOf(dir);

  if ('error' in listed) return { code: 'workspace_base', message: `Step "${step}" could not list changes in ${dir} before its command ran, so the command did not run. Git said: ${listed.error}.` };
  const overlay = await unchangedOverlayPaths(dir, placeFiles(input.config, input.run, input.attempt).overlay, listed.paths);

  if ('error' in overlay) return { code: 'workspace_base', message: `Step "${step}" could not read the base agent files recorded for ${dir} before its command ran, so the command did not run. ${overlay.error}` };
  const dirty = listed.paths.filter((relative) => !overlay.paths.has(relative)).toSorted((left, right) => left.localeCompare(right));

  if (dirty.length === 0) return undefined;

  return { code: 'unreported_changes', message: unreportedChangesMessage(step, dir, dirty, 'before its command ran, so the command did not run and nothing was committed or pushed.') };
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
export async function finishPlace(input: {
  config: LocalConfig;
  lock: RunLock;
  attempt: AttemptId;
  end: StepEnd;
  secrets: Record<string, string>;
  /**
   * Paths the skill child's result reported. The check runs only for an adopted writer when this is supplied, including
   * an empty list. A place TeamAI made ignores it and commits the tree.
   */
  changed?: readonly string[];
}): Promise<PlaceFinished> {
  const { config, lock: { run }, attempt, end, secrets } = input;
  const read = await readPlaceRecord(config, run, attempt);

  if (read.kind !== 'found') {
    const failure = { code: 'workspace_base', message: `The place record of attempt ${attempt} cannot be read (${read.kind === 'missing' ? 'it is missing' : read.reason}), so the step's changes cannot be checked.` };

    return { outcome: 'failed', message: failure.message, failure };
  }

  const recorded = read.record;

  if (recorded.phase === 'finished') return recorded.finished;

  // A setup that failed gave the place up, and a prepare that failed in git made none: the report carries that failure.
  // A setup a killed teamai left that its runtime could not stop may still write the place, which is kept as it is.
  if ((recorded.phase === 'abandoned' || recorded.phase === 'retired' || recorded.phase === 'opening' || recorded.phase === 'setting-up') && end.outcome === 'failed') return end;

  // A step that failed before its setup ran, as on a step runtime that could not open the place setup runs in, gives
  // the place up as a failed setup does: the report carries the step's own failure.
  if (recorded.phase === 'staged' && end.outcome === 'failed') {
    const { unrestored } = await giveUpSetup(config, recorded);

    if (!unrestored) return end;
    const message = `${end.message ?? end.failure?.message ?? ''} ${unrestored}`.trim();

    return { ...end, message, ...(end.failure && { failure: { ...end.failure, message } }) };
  }

  if (recorded.phase !== 'ready') {
    const failure = { code: 'workspace_base', message: `Step "${recorded.step}" has no place to finish: ${unfinishedPlace(recorded.phase)}.` };

    return { outcome: 'failed', message: failure.message, failure };
  }

  const files = placeFiles(config, run, attempt);

  // Whatever a role's finish throws, the place still ends: the member's copy given back as giving the place up gives it,
  // recorded finished, failed with why, its hooks cleared.
  const finished = await finishRole(config, files, recorded, end, input.changed).catch(async (cause: unknown): Promise<PlaceFinished> => {
    const why = `Step "${recorded.step}" could not finish its place: ${cause instanceof Error ? cause.message : String(cause)}`;
    let unrestored: string | undefined;

    try {
      unrestored = await giveBackCopy(config, files, recorded);
    } catch (error) {
      unrestored = error instanceof Error ? error.message : String(error);
    }

    const failure = { code: 'workspace_base', message: unrestored ? `${why} ${unrestoredConfig(unrestored, recorded.dir)}` : why };

    return { outcome: 'failed', message: failure.message, failure };
  });

  await writePlaceRecord(config, { ...baseOf(recorded), phase: 'finished', at: new Date().toISOString(), finished: PlaceFinishedSchema.parse(redactJson(finished, secrets)) });

  // Once the step's work is committed, the session host's own hooks run again in a place it made.
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
function unfinishedPlace(phase: 'opening' | 'preparing' | 'staged' | 'setting-up' | 'abandoned' | 'retired' | 'kept'): string {
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
    case 'kept':
      return 'the step was released after its tool ran, and its next attempt goes on there';
    case 'retired':
      return 'the step\'s next attempt went on in it, or a fresh place replaced it';
    default: {
      const unhandled: never = phase;

      return unhandled;
    }
  }
}

async function finishRole(config: LocalConfig, files: PlaceFiles, record: Placed, end: StepEnd, changed: readonly string[] | undefined): Promise<PlaceFinished> {
  const { place, dir, step, executor } = record;

  switch (place.role) {
    case 'checkout': {
      const failure = await finishReader({
        dir, run: await copyGit(config, record), file: files.snapshot, executor, outcome: end.outcome,
        interactive: record.interactive ? true : undefined, readOnly: record.readOnly ? true : undefined, writes: record.writes,
      });

      return failure ? { outcome: 'failed', message: failure.message, failure } : end;
    }

    case 'reader': {
      // The command did not run: the dirt was already in the adopted place. Putting the copy back would delete it.
      if (record.adopted && end.failure?.code === 'unreported_changes') {
        const unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: files.overlay, run: await copyGit(config, record) });
        await releaseReadCopy(dir);

        if (!unrestored) return end;
        const message = `${end.failure.message} ${unrestoredConfig(unrestored, dir)}`;

        return { outcome: 'failed', message, failure: { ...end.failure, message } };
      }

      const left = await leaveReadCopy({ dir, run: await copyGit(config, record), file: files.snapshot, workspace: place.workspace, found: place.found, saved: files.overlay, attempt: record.attempt, step });

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
      const scoped = await cloneEnv(place.withhold);

      if (!scoped.ok) return { outcome: 'failed', message: scoped.failure.message, failure: scoped.failure };

      const finished = await finishTeamClone({
        config, root: place.clone, dir, step, branch: place.workspace.branch, base: place.base, start: place.start, found: place.found, env: scoped.env,
      });

      return 'code' in finished ? { outcome: 'failed', message: finished.message, failure: finished } : { ...end, changes: finished.changes };
    }

    case 'data': {
      // A step that failed published nothing, and its checkout goes.
      if (end.outcome === 'failed') {
        await removeDataCheckout(config, dir);

        return end;
      }

      const finished = await finishDataCheckout({ config, dir, step, branch: place.branch, at: place.at });

      if ('code' in finished) return { outcome: 'failed', message: finished.message, failure: finished };

      return finished.message === undefined ? end : { ...end, message: finished.message };
    }

    case 'clone': {
      const committed = await commitClone({
        dir, branch: place.workspace.branch, step, base: place.workspace.base.commit, start: place.rangeFrom, withhold: place.withhold, expiresAt: place.expiresAt,
      });

      return 'code' in committed ? { outcome: 'failed', message: committed.message, failure: committed } : { ...end, changes: committed.changes };
    }

    case 'writer': {
      const written = await finishWriter({
        memberConfig: await keptConfig(config, record), dir, step, workspace: place.workspace, conflicts: place.conflicts, saved: files.overlay, failed: end.outcome === 'failed', rangeFrom: place.rangeFrom,
        reported: record.adopted && changed !== undefined ? changed : undefined,
        already: end.failure,
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

  if (!recorded || recorded.phase === 'finished' || recorded.phase === 'abandoned' || recorded.phase === 'retired' || recorded.phase === 'kept') return undefined;
  const { dir } = recorded;

  // Once the place is put back, the session host's own hooks run again in a place it made.
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
    const unrestored = await restoreOverlay({ dir, configCommit: recorded.place.workspace.configCommit, saved: files.overlay, unfinished: true, run: await copyGit(config, recorded) });
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
    case 'data':
      await removeDataCheckout(config, dir);
      break;
    case 'reader':
    case 'writer':
      unrestored = await giveBackCopy(config, files, recorded);
      break;
    default: {
      const unhandled: never = place;

      return unhandled;
    }
  }

  await writePlaceRecord(config, abandoned);

  return left(unrestored);
}

/**
 * Gives the member's copy a reader or writer place lies over back as prepare found it: teamai's overlay comes off, and a
 * reader's copy is put back and loses its mark. The sentence a failure adds when the overlay could not come off;
 * undefined for any other place. A writer's step ran in the copy, so its config may name a hook or fsmonitor.
 */
async function giveBackCopy(config: LocalConfig, files: PlaceFiles, record: Placed): Promise<string | undefined> {
  const { place, dir } = record;

  if (place.role !== 'reader' && place.role !== 'writer') return undefined;
  const unrestored = await restoreOverlay({ dir, configCommit: place.workspace.configCommit, saved: files.overlay, run: await copyGit(config, record) });

  // The copy keeps its mark while the branch agent files are not back, so later steps there are refused.
  if (place.role === 'reader' && !unrestored) await leaveReadCopy({ dir, run: await copyGit(config, record), file: files.snapshot, workspace: place.workspace, found: place.found, saved: files.overlay, attempt: record.attempt, step: record.step });

  return unrestored;
}

/**
 * Hands back the place of an attempt released after its tool ran, as on a usage limit. A clone, team clone or data
 * checkout keeps what the tool did there, and the step's next attempt goes on in it. Any other place is given up as
 * {@link abandonPlace} does: a copy of the checkout and the checkout itself keep their files through that.
 */
export async function keepPlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<string | undefined> {
  const { config, lock: { run }, attempt } = input;
  const read = await readPlaceRecord(config, run, attempt);
  const recorded = read.kind === 'found' && read.record.phase === 'ready' ? read.record : undefined;
  const place = recorded?.place;

  switch (place?.role) {
    case 'clone':
    case 'team':
    case 'data':
      if (recorded) await writePlaceRecord(config, { ...baseOf(recorded), place, phase: 'kept', at: new Date().toISOString() });

      return undefined;
    case 'checkout':
    case 'reader':
    case 'writer':
    case undefined:
      return abandonPlace(input);
    default: {
      const unhandled: never = place;

      return unhandled;
    }
  }
}

/**
 * Hands back the place of an attempt released before its tool started. One that went on in a place an earlier attempt
 * of the step kept still holds that attempt's work, so it is kept again for the next; any other is given up as
 * {@link abandonPlace} does.
 */
export async function releaseUnlaunchedPlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<string | undefined> {
  const read = await readPlaceRecord(input.config, input.lock.run, input.attempt);

  return read.kind === 'found' && read.record.keptFrom !== undefined ? keepPlace(input) : abandonPlace(input);
}

/** Every place an attempt of `run` kept when it was released after its tool ran that `holds` what an attempt needs. */
async function keptPlacesOf(input: { config: LocalConfig; run: RunId; holds: (place: KeptPlace['place']) => boolean }): Promise<KeptPlace[]> {
  const { config, run, holds } = input;
  const kept: KeptPlace[] = [];

  for (const name of await fs.readdir(attemptsDir(config, run)).catch(() => [])) {
    const attempt = AttemptIdSchema.safeParse(name);
    const read = attempt.success ? await readPlaceRecord(config, run, attempt.data) : undefined;
    const recorded = read?.kind === 'found' ? read.record : undefined;

    if (recorded?.phase === 'kept' && holds(recorded.place)) kept.push(recorded);
  }

  return kept;
}

/**
 * The place an earlier attempt of `step` kept when it was released after its tool ran, when it `holds` what this one needs
 * and is still there: the end of its run removes it, and a retry can reopen the run.
 */
async function keptPlaceOf(input: { config: LocalConfig; run: RunId; step: string; holds: (place: KeptPlace['place']) => boolean }): Promise<KeptPlace | undefined> {
  for (const kept of await keptPlacesOf(input)) {
    if (kept.step === input.step && await fs.stat(kept.dir).then(() => true, () => false)) return kept;
  }

  return undefined;
}

/** Gives up the place `kept` held, once the step's next attempt went on in it or a fresh place replaced it, so no later attempt goes on there. */
async function retireKeptPlace(config: LocalConfig, kept: KeptPlace): Promise<void> {
  await writePlaceRecord(config, { ...baseOf(kept), phase: 'retired', at: new Date().toISOString() });
}

/** This attempt's place, ready, in the one `kept` held: its directory and place, as the attempt that kept it left them. */
function readyInKept(base: OpeningBase, kept: KeptPlace): Placed {
  return { ...base, dir: kept.dir, place: kept.place, keptFrom: kept.attempt, phase: 'ready' };
}

/** Prepares `ready`, the place `kept` held, for this attempt, recorded before the kept one is retired, so a kill between loses neither. */
async function goOnInKept(config: LocalConfig, ready: Placed, kept: KeptPlace, prompt: string | undefined): Promise<PlacePrepared> {
  await writePlaceRecord(config, ready);
  await retireKeptPlace(config, kept);

  return preparedOf(ready, prompt);
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
    case 'data':
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
 * the checkout leaves it, and so does one in a place the session host made, a reader's included.
 */
export async function releasePlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId }): Promise<'removed' | 'left'> {
  const read = await readPlaceRecord(input.config, input.lock.run, input.attempt);
  const recorded = read.kind === 'found' ? read.record : undefined;

  if (recorded?.phase !== 'opening' && recorded?.place.role === 'team') {
    await removeTeamClone(input.config, input.lock.run, recorded.place.workspace.branch);

    return 'removed';
  }

  if (recorded?.phase !== 'opening' && recorded?.place.role === 'data') {
    await removeDataCheckout(input.config, recorded.dir);

    return 'removed';
  }

  if (!recorded || recorded.phase === 'opening' || !isWorktreeCopy(recorded.place)) return 'left';
  // The role it ran with goes with the copy, and from a place the session host made, which it leaves.
  await releaseWorktreeRole(recorded.dir);

  if (recorded.adopted) return 'left';
  const removed = await removeWorktree(recorded.root, recorded.dir);

  if (removed.ok) return 'removed';
  log.warn(`Worktree ${recorded.dir} of run ${input.lock.run} stays: ${removed.reason}. teamai doctor --fix tries again.`);

  return 'left';
}
