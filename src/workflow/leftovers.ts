/**
 * The git a settled run leaves behind (#1689): its `teamai/<run>/…` branches, in the checkout and on `origin`. A run
 * that succeeds deletes, as it settles, every branch whose tip a branch that stays holds: a branch a pull request uses,
 * or the run's final copy. A deletion that does not go through is recorded, and `teamai doctor --fix` tries it again.
 */
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { sanitizeGitUrl } from '../utils/redact.js';
import { readRun, updateRun } from './store.js';
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

/** The run branches its pull requests use: the branch each came from, and the one it went into when that is the run's. */
export function pullRequestBranches(run: Pick<RunState, 'id' | 'deliveries'>): string[] {
  const own = (branch: string): boolean => branch.startsWith(`teamai/${run.id}/`);

  return [...new Set((run.deliveries ?? []).flatMap((receipt) => [receipt.branch, receipt.base].filter(own)))];
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
