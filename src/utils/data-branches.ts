/**
 * The teamai data branches a workflow step with `deliver: publish` publishes to, each through this machine's persistent
 * checkout of it: `teamai-reports` and `teamai-learnings`. A publish that origin could not take leaves its commit on that
 * checkout, and `pushPending` sends it later.
 */
import { DATA_BRANCHES, usesBranchWorktree, type DataBranch, type LocalConfig } from '../types.js';
import type { BranchWorktree, PublishResult } from './branch-worktree.js';
import { isGitRepo } from './git.js';
import { learningsBranch } from './learnings-branch.js';
import { reportsBranch } from './reports-branch.js';

const CHECKOUTS: Record<DataBranch, BranchWorktree> = { 'teamai-reports': reportsBranch, 'teamai-learnings': learningsBranch };

export const DataBranches = {
  checkout(branch: DataBranch): BranchWorktree {
    return CHECKOUTS[branch];
  },

  /** Pushes what each checkout this machine has of a data branch holds and origin does not, each with what came of it. */
  async pushPending(config: LocalConfig): Promise<Array<{ branch: DataBranch; result: PublishResult }>> {
    if (!usesBranchWorktree(config)) return [];
    const results: Array<{ branch: DataBranch; result: PublishResult }> = [];

    for (const branch of DATA_BRANCHES) {
      if (await isGitRepo(CHECKOUTS[branch].dir(config))) results.push({ branch, result: await CHECKOUTS[branch].commitAndPush(config, `[teamai] Publish pending ${branch} data`, []) });
    }

    return results;
  },
} as const;
