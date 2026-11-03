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
import { log } from '../utils/logger.js';
import { sanitizeGitUrl } from '../utils/redact.js';
import { publishRunEnd } from './handoff.js';
import { pullRequestBranches, RECORDS_DIR } from './records.js';
import { resolveRetention, type ResolvedRetention } from './retention.js';
import { AttemptIdSchema, attemptsDir, isRunId, readRun, readRuns, RunIdSchema, updateRun } from './store.js';
import type { KeptBranchReason, RunLeftovers, RunState } from './types.js';
import { fetchMissingCommits, git, removeWorktree, worktreeCheckout } from './worktree.js';

/** Where each branch of a run points: in the checkout, and on `origin`, which is absent when the checkout has none. */
interface Tips {
  local: Map<string, string>;
  origin?: Map<string, string>;
}

function refsUnder(listed: string, prefix: string): Map<string, string> {
  return new Map(listed.split('\n').flatMap((line) => {
    const [commit, ref] = line.trim().split(/\s+/);

    return commit && ref?.startsWith(prefix) ? [[ref.slice('refs/heads/'.length), commit] as const] : [];
  }));
}

/** The `teamai/<run>/…` branches of `checkout` and of its `origin`, or why they could not be listed. */
async function runBranches(checkout: string, runId: string): Promise<Tips | { error: string }> {
  const prefix = `refs/heads/teamai/${runId}/`;
  const local = await git(checkout, ['for-each-ref', '--format=%(objectname) %(refname)', prefix]);

  if (local.code !== 0) return { error: local.stderr.trim() || 'git for-each-ref failed' };

  if ((await git(checkout, ['remote', 'get-url', 'origin'])).code !== 0) return { local: refsUnder(local.stdout, prefix) };
  const remote = await git(checkout, ['ls-remote', '--heads', 'origin', `${prefix}*`]);

  if (remote.code !== 0) return { error: `origin could not be read (${sanitizeGitUrl(remote.stderr.trim()) || 'git ls-remote failed'})` };

  return { local: refsUnder(local.stdout, prefix), origin: refsUnder(remote.stdout, prefix) };
}

/** The branches checked out in a worktree of `checkout`'s repository, with the worktree's path. */
async function checkedOut(checkout: string): Promise<Map<string, string>> {
  const listed = await git(checkout, ['worktree', 'list', '--porcelain']);
  const found = new Map<string, string>();
  let dir: string | undefined;

  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && dir !== undefined) found.set(line.slice('branch refs/heads/'.length), dir);
  }

  return found;
}

/** The branch the run wrote last: that of the succeeded step that settled last with changes, in a copy of the checkout. */
function finalCopy(run: RunState): string | undefined {
  let latest: { branch: string; settledAt: number } | undefined;

  for (const state of run.steps) {
    if (state.status !== 'succeeded' || !state.changes || run.copies?.[state.changes.branch]?.kind !== undefined) continue;

    if (!latest || state.settledAt > latest.settledAt) latest = { branch: state.changes.branch, settledAt: state.settledAt };
  }

  return latest?.branch;
}

async function contains(checkout: string, tip: string, holders: string[]): Promise<boolean> {
  for (const holder of holders) {
    if ((await git(checkout, ['merge-base', '--is-ancestor', tip, holder])).code === 0) return true;
  }

  return false;
}

/**
 * Deletes `branches` on origin and in the checkout. A branch checked out in a worktree teamai made goes with that
 * worktree; one checked out where the host put it stays in the checkout, and is not a failure.
 */
async function deleteBranches(checkout: string, runId: string, branches: string[], tips: Tips): Promise<Pick<RunLeftovers, 'deleted' | 'failed'>> {
  const failed: RunLeftovers['failed'] = [];
  const onOrigin = branches.filter((branch) => tips.origin?.has(branch));

  if (onOrigin.length > 0) {
    const pushed = await git(checkout, ['push', '--quiet', 'origin', '--delete', ...onOrigin]);

    if (pushed.code !== 0) {
      const left = await runBranches(checkout, runId);
      const reason = sanitizeGitUrl(pushed.stderr.trim()) || 'git push failed';

      for (const branch of onOrigin) {
        if ('error' in left || left.origin?.has(branch)) failed.push({ branch, reason: `on origin: ${reason}` });
      }
    }
  }

  const worktrees = await checkedOut(checkout);

  for (const branch of branches.filter((name) => tips.local.has(name) && !failed.some((item) => item.branch === name))) {
    const dir = worktrees.get(branch);

    if (dir !== undefined && worktreeCheckout(dir) === undefined) continue;

    if (dir !== undefined) await removeWorktree(checkout, dir);
    const removed = await git(checkout, ['branch', '-D', branch]);

    if (removed.code !== 0) failed.push({ branch, reason: `in ${checkout}: ${removed.stderr.trim() || 'git branch -D failed'}` });
  }

  return { deleted: branches.filter((branch) => !failed.some((item) => item.branch === branch)), failed };
}

/** What a succeeded run keeps and deletes of its branches, deleted; undefined when `checkout` has none of them, or could not list them. */
async function settleSucceeded(run: RunState, checkout: string, now: string): Promise<RunLeftovers | undefined> {
  const tips = await runBranches(checkout, run.id);

  if ('error' in tips) {
    log.warn(`The branches of run ${run.id} were not cleaned up: ${tips.error}. teamai doctor --fix tries again.`);

    return undefined;
  }

  const all = [...new Set([...tips.local.keys(), ...tips.origin?.keys() ?? []])].sort();

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
    const pinned = branch === `teamai/${run.id}/base` && tipsOf(branch).every((tip) => tip === run.base?.commit);
    let held = true;

    for (const tip of tipsOf(branch)) held &&= await contains(checkout, tip, holders);

    if (pinned || held) removable.push(branch);
    else kept.push({ branch, why: 'unmerged' });
  }

  return { by: 'success', at: now, revision: run.revision, kept, ...await deleteBranches(checkout, run.id, removable, tips) };
}

/**
 * Once run `runId` succeeded, deletes in `checkout` and on its origin each of its branches that a branch that stays
 * holds, and records what it did on the run. A deletion that fails is a warning naming the branch. Runs once per
 * settled revision, and again while a deletion failed.
 */
export async function cleanUpSucceededRun(config: LocalConfig, runId: string, checkout: string, secrets: Record<string, string>): Promise<void> {
  const run = await readRun(config, runId);

  // A run with no base and no copy never wrote a branch.
  if (run === 'missing' || run === 'corrupt' || run.status !== 'succeeded' || (run.base === undefined && run.copies === undefined)) return;

  if (run.leftovers?.revision === run.revision && run.leftovers.failed.length === 0) return;
  const leftovers = await settleSucceeded(run, checkout, new Date().toISOString());

  if (!leftovers) return;

  for (const { branch, reason } of leftovers.failed) log.warn(`Branch ${branch} of run ${runId} was not deleted ${reason}. teamai doctor --fix tries again.`);

  await updateRun(config, runId, secrets, async (stored) => (
    stored === 'missing' || stored.status !== 'succeeded' || stored.revision !== run.revision ? { value: undefined } : { value: undefined, write: { ...stored, leftovers } }
  ));
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
const SweptRecordSchema = z.object({
  run: z.string().refine(isRunId),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  endedAt: z.string().optional(),
  prs: z.array(z.unknown()).optional().catch(undefined),
  prBranches: z.array(z.string()).optional().catch(undefined),
});

type SweptRecord = z.infer<typeof SweptRecordSchema>;

/** The settled run records on teamai-reports, refreshed first when it can be. */
async function settledRecords(config: LocalConfig): Promise<SweptRecord[]> {
  if (usesBranchWorktree(config)) {
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');

    await readableReportsWorktree(config).catch((cause: unknown) => {
      log.warn(`teamai-reports was not refreshed (${cause instanceof Error ? cause.message : String(cause)}), so runs other machines ended since the last pull are not swept.`);
    });
  }

  const dir = path.join(getReportsDir(config), RECORDS_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.json'));

  const records = await Promise.all(files.map(async (file) => {
    try {
      const parsed = SweptRecordSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')));

      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  }));

  return records.flat().filter((record) => record.status !== 'running');
}

/** Removes the kept refs of `attempts`, the reader copies' changes, and returns the refs it removed. */
async function removeKeptRefs(checkout: string, attempts: string[]): Promise<string[]> {
  const removed: string[] = [];

  for (const attempt of attempts) {
    const listed = await git(checkout, ['for-each-ref', '--format=%(refname)', `refs/teamai/kept/${attempt}`, `refs/teamai/kept-modules/${attempt}/`]);

    for (const ref of listed.stdout.split('\n').filter(Boolean)) {
      if ((await git(checkout, ['update-ref', '-d', ref])).code === 0) removed.push(ref);
    }
  }

  return removed;
}

/**
 * Removes what run `runId` left in `checkout` and on its origin: the worktrees teamai made on its branches, the refs of
 * `attempts`, and every branch but `keep`. Undefined when the branches could not be listed.
 */
async function removeRun(checkout: string, runId: string, keep: ReadonlySet<string>, attempts: string[]): Promise<Omit<SweptRun, 'run' | 'from' | 'settledAt'> & { kept: string[] } | undefined> {
  const tips = await runBranches(checkout, runId);

  if ('error' in tips) {
    log.warn(`What run ${runId} left behind was not removed: ${tips.error}. teamai doctor --fix tries again.`);

    return undefined;
  }

  const worktrees: string[] = [];

  for (const [branch, dir] of await checkedOut(checkout)) {
    if (!branch.startsWith(`teamai/${runId}/`) || worktreeCheckout(dir) === undefined) continue;
    await removeWorktree(checkout, dir);
    worktrees.push(dir);
  }

  const refs = await removeKeptRefs(checkout, attempts);
  const all = [...new Set([...tips.local.keys(), ...tips.origin?.keys() ?? []])].sort();
  const { deleted, failed } = await deleteBranches(checkout, runId, all.filter((branch) => !keep.has(branch)), tips);

  return { branches: deleted, worktrees, refs, failed, kept: all.filter((branch) => keep.has(branch)) };
}

/** The attempts of a run of this machine, whose kept refs go with it. */
async function attemptsOf(config: LocalConfig, runId: string): Promise<string[]> {
  const id = RunIdSchema.safeParse(runId);

  return id.success ? (await fs.readdir(attemptsDir(config, id.data)).catch(() => [])).filter((name) => AttemptIdSchema.safeParse(name).success) : [];
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
  const expired = (settledAt: string | undefined): boolean => retention.retention.kind === 'after' && settledAt !== undefined && Date.parse(settledAt) + retention.retention.ms <= now;
  const secrets = await knownSecrets(config);
  const swept: SweptRun[] = [];
  const runs = await readRuns(config);

  for (const run of runs.filter((item) => item.status !== 'running')) {
    const at = run.checkout ?? checkout;

    if (!expired(run.updatedAt)) {
      if (run.status === 'succeeded' && !cleaned(run, 'success') && await publishRunEnd(config, run.id, at) === undefined) {
        await cleanUpSucceededRun(config, run.id, at, secrets);
      }

      continue;
    }

    if (cleaned(run, 'retention')) continue;
    const removed = await removeRun(at, run.id, new Set(pullRequestBranches(run)), await attemptsOf(config, run.id));

    if (!removed) continue;
    const { kept, ...done } = removed;
    const leftovers: RunLeftovers = { by: 'retention', at: new Date(now).toISOString(), revision: run.revision, kept: kept.map((branch) => ({ branch, why: 'pr' })), deleted: done.branches, failed: done.failed };

    await updateRun(config, run.id, secrets, async (stored) => (
      stored === 'missing' || stored.revision !== run.revision ? { value: undefined } : { value: undefined, write: { ...stored, leftovers } }
    ));

    if (done.branches.length + done.worktrees.length + done.refs.length + done.failed.length > 0) swept.push({ run: run.id, from: 'local', settledAt: run.updatedAt, ...done });
  }

  const local = new Set(runs.map((run) => run.id));

  for (const record of await settledRecords(config)) {
    if (local.has(record.run) || !expired(record.endedAt)) continue;

    // An older teamai did not record which branches its pull requests use, so none of its branches is known to be free.
    if (record.prs?.length && record.prBranches === undefined) continue;
    const removed = await removeRun(checkout, record.run, new Set(record.prBranches), []);

    if (removed && removed.branches.length + removed.failed.length > 0) {
      swept.push({ run: record.run, from: 'teamai-reports', settledAt: record.endedAt ?? '', branches: removed.branches, worktrees: removed.worktrees, refs: [], failed: removed.failed });
    }
  }

  return { retention, swept };
}
