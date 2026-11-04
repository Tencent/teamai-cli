/**
 * The teamai data branches a workflow step with `deliver: publish` publishes to, each through this machine's persistent
 * checkout of it: `teamai-reports` and `teamai-learnings`. A publish that origin could not take leaves its commit on that
 * checkout, and one that could not even be committed, because another process held the checkout or origin changed what
 * the step staged, leaves the step's patch in this data home. `pushPending` sends both later.
 *
 *   <dataHome>/data-branches/<branch>/pending/<time>-<run>-<attempt>.patch    a staged change that has not landed yet, named to apply oldest first
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_BRANCHES, getDataHome, usesBranchWorktree, type DataBranch, type LocalConfig } from '../types.js';
import { isDelivered, type BranchWorktree, type PublishResult } from './branch-worktree.js';
import { createGit, isGitRepo } from './git.js';
import { learningsBranch } from './learnings-branch.js';
import { reportsBranch } from './reports-branch.js';

const CHECKOUTS: Record<DataBranch, BranchWorktree> = { 'teamai-reports': reportsBranch, 'teamai-learnings': learningsBranch };

function keptDir(config: LocalConfig, branch: DataBranch): string {
  return path.join(getDataHome(config), 'data-branches', branch, 'pending');
}

/** The lines `patch` adds, by file, or undefined for a binary patch, whose content cannot be read that way. */
function addedLines(patch: string): Map<string, string[]> | undefined {
  if (patch.includes('\nGIT binary patch\n')) return undefined;
  const added = new Map<string, string[]>();
  let file: string | undefined;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : undefined;
    else if (file !== undefined && line.startsWith('+')) added.set(file, [...added.get(file) ?? [], line.slice(1)]);
  }

  return added;
}

/** Whether every line `patch` adds is already in its file at `worktree`, as when its producer published it again since. */
async function isOnBranch(worktree: string, patch: string): Promise<boolean> {
  const added = addedLines(patch);

  if (added === undefined) return false;

  for (const [file, lines] of added) {
    const text = await fs.readFile(path.join(worktree, file), 'utf8').catch(() => undefined);

    if (text === undefined) return false;
    const present = new Set(text.split('\n'));

    if (!lines.every((line) => present.has(line))) return false;
  }

  return true;
}

/**
 * Applies kept patches `names` of `dir` to the index of `worktree`, oldest first, answering the files of those that landed
 * and the names of those that no longer apply. A patch already on the branch is dropped.
 */
async function applyKept(worktree: string, dir: string, names: readonly string[]): Promise<{ landed: string[]; stuck: string[] }> {
  const landed: string[] = [];
  const stuck: string[] = [];

  for (const name of names) {
    const file = path.join(dir, name);

    try {
      await createGit(worktree).raw(['apply', '--index', '--binary', file]);
      landed.push(file);
    } catch {
      if (await isOnBranch(worktree, await fs.readFile(file, 'utf8'))) await fs.rm(file, { force: true });
      else stuck.push(name);
    }
  }

  return { landed, stuck };
}

/**
 * Applies the patches kept for `branch` to this machine's checkout of it, and commits and pushes them. One that no longer
 * applies stays kept, and the answer says so.
 */
async function sendKept(config: LocalConfig, branch: DataBranch): Promise<PublishResult | undefined> {
  const dir = keptDir(config, branch);
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.patch')).sort();

  if (names.length === 0) return undefined;
  let applied: Awaited<ReturnType<typeof applyKept>> = { landed: [], stuck: [] };

  const result = await CHECKOUTS[branch].update(config, async (worktree, ctx) => {
    applied = await applyKept(worktree, dir, names);
    const { landed } = applied;

    ctx.onDelivered(async () => {
      for (const file of landed) await fs.rm(file, { force: true });
    });
    const staged = (await createGit(worktree).raw(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);

    return staged.length > 0 ? { files: staged, message: `[teamai] Publish pending ${branch} data` } : null;
  });

  const { landed, stuck } = applied;

  // Every kept patch was already here, as in a commit origin could not take: the checkout's own push sends that.
  if (landed.length === 0 && stuck.length === 0 && isDelivered(result)) return undefined;

  if (stuck.length === 0 || !isDelivered(result)) return result;

  return { status: 'failed', reason: `${branch} on origin changed what ${stuck.length === 1 ? 'a step' : `${stuck.length} steps`} staged, so it no longer applies; it is kept in ${dir}` };
}

export const DataBranches = {
  checkout(branch: DataBranch): BranchWorktree {
    return CHECKOUTS[branch];
  },

  /** Keeps `patch`, what a step staged for `branch` and could not land, for the next `pushPending`. */
  async keep(config: LocalConfig, branch: DataBranch, { name, patch }: { name: string; patch: string }): Promise<void> {
    const dir = keptDir(config, branch);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.patch`), patch);
  },

  /**
   * Sends what each data branch holds here and origin does not: the patches kept for it, then the commits its checkout
   * holds that origin lacks, each with what came of it.
   */
  async pushPending(config: LocalConfig): Promise<Array<{ branch: DataBranch; result: PublishResult }>> {
    if (!usesBranchWorktree(config)) return [];
    const results: Array<{ branch: DataBranch; result: PublishResult }> = [];

    for (const branch of DATA_BRANCHES) {
      const kept = await sendKept(config, branch);

      if (kept !== undefined) results.push({ branch, result: kept });

      if (kept !== undefined && !isDelivered(kept)) continue;

      if (await isGitRepo(CHECKOUTS[branch].dir(config)) && await CHECKOUTS[branch].hasUnpushed(config)) results.push({ branch, result: await CHECKOUTS[branch].commitAndPush(config, `[teamai] Publish pending ${branch} data`, []) });
    }

    return results;
  },

  /** `pushPending`, answering each data branch whose data still stays on this machine, with a sentence that says why. */
  async sendPending(config: LocalConfig): Promise<Array<{ branch: DataBranch; message: string }>> {
    return (await DataBranches.pushPending(config)).flatMap(({ branch, result }) => {
      if (isDelivered(result)) return [];

      return [{ branch, message: `What workflow steps published to ${branch} stays pending on this machine: ${result.status === 'failed' ? result.reason.trim() : 'another teamai process is writing it'}.` }];
    });
  },
} as const;
