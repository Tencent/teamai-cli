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
import { getReportsDir, usesBranchWorktree, type LocalConfig, type TeamaiConfig } from '../types.js';
import { errnoCode } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { sanitizeGitUrl } from '../utils/redact.js';
import { publishRunEnd, type HandoffError } from './handoff.js';
import { pullRequestBranches, RECORDS_DIR, RunRecordFieldsSchema } from './records.js';
import { resolveRetention, retentionEnds, type ResolvedRetention } from './retention.js';
import { AttemptIdSchema, attemptsDir, readRun, readRuns, RunIdSchema, updateRun } from './store.js';
import type { KeptBranchReason, RunLeftovers, RunState } from './types.js';
import { basePinBranch, runBranchPrefix, runCopyToMerge } from './workspace.js';
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
 * Deletes `branches` on origin and in the checkout. A branch checked out in a worktree teamai made goes with that
 * worktree; one checked out where the host put it stays in the checkout, and is not a failure.
 */
async function deleteBranches(
  { checkout, runId, branches, tips }: { checkout: string; runId: string; branches: string[]; tips: Tips },
): Promise<Pick<RunLeftovers, 'deleted' | 'failed'>> {
  const failed: RunLeftovers['failed'] = [];
  const onOrigin = branches.filter((branch) => tips.origin?.has(branch));

  if (onOrigin.length > 0) {
    const pushed = await git(checkout, ['push', '--quiet', 'origin', '--delete', ...onOrigin]);

    if (pushed.code !== 0) {
      const left = await runBranches({ checkout, runId });
      const reason = sanitizeGitUrl(pushed.stderr.trim()) || 'git push failed';

      for (const branch of onOrigin) {
        if ('error' in left || left.origin?.has(branch)) failed.push({ branch, reason: `on origin: ${reason}` });
      }
    }
  }

  const worktrees = await checkedOut(checkout);
  const hostKept = new Set<string>();

  for (const branch of branches.filter((name) => tips.local.has(name) && !failed.some((item) => item.branch === name))) {
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

    const removed = await git(checkout, ['branch', '-D', branch]);

    if (removed.code !== 0) failed.push({ branch, reason: `in ${checkout}: ${removed.stderr.trim() || 'git branch -D failed'}` });
  }

  return { deleted: branches.filter((branch) => !hostKept.has(branch) && !failed.some((item) => item.branch === branch)), failed };
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

    // The base pin holds the commit the run started from, which the branch it started from has.
    const pinned = branch === basePinBranch(run.id) && tipsOf(branch).every((tip) => tip === run.base?.commit);
    let held = true;

    for (const tip of tipsOf(branch)) held &&= await contains({ checkout, tip, holders });

    if (pinned || held) removable.push(branch);
    else kept.push({ branch, why: 'unmerged' });
  }

  return { by: 'success', at: now, revision: run.revision, kept, ...await deleteBranches({ checkout, runId: run.id, branches: removable, tips }) };
}

/**
 * Once run `runId` succeeded and its end was published, deletes in `checkout` and on its origin each of its branches
 * that a branch that stays holds, and records what it did on the run. The publish goes first because it checks the
 * run's branches on origin. `notPublished` is why the end was not published: then nothing is deleted, and the run's
 * owner is warned, unless another install owns the run now. A deletion that fails is a warning naming the branch. Runs
 * once per settled revision, and again while a deletion failed.
 */
export async function cleanUpSucceededRun(
  config: LocalConfig,
  { runId, checkout, secrets, notPublished }: { runId: string; checkout: string; secrets: Record<string, string>; notPublished: HandoffError | undefined },
): Promise<void> {
  const run = await readRun(config, runId);

  // A run with no base and no copy never wrote a branch.
  if (run === 'missing' || run === 'corrupt' || run.status !== 'succeeded' || (run.base === undefined && run.copies === undefined)) return;

  if (run.leftovers?.revision === run.revision && run.leftovers.failed.length === 0) return;

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
const SweptRecordSchema = RunRecordFieldsSchema.extend({ prBranches: z.array(z.string()).optional().catch(undefined) });

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

async function readSweptRecord(file: string): Promise<{ value: SweptRecord } | { error: string }> {
  try {
    const parsed = SweptRecordSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

    return parsed.success ? { value: parsed.data } : { error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`).join('; ') };
  } catch (cause) {
    return { error: causeText(cause) };
  }
}

/** The settled run records on teamai-reports, refreshed first when it can be. */
async function settledRecords(config: LocalConfig): Promise<SweptRecord[]> {
  if (usesBranchWorktree(config)) {
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');

    await readableReportsWorktree(config).catch((cause: unknown) => {
      log.warn(`teamai-reports was not refreshed (${causeText(cause)}), so runs other machines ended since the last pull are not swept.`);
    });
  }

  const dir = path.join(getReportsDir(config), RECORDS_DIR);
  const listed = await readNames(dir);

  if ('error' in listed) {
    log.warn(`The run records in ${dir} were not read (${listed.error}), so what runs other machines ended left is not removed.`);

    return [];
  }

  const records = await Promise.all(listed.names.filter((file) => file.endsWith('.json')).map(async (file) => {
    const at = path.join(dir, file);
    const record = await readSweptRecord(at);

    if ('error' in record) {
      log.warn(`Run record ${at} was not read (${record.error}), so what its run left is not removed.`);

      return [];
    }

    return [record.value];
  }));

  return records.flat().filter((record) => record.status !== 'running');
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
 * `attempts`, and every branch but `keep`. A worktree that stays is named on the deletion of its branch, and a kept ref
 * that stays is a warning. Undefined, with a warning, when its branches, worktrees or kept refs could not be listed.
 */
async function removeRun(
  { checkout, runId, keep, attempts }: { checkout: string; runId: string; keep: ReadonlySet<string>; attempts: string[] },
): Promise<Omit<SweptRun, 'run' | 'from' | 'settledAt'> & { kept: string[] } | undefined> {
  const tips = await runBranches({ checkout, runId });

  if ('error' in tips) return warnNotRemoved(runId, tips.error);
  const listed = await checkedOut(checkout);

  if ('error' in listed) return warnNotRemoved(runId, listed.error);
  const kept = await keptRefs(checkout, attempts);

  if ('error' in kept) return warnNotRemoved(runId, kept.error);
  const worktrees: string[] = [];

  for (const [branch, dir] of listed) {
    if (!branch.startsWith(runBranchPrefix(runId)) || worktreeCheckout(dir) === undefined) continue;

    if ((await removeWorktree(checkout, dir)).ok) worktrees.push(dir);
  }

  const refs: string[] = [];

  for (const ref of kept.refs) {
    const deleted = await git(checkout, ['update-ref', '-d', ref]);

    if (deleted.code === 0) refs.push(ref);
    else log.warn(`Ref ${ref} of run ${runId} was not removed (${deleted.stderr.trim() || 'git update-ref -d failed'}). Remove it with git update-ref -d ${ref}.`);
  }

  const all = namesOf(tips);
  const { deleted, failed } = await deleteBranches({ checkout, runId, branches: all.filter((branch) => !keep.has(branch)), tips });

  return { branches: deleted, worktrees, refs, failed, kept: all.filter((branch) => keep.has(branch)) };
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
 * and, once a run settled longer ago than `workflows.retention`, removes its branches but those a pull request uses,
 * its worktrees and kept refs, and its base pin on origin. Runs of this machine are cleaned in the checkout they ran in,
 * runs other machines published a record of in `checkout`. Running it again, or after it stopped midway, ends the same.
 */
export async function sweepLeftovers(config: LocalConfig, team: Pick<TeamaiConfig, 'workflows'> | null, { now, checkout }: { now: number; checkout: string }): Promise<Sweep> {
  const retention = await resolveRetention(config, team);

  const expired = (settledAt: string): boolean => {
    const ends = retentionEnds(settledAt, retention);

    return ends !== undefined && ends <= now;
  };

  const secrets = await knownSecrets(config);
  const swept: SweptRun[] = [];
  const runs = await readRuns(config);

  for (const run of runs.filter((item) => item.status !== 'running')) {
    const at = run.checkout ?? checkout;

    if (!expired(run.updatedAt)) {
      if (run.status === 'succeeded' && !cleaned(run, 'success')) {
        await cleanUpSucceededRun(config, { runId: run.id, checkout: at, secrets, notPublished: await publishRunEnd(config, run.id, at) });
      }

      continue;
    }

    if (cleaned(run, 'retention')) continue;
    const attempts = await attemptsOf(config, run.id);

    if ('error' in attempts) {
      warnNotRemoved(run.id, `its attempts could not be listed (${attempts.error})`);
      continue;
    }

    const removed = await removeRun({ checkout: at, runId: run.id, keep: new Set(pullRequestBranches(run)), attempts: attempts.names });

    if (!removed) continue;
    const { kept, ...gone } = removed;
    const leftovers: RunLeftovers = { by: 'retention', at: new Date(now).toISOString(), revision: run.revision, kept: kept.map((branch) => ({ branch, why: 'pr' })), deleted: gone.branches, failed: gone.failed };

    await updateRun(config, run.id, secrets, async (stored) => (
      stored === 'missing' || stored.revision !== run.revision ? { value: undefined } : { value: undefined, write: { ...stored, leftovers } }
    ));

    if (gone.branches.length + gone.worktrees.length + gone.refs.length + gone.failed.length > 0) swept.push({ run: run.id, from: 'local', settledAt: run.updatedAt, ...gone });
  }

  const local = new Set(runs.map((run) => run.id));

  for (const record of await settledRecords(config)) {
    const { endedAt } = record;

    if (local.has(record.run) || endedAt === undefined || !expired(endedAt)) continue;

    // An older teamai did not record which branches its pull requests use, so none of its branches is known to be free.
    if (record.prs?.length && record.prBranches === undefined) continue;
    const removed = await removeRun({ checkout, runId: record.run, keep: new Set(record.prBranches), attempts: [] });

    if (removed && removed.branches.length + removed.failed.length > 0) {
      swept.push({ run: record.run, from: 'teamai-reports', settledAt: endedAt, branches: removed.branches, worktrees: removed.worktrees, refs: [], failed: removed.failed });
    }
  }

  return { retention, swept };
}
