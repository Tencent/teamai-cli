/**
 * The git a settled run leaves behind (#1689): its `teamai/<run>/…` branches, in the checkout and on `origin`, the
 * worktrees teamai made for them, and what readers' copies kept under `refs/teamai/kept/<attempt>`. A run that
 * succeeds deletes, as it settles, every branch whose tip a branch that stays holds: a branch a pull request uses, or
 * the run's final copy. `teamai doctor --fix` tries again a deletion that did not go through, and removes everything
 * but the pull request branches of a run that settled longer ago than `workflows.retention`, including runs other
 * machines started, which it finds through their records on teamai-reports.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { knownSecrets } from '../env-resolution.js';
import { getReportsDir, REPORTS_BRANCH, usesBranchWorktree, type LocalConfig, type TeamaiConfig } from '../types.js';
import { errnoCode } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { sanitizeGitUrl } from '../utils/redact.js';
import { publishRunEnd, type HandoffError } from './handoff.js';
import { pullRequestBranches, RECORDS_DIR, RunRecordFieldsSchema } from './records.js';
import { ownRunSweptAt, resolveRetention, type ResolvedRetention } from './retention.js';
import { parseSnapshot, snapshotPath } from './snapshot.js';
import { AttemptIdSchema, attemptsDir, installOwner, readRun, readRuns, RunIdSchema, updateRun, withCleanupLock } from './store.js';
import type { KeptBranchReason, RunLeftovers, RunState } from './types.js';
import { runBranchPrefix, runCopyToMerge } from './workspace.js';
import { fetchMissingCommits, git, removeWorktree, worktreeCheckout } from './worktree.js';

/** Where each branch of a run points: in the checkout, and on `origin`, which is absent when the checkout has none. */
interface Tips {
  local: Map<string, string>;
  origin?: Map<string, string>;
}

/** Every branch `tips` names, here or on origin, sorted. */
function namesOf(tips: Tips): string[] {
  return [...new Set([...tips.local.keys(), ...tips.origin?.keys() ?? []])].sort();
}

function refsUnder(listed: string, prefix: string): Map<string, string> {
  return new Map(listed.split('\n').flatMap((line) => {
    const [commit, ref] = line.trim().split(/\s+/);

    return commit && ref?.startsWith(prefix) ? [[ref.slice('refs/heads/'.length), commit] as const] : [];
  }));
}

/** The `teamai/<run>/…` branches of `checkout` and of its `origin`, or why they could not be listed. */
async function runBranches({ checkout, runId }: { checkout: string; runId: string }): Promise<Tips | { error: string }> {
  const prefix = `refs/heads/${runBranchPrefix(runId)}`;
  const local = await git(checkout, ['for-each-ref', '--format=%(objectname) %(refname)', prefix]);

  if (local.code !== 0) return { error: local.stderr.trim() || 'git for-each-ref failed' };

  if ((await git(checkout, ['remote', 'get-url', 'origin'])).code !== 0) return { local: refsUnder(local.stdout, prefix) };
  const remote = await git(checkout, ['ls-remote', '--heads', 'origin', `${prefix}*`]);

  if (remote.code !== 0) return { error: `origin could not be read (${sanitizeGitUrl(remote.stderr.trim()) || 'git ls-remote failed'})` };

  return { local: refsUnder(local.stdout, prefix), origin: refsUnder(remote.stdout, prefix) };
}

/** The branches checked out in a worktree of `checkout`'s repository, with the worktree's path, or why they could not be listed. */
async function checkedOut(checkout: string): Promise<Map<string, string> | { error: string }> {
  const listed = await git(checkout, ['worktree', 'list', '--porcelain']);

  if (listed.code !== 0) return { error: `its worktrees could not be listed (${listed.stderr.trim() || 'git worktree list failed'})` };
  const found = new Map<string, string>();
  let dir: string | undefined;

  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && dir !== undefined) found.set(line.slice('branch refs/heads/'.length), dir);
  }

  return found;
}

/**
 * The run's output: the copy the run tells the person to merge (`runCopyToMerge`), else the branch it wrote last, that of
 * the succeeded step that settled last with changes, in a copy of the checkout.
 */
function finalCopy(run: RunState): string | undefined {
  const toMerge = runCopyToMerge(run);

  if (toMerge !== undefined) return toMerge;
  let latest: { branch: string; settledAt: number } | undefined;

  for (const state of run.steps) {
    if (state.status !== 'succeeded' || !state.changes || run.copies?.[state.changes.branch]?.kind !== undefined) continue;

    if (!latest || state.settledAt > latest.settledAt) latest = { branch: state.changes.branch, settledAt: state.settledAt };
  }

  return latest?.branch;
}

async function contains({ checkout, tip, holders }: { checkout: string; tip: string; holders: string[] }): Promise<boolean> {
  for (const holder of holders) {
    if ((await git(checkout, ['merge-base', '--is-ancestor', tip, holder])).code === 0) return true;
  }

  return false;
}

/**
 * Deletes `branches` on origin and in the checkout, each only while it is still at the tip `tips` examined: a branch
 * that moved since stays, as a failure `doctor --fix` tries again. A branch checked out in a worktree teamai made goes
 * with that worktree; one checked out where the host put it stays in the checkout, as `hostKept`, and is not a failure.
 */
async function deleteBranches(
  { checkout, runId, branches, tips }: { checkout: string; runId: string; branches: string[]; tips: Tips },
): Promise<Pick<RunLeftovers, 'deleted' | 'failed'> & { hostKept: string[] }> {
  const failed: RunLeftovers['failed'] = [];

  const onOrigin = branches.flatMap((branch) => {
    const tip = tips.origin?.get(branch);

    return tip === undefined ? [] : [{ branch, tip }];
  });

  if (onOrigin.length > 0) {
    const leases = onOrigin.map(({ branch, tip }) => `--force-with-lease=refs/heads/${branch}:${tip}`);
    const pushed = await git(checkout, ['push', '--quiet', ...leases, 'origin', '--delete', ...onOrigin.map(({ branch }) => `refs/heads/${branch}`)]);

    if (pushed.code !== 0) {
      const left = await runBranches({ checkout, runId });
      const reason = sanitizeGitUrl(pushed.stderr.trim()) || 'git push failed';

      for (const { branch } of onOrigin) {
        if ('error' in left || left.origin?.has(branch)) failed.push({ branch, reason: `on origin: ${reason}` });
      }
    }
  }

  const worktrees = await checkedOut(checkout);
  const hostKept = new Set<string>();

  for (const branch of branches.filter((name) => !failed.some((item) => item.branch === name))) {
    const tip = tips.local.get(branch);

    if (tip === undefined) continue;

    if ('error' in worktrees) {
      failed.push({ branch, reason: `in ${checkout}: ${worktrees.error}` });
      continue;
    }

    const dir = worktrees.get(branch);

    if (dir !== undefined && worktreeCheckout(dir) === undefined) {
      hostKept.add(branch);
      continue;
    }

    if (dir !== undefined) {
      const worktree = await removeWorktree(checkout, dir);

      if (!worktree.ok) {
        failed.push({ branch, reason: `in ${checkout}: worktree ${dir} was not removed (${worktree.reason})` });
        continue;
      }
    }

    const removed = await git(checkout, ['update-ref', '-d', `refs/heads/${branch}`, tip]);

    if (removed.code !== 0) failed.push({ branch, reason: `in ${checkout}: ${removed.stderr.trim() || 'git update-ref -d failed'}` });
  }

  return { deleted: branches.filter((branch) => !hostKept.has(branch) && !failed.some((item) => item.branch === branch)), failed, hostKept: [...hostKept] };
}

function warnNotCleanedUp(runId: string, reason: string): void {
  log.warn(`The branches of run ${runId} were not cleaned up: ${reason}. teamai doctor --fix tries again.`);
}

/** The warning for each deletion in `failed`, which `doctor --fix` tries again. */
export function warnNotDeleted(runId: string, failed: RunLeftovers['failed']): void {
  for (const { branch, reason } of failed) log.warn(`Branch ${branch} of run ${runId} was not deleted ${reason}. teamai doctor --fix tries again.`);
}

/** What a succeeded run keeps and deletes of its branches, deleted; undefined when `checkout` has none of them, or could not list them. */
async function settleSucceeded(run: RunState, { checkout, now }: { checkout: string; now: string }): Promise<RunLeftovers | undefined> {
  const tips = await runBranches({ checkout, runId: run.id });

  if ('error' in tips) {
    warnNotCleanedUp(run.id, tips.error);

    return undefined;
  }

  const all = namesOf(tips);

  if (all.length === 0) return undefined;
  const reasons = new Map<string, KeptBranchReason>(pullRequestBranches(run).map((branch) => [branch, 'pr']));
  const last = finalCopy(run);

  if (last !== undefined && !reasons.has(last)) reasons.set(last, 'final');
  const tipsOf = (branch: string): string[] => [tips.local.get(branch), tips.origin?.get(branch)].filter((tip) => tip !== undefined);
  const holders = all.filter((branch) => reasons.has(branch)).flatMap(tipsOf);

  // A commit another checkout pushed is compared once it is here; one still missing counts as not held.
  if (tips.origin) await fetchMissingCommits(checkout, { run: run.id, commits: all.flatMap(tipsOf) });
  const kept: RunLeftovers['kept'] = [];
  const removable: string[] = [];

  for (const branch of all) {
    const why = reasons.get(branch);

    if (why !== undefined) {
      kept.push({ branch, why });
      continue;
    }

    // A branch at the commit the run started from, as the base pin and the copy of an answer are, holds nothing the
    // branch the run started from lacks.
    const atBase = tipsOf(branch).every((tip) => tip === run.base?.commit);
    let held = true;

    for (const tip of tipsOf(branch)) held &&= await contains({ checkout, tip, holders });

    if (atBase || held) removable.push(branch);
    else kept.push({ branch, why: 'unmerged' });
  }

  const { deleted, failed, hostKept } = await deleteBranches({ checkout, runId: run.id, branches: removable, tips });

  for (const branch of hostKept) kept.push({ branch, why: 'host' });

  return { by: 'success', at: now, revision: run.revision, kept, deleted, failed };
}

/**
 * Once run `runId` succeeded and its end was published, deletes in `checkout` and on its origin each of its branches
 * that a branch that stays holds, and records what it did on the run. The publish goes first because it checks the
 * run's branches on origin. `notPublished` is why the end was not published: then nothing is deleted, and the run's
 * owner is warned, unless another install owns the run now. A deletion that fails is a warning naming the branch. Runs
 * once per settled revision, and again while a deletion failed, under the run's cleanup lock, which a retry holds while it
 * reopens the run: the run is read under it, and while another holds it nothing is deleted until `doctor --fix`.
 */
export async function cleanUpSucceededRun(
  config: LocalConfig,
  { runId, checkout, secrets, notPublished }: { runId: string; checkout: string; secrets: Record<string, string>; notPublished: HandoffError | undefined },
): Promise<void> {
  // A run with no base and no copy never wrote a branch. Checked before the lock too, so the end of a run that cleans up
  // nothing never holds the lock a retry of that run takes.
  const needsCleanup = (run: RunState | 'missing' | 'corrupt'): run is RunState => run !== 'missing' && run !== 'corrupt' && run.status === 'succeeded'
    && (run.base !== undefined || run.copies !== undefined)
    && !(run.leftovers?.revision === run.revision && run.leftovers.failed.length === 0);

  if (!needsCleanup(await readRun(config, runId))) return;

  await withCleanupLock(config, runId, async () => {
    const run = await readRun(config, runId);

    if (!needsCleanup(run)) return;

    if (notPublished) {
      if (notPublished.code !== 'not_owner') warnNotCleanedUp(runId, 'its end did not reach teamai-reports');

      return;
    }

    const leftovers = await settleSucceeded(run, { checkout, now: new Date().toISOString() });

    if (!leftovers) return;

    warnNotDeleted(runId, leftovers.failed);

    await updateRun(config, runId, secrets, async (stored) => (
      stored === 'missing' || stored.status !== 'succeeded' || stored.revision !== run.revision ? { value: undefined } : { value: undefined, write: { ...stored, leftovers } }
    ));
  });
}

/**
 * Brings back the branch of each copy of the checkout succeeded run `run` recorded, at the commit the run recorded on
 * it, on origin and in `checkout`, before a retry reopens the run: publishing it checks each one on origin, and a step it
 * runs again may start from one. Cleanup may have deleted one on either side, or a claim may have brought the run here
 * without them. A branch already at that commit stays; one at another commit is not moved. The base pin is not brought
 * back: publishing pins it again. Answers the branches that are not back, and why. Run again, or after it stopped
 * midway, it ends the same.
 */
export async function restoreRecordedBranches(run: RunState, checkout: string): Promise<RunLeftovers['failed']> {
  // A clone's branch and a team repo branch are not branches of this checkout.
  const wanted = Object.entries(run.copies ?? {}).flatMap(([branch, copy]) => (copy.kind === undefined && copy.commit !== undefined ? [{ branch, commit: copy.commit }] : []));

  if (wanted.length === 0) return [];
  const tips = await runBranches({ checkout, runId: run.id });

  if ('error' in tips) return wanted.map(({ branch }) => ({ branch, reason: `in ${checkout}: ${tips.error}` }));
  // A branch the run kept holds each commit, so origin has the ones this checkout lacks.
  const fetched = tips.origin ? await fetchMissingCommits(checkout, { run: run.id, commits: wanted.map(({ commit }) => commit) }) : { missing: [] };
  const failed: RunLeftovers['failed'] = [];
  const pending: typeof wanted = [];

  for (const { branch, commit } of wanted) {
    const there = tips.origin?.get(branch);
    const here = tips.local.get(branch);

    if (fetched.missing.includes(commit)) {
      failed.push({ branch, reason: `in ${checkout}: commit ${commit} is not there, and was not fetched from origin (${fetched.fetchError ?? 'no branch there holds it'})` });
    } else if (there !== undefined && there !== commit) {
      failed.push({ branch, reason: `on origin: it is at ${there}, not at commit ${commit} the run recorded, and teamai does not move it` });
    } else if (here !== undefined && here !== commit) {
      failed.push({ branch, reason: `in ${checkout}: it is at ${here}, not at commit ${commit} the run recorded, and teamai does not move it` });
    } else pending.push({ branch, commit });
  }

  const toPush = tips.origin ? pending.filter(({ branch }) => !tips.origin?.has(branch)) : [];

  if (toPush.length > 0) {
    // An empty lease pushes each branch only while origin has none, so a branch another machine made meanwhile stays.
    const leases = toPush.map(({ branch }) => `--force-with-lease=refs/heads/${branch}:`);
    const pushed = await git(checkout, ['push', '--quiet', ...leases, 'origin', ...toPush.map(({ branch, commit }) => `${commit}:refs/heads/${branch}`)]);

    if (pushed.code !== 0) {
      const now = await runBranches({ checkout, runId: run.id });
      const reason = sanitizeGitUrl(pushed.stderr.trim()) || 'git push failed';

      for (const { branch, commit } of toPush) {
        if ('error' in now || now.origin?.get(branch) !== commit) failed.push({ branch, reason: `on origin: ${reason}` });
      }
    }
  }

  for (const { branch, commit } of pending) {
    if (tips.local.has(branch) || failed.some((item) => item.branch === branch)) continue;
    // An empty old value creates the branch only while the checkout has none.
    const created = await git(checkout, ['update-ref', `refs/heads/${branch}`, commit, '']);

    if (created.code !== 0) failed.push({ branch, reason: `in ${checkout}: ${created.stderr.trim() || 'git update-ref failed'}` });
  }

  return failed;
}

/**
 * What settled run `run` left of its branches. `cleaned`: what the run kept and deleted as it succeeded, or what
 * `doctor --fix` removed past `workflows.retention`, at its current revision. `kept`: the copies it handed out and the
 * branches its pull requests use, which stay until `doctor --fix` passes the retention. Undefined while it runs, or when
 * it left none.
 */
export type SettledBranches =
  | ({ state: 'cleaned' } & Omit<RunLeftovers, 'revision'>)
  | { state: 'kept'; branches: Array<{ branch: string; isPullRequest: boolean }> };

export function settledBranches(run: RunState): SettledBranches | undefined {
  if (run.status === 'running') return undefined;

  if (run.leftovers?.revision === run.revision) {
    const { revision: _revision, ...leftovers } = run.leftovers;

    return { state: 'cleaned', ...leftovers };
  }

  const pr = new Set(pullRequestBranches(run));
  const handed = Object.entries(run.copies ?? {}).flatMap(([branch, copy]) => (copy.kind === undefined ? [branch] : []));
  const branches = [...new Set([...handed, ...pr])].sort().map((branch) => ({ branch, isPullRequest: pr.has(branch) }));

  return branches.length === 0 ? undefined : { state: 'kept', branches };
}

/** What `doctor --fix` removed of one run: from this machine's run, or from a record another machine published. */
export interface SweptRun {
  run: string;
  from: 'local' | 'teamai-reports';
  settledAt: string;
  branches: string[];
  worktrees: string[];
  refs: string[];
  failed: RunLeftovers['failed'];
}

/** The retention `doctor --fix` applied, and the runs it removed something of. */
export interface Sweep {
  retention: ResolvedRetention;
  swept: SweptRun[];
}

/** The fields of a run record on teamai-reports a sweep reads. */
const SweptRecordSchema = RunRecordFieldsSchema.extend({
  prBranches: z.array(z.string()).optional().catch(undefined),
  retainedUntil: z.string().optional().catch(undefined),
});

type SweptRecord = z.infer<typeof SweptRecordSchema>;

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The names in directory `dir`, none when it does not exist, or why it could not be read. */
async function readNames(dir: string): Promise<{ names: string[] } | { error: string }> {
  try {
    return { names: await fs.readdir(dir) };
  } catch (cause) {
    return errnoCode(cause) === 'ENOENT' ? { names: [] } : { error: causeText(cause) };
  }
}

function parseSweptRecord(text: string): { value: SweptRecord } | { error: string } {
  try {
    const parsed = SweptRecordSchema.safeParse(JSON.parse(text));

    return parsed.success ? { value: parsed.data } : { error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; ') };
  } catch (cause) {
    return { error: causeText(cause) };
  }
}

/**
 * Refreshes teamai-reports from origin, which the run records and snapshots a sweep reads are on. True only once origin
 * was fetched now: a readable copy as it was is not origin's word that a run settled, so the sweep leaves published runs
 * alone otherwise, with a warning that names why.
 */
async function refreshReports(config: LocalConfig): Promise<boolean> {
  if (!usesBranchWorktree(config)) return true;
  const { refreshReportsWorktree } = await import('../utils/reports-branch.js');
  let refreshed: Awaited<ReturnType<typeof refreshReportsWorktree>>;

  try {
    refreshed = await refreshReportsWorktree(config, { pushIfCreated: false });
  } catch (cause) {
    log.warn(`teamai-reports could not be refreshed (${causeText(cause)}), so runs published there are not swept this time. teamai doctor --fix tries again.`);

    return false;
  }

  switch (refreshed.status) {
    case 'done':
      return true;
    case 'unfetched':
      log.warn(`teamai-reports could not be fetched from origin (${refreshed.reason}), so runs published there are not swept this time. teamai doctor --fix tries again.`);

      return false;
    case 'busy':
      log.warn(`teamai-reports is being written by another teamai process (${refreshed.lockPath} is held), so runs published there are not swept this time. teamai doctor --fix tries again.`);

      return false;
    case 'failed':
      log.warn(`teamai-reports could not be refreshed (${refreshed.reason}), so runs published there are not swept this time. teamai doctor --fix tries again.`);

      return false;
    default: {
      const unhandled: never = refreshed;

      return unhandled;
    }
  }
}

/** A run record file on teamai-reports, named by where it was read, with its text or why it could not be read. */
type RecordFile = { at: string } & ({ text: string } | { error: string });

/**
 * The run record files on teamai-reports: from the ref the sweep's refresh just fetched, since the checkout keeps an
 * older copy when an interrupted write left it dirty; from the reports directory where teamai-reports is no branch.
 */
async function recordFiles(config: LocalConfig): Promise<{ files: RecordFile[] } | { from: string; error: string }> {
  const reports = getReportsDir(config);

  if (!usesBranchWorktree(config)) {
    const dir = path.join(reports, RECORDS_DIR);
    const listed = await readNames(dir);

    if ('error' in listed) return { from: dir, error: listed.error };

    return { files: await Promise.all(listed.names.filter((name) => name.endsWith('.json')).map(async (name): Promise<RecordFile> => {
      const at = path.join(dir, name);

      return fs.readFile(at, 'utf8').then((text) => ({ at, text }), (cause: unknown) => ({ at, error: causeText(cause) }));
    })) };
  }

  const ref = `origin/${REPORTS_BRANCH}`;

  // A refresh that found no teamai-reports on origin leaves no tracking ref, and no records.
  if ((await git(reports, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`])).code !== 0) return { files: [] };
  const listed = await git(reports, ['ls-tree', '--name-only', ref, '--', `${RECORDS_DIR}/`]);

  if (listed.code !== 0) return { from: `${ref}:${RECORDS_DIR}`, error: listed.stderr.trim() || 'git ls-tree failed' };
  const paths = listed.stdout.split('\n').filter((name) => name.endsWith('.json'));
  const { readReportsOriginFiles } = await import('../utils/reports-branch.js');
  const texts = await readReportsOriginFiles(reports, paths);

  return { files: paths.map((name) => {
    const text = texts.get(name);

    return text === undefined || text === null ? { at: `${ref}:${name}`, error: 'git could not read it' } : { at: `${ref}:${name}`, text };
  }) };
}

/** The settled run records on teamai-reports. */
async function settledRecords(config: LocalConfig): Promise<SweptRecord[]> {
  const listed = await recordFiles(config);

  if ('error' in listed) {
    log.warn(`The run records in ${listed.from} were not read (${listed.error}), so what runs other machines ended left is not removed.`);

    return [];
  }

  const records = listed.files.flatMap((file) => {
    const record = 'text' in file ? parseSweptRecord(file.text) : file;

    if ('error' in record) {
      log.warn(`Run record ${file.at} was not read (${record.error}), so what its run left is not removed.`);

      return [];
    }

    return [record.value];
  });

  return records.filter((record) => record.status !== 'running');
}

/**
 * What run `runId`'s snapshot on teamai-reports says, as this machine's sweep fetched it: `unpublished` without one;
 * `unsettled` while it runs, while another install claimed it and has not settled it since, or when it cannot be read;
 * else which install settled it, until when that install keeps what it left, and the branches its pull requests use.
 */
type PublishedRun =
  | { kind: 'unpublished' }
  | { kind: 'unsettled' }
  | { kind: 'settled'; owner: string; retainedUntil?: string; prBranches: string[] };

async function publishedRun({ config, install }: { config: LocalConfig; install: string }, runId: string): Promise<PublishedRun> {
  if (!usesBranchWorktree(config)) return { kind: 'unpublished' };
  const { readReportsOriginFile } = await import('../utils/reports-branch.js');
  const text = await readReportsOriginFile(getReportsDir(config), snapshotPath(runId));

  if (text === null) return { kind: 'unpublished' };
  const parsed = parseSnapshot(text, runId);

  if (!parsed.ok) {
    warnNotRemoved(runId, `its snapshot on teamai-reports could not be read (${parsed.error.message})`);

    return { kind: 'unsettled' };
  }

  const snapshot = parsed.value;

  if (snapshot.status === 'running' || (snapshot.owner.id !== install && Date.parse(snapshot.ownedAt) > Date.parse(snapshot.updatedAt))) return { kind: 'unsettled' };

  return { kind: 'settled', owner: snapshot.owner.id, retainedUntil: snapshot.retainedUntil, prBranches: pullRequestBranches({ id: runId, deliveries: snapshot.deliveries }) };
}

/**
 * How long past the `retainedUntil` another install published `doctor --fix` here waits before it removes what that run
 * left: a retry its owner started just before then, which no machine tells this one about, has this long to settle.
 */
const OTHER_INSTALL_GRACE_MS = 7 * 86_400_000;

/** When `doctor --fix` here may remove what a run of another install left: a grace period past the `retainedUntil` it published. Never without one. */
function otherInstallSweepsAt(retainedUntil: string | undefined): number | undefined {
  return retainedUntil === undefined ? undefined : Date.parse(retainedUntil) + OTHER_INSTALL_GRACE_MS;
}

function warnNotRemoved(runId: string, reason: string): undefined {
  log.warn(`What run ${runId} left behind was not removed: ${reason}. teamai doctor --fix tries again.`);

  return undefined;
}

/** The kept refs of `attempts`, the reader copies' changes, or why they could not be listed. */
async function keptRefs(checkout: string, attempts: string[]): Promise<{ refs: string[] } | { error: string }> {
  // for-each-ref with no pattern lists every ref.
  if (attempts.length === 0) return { refs: [] };
  const listed = await git(checkout, ['for-each-ref', '--format=%(refname)', ...attempts.flatMap((attempt) => [`refs/teamai/kept/${attempt}`, `refs/teamai/kept-modules/${attempt}/`])]);

  return listed.code === 0 ? { refs: listed.stdout.split('\n').filter(Boolean) } : { error: `its kept refs could not be listed (${listed.stderr.trim() || 'git for-each-ref failed'})` };
}

/**
 * Removes what run `runId` left in `checkout` and on its origin: the worktrees teamai made on its branches, the refs of
 * `attempts`, and every branch but `keep`. A worktree that stays is named on the deletion of its branch, or, on a branch
 * of `keep`, is a warning, as a kept ref that stays is; `complete` is false then. Undefined, with a warning, when its
 * branches, worktrees or kept refs could not be listed.
 */
async function removeRun(
  { checkout, runId, keep, attempts }: { checkout: string; runId: string; keep: ReadonlySet<string>; attempts: string[] },
): Promise<Omit<SweptRun, 'run' | 'from' | 'settledAt'> & { kept: RunLeftovers['kept']; complete: boolean } | undefined> {
  const tips = await runBranches({ checkout, runId });

  if ('error' in tips) return warnNotRemoved(runId, tips.error);
  const listed = await checkedOut(checkout);

  if ('error' in listed) return warnNotRemoved(runId, listed.error);
  const kept = await keptRefs(checkout, attempts);

  if ('error' in kept) return warnNotRemoved(runId, kept.error);
  const worktrees: string[] = [];
  let complete = true;

  for (const [branch, dir] of listed) {
    if (!branch.startsWith(runBranchPrefix(runId)) || worktreeCheckout(dir) === undefined) continue;
    const removed = await removeWorktree(checkout, dir);

    if (removed.ok) worktrees.push(dir);
    else if (keep.has(branch)) {
      complete = false;
      log.warn(`Worktree ${dir} of run ${runId} was not removed (${removed.reason}). teamai doctor --fix tries again.`);
    }
  }

  const refs: string[] = [];

  for (const ref of kept.refs) {
    const deleted = await git(checkout, ['update-ref', '-d', ref]);

    if (deleted.code === 0) refs.push(ref);
    else {
      complete = false;
      log.warn(`Ref ${ref} of run ${runId} was not removed (${deleted.stderr.trim() || 'git update-ref -d failed'}). teamai doctor --fix tries again.`);
    }
  }

  const all = namesOf(tips);
  const { deleted, failed, hostKept } = await deleteBranches({ checkout, runId, branches: all.filter((branch) => !keep.has(branch)), tips });
  const keptHere: RunLeftovers['kept'] = all.filter((branch) => keep.has(branch)).map((branch) => ({ branch, why: 'pr' }));

  for (const branch of hostKept) keptHere.push({ branch, why: 'host' });

  return { branches: deleted, worktrees, refs, failed, kept: keptHere, complete };
}

/** The attempts of a run of this machine, whose kept refs go with it, or why they could not be listed. */
async function attemptsOf(config: LocalConfig, runId: string): Promise<{ names: string[] } | { error: string }> {
  const id = RunIdSchema.safeParse(runId);

  if (!id.success) return { names: [] };
  const listed = await readNames(attemptsDir(config, id.data));

  return 'error' in listed ? listed : { names: listed.names.filter((name) => AttemptIdSchema.safeParse(name).success) };
}

/** Whether a sweep or a succeeded run's cleanup already went through for this revision of `run`. */
function cleaned(run: RunState, by: RunLeftovers['by']): boolean {
  return run.leftovers?.by === by && run.leftovers.revision === run.revision && run.leftovers.failed.length === 0;
}

/**
 * What `teamai doctor --fix` does with settled runs: deletes again what a succeeded run could not delete as it settled,
 * and, once a run is past its `retainedUntil`, which no retry reopens, removes its branches but those a pull request
 * uses, its worktrees and kept refs, and its base pin on origin. A run another install settled last waits a grace period
 * more, and one that published no `retainedUntil` stays. Runs of this machine are cleaned in the checkout they ran in,
 * runs other machines published a record of in `checkout`. Running it again, or after it stopped midway, ends the same.
 */
export async function sweepLeftovers(config: LocalConfig, team: Pick<TeamaiConfig, 'workflows'> | null, { now, checkout }: { now: number; checkout: string }): Promise<Sweep> {
  const retention = await resolveRetention(config, team);
  const due = (at: number | undefined): boolean => at !== undefined && at <= now;
  const secrets = await knownSecrets(config);
  const swept: SweptRun[] = [];
  const fresh = await refreshReports(config);
  const reports = { config, install: (await installOwner(config)).id };
  const runs = await readRuns(config);

  for (const run of runs.filter((item) => item.status !== 'running')) {
    const at = run.checkout ?? checkout;

    if (!due(ownRunSweptAt(run, retention))) {
      if (run.status === 'succeeded' && !cleaned(run, 'success')) {
        await cleanUpSucceededRun(config, { runId: run.id, checkout: at, secrets, notPublished: await publishRunEnd(config, run.id, at) });
      }

      continue;
    }

    if (cleaned(run, 'retention') || (run.publication !== undefined && !fresh)) continue;
    const published = await publishedRun(reports, run.id);

    if (published.kind === 'unsettled') continue;
    const byOther = published.kind === 'settled' && published.owner !== reports.install;

    // Another install claimed the run: its retainedUntil, not the one this copy settled with, says when no retry reopens it.
    if (byOther && !due(otherInstallSweepsAt(published.retainedUntil))) continue;
    const keep = new Set([...pullRequestBranches(run), ...published.kind === 'settled' ? published.prBranches : []]);
    const attempts = await attemptsOf(config, run.id);

    if ('error' in attempts) {
      warnNotRemoved(run.id, `its attempts could not be listed (${attempts.error})`);
      continue;
    }

    // A retry here reopens the run only outside this lock: one since the run was read makes what it left its own again.
    const locked = await withCleanupLock(config, run.id, async () => {
      const reread = await readRun(config, run.id);

      if (reread === 'missing' || reread === 'corrupt' || reread.revision !== run.revision) return undefined;
      const removed = await removeRun({ checkout: at, runId: run.id, keep, attempts: attempts.names });

      // A ref or worktree that stayed leaves the run uncleaned, so the next sweep tries it again.
      if (removed?.complete) {
        const leftovers: RunLeftovers = { by: 'retention', at: new Date(now).toISOString(), revision: run.revision, kept: removed.kept, deleted: removed.branches, failed: removed.failed };

        await updateRun(config, run.id, secrets, async (stored) => (
          stored === 'missing' || stored.revision !== run.revision ? { value: undefined } : { value: undefined, write: { ...stored, leftovers } }
        ));
      }

      return removed;
    });

    if (locked.kind === 'busy' || locked.value === undefined) continue;
    const { kept: _kept, complete: _complete, ...gone } = locked.value;

    if (gone.branches.length + gone.worktrees.length + gone.refs.length + gone.failed.length > 0) swept.push({ run: run.id, from: 'local', settledAt: run.updatedAt, ...gone });
  }

  const local = new Set(runs.map((run) => run.id));

  for (const record of fresh ? await settledRecords(config) : []) {
    const { endedAt } = record;

    if (local.has(record.run) || endedAt === undefined || !due(otherInstallSweepsAt(record.retainedUntil))) continue;

    // An older teamai did not record which branches its pull requests use, so none of its branches is known to be free.
    if (record.prs?.length && record.prBranches === undefined) continue;
    const published = await publishedRun(reports, record.run);

    if (published.kind === 'unsettled') continue;

    // A settled snapshot is the run's last word: one with no retainedUntil, settled under never or by an older teamai, stays.
    if (published.kind === 'settled' && !due(otherInstallSweepsAt(published.retainedUntil))) continue;
    const keep = new Set([...record.prBranches ?? [], ...published.kind === 'settled' ? published.prBranches : []]);

    // A claim here since the runs were read makes the run this machine's, which the next sweep goes by.
    const locked = await withCleanupLock(config, record.run, async () => (
      await readRun(config, record.run) === 'missing' ? removeRun({ checkout, runId: record.run, keep, attempts: [] }) : undefined
    ));

    const removed = locked.kind === 'held' ? locked.value : undefined;

    if (removed && removed.branches.length + removed.failed.length > 0) {
      swept.push({ run: record.run, from: 'teamai-reports', settledAt: endedAt, branches: removed.branches, worktrees: removed.worktrees, refs: [], failed: removed.failed });
    }
  }

  return { retention, swept };
}
