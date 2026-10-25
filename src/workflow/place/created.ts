import type { WorkflowFailure } from '../types.js';
import type { WorkspaceContract } from '../workspace.js';
import { ensureWorktree, fetchMissingCommits, markSetup, removeWorktree, setupUnfinished, unrestoredCopy, worktreePath } from '../worktree.js';

/** Each commit a lease starts from, merges, or restores agent files from, with the branch that holds it. */
export function leaseCommits(workspace: WorkspaceContract): Array<{ commit: string; branch?: string }> {
  const { base, start } = workspace;
  const startBranch = start.branch ?? (start.commit === base.commit ? base.ref : workspace.branch);
  return [{ commit: start.commit, branch: startBranch }, ...workspace.merge, { commit: workspace.configCommit, branch: base.ref }];
}

/**
 * Opens the worktree of `workspace.branch` under `root`, created from `workspace.start` when it does not exist, after
 * fetching the run's branches for any commit the lease needs that `root` lacks. With `setup`, a worktree whose setup
 * never finished is made again, and a new one is marked until setup finishes. A copy a reader left changed is refused.
 */
export async function openWorktree({ root, run, step, workspace, setup }: {
  root: string;
  run: string;
  step: string;
  workspace: WorkspaceContract;
  setup: boolean;
}): Promise<{ dir: string; created: boolean } | WorkflowFailure> {
  const place = worktreePath(root, workspace.branch);
  const blocked = await unrestoredCopy(place);
  if (blocked?.state === 'unreadable') {
    return { code: 'workspace_base', message: `Workspace ${blocked.dir} has a marker teamai cannot read: ${blocked.marker}. Put ${blocked.dir} back on ${workspace.branch} as the step found it, delete ${blocked.marker}, then retry this step with teamai workflow retry ${run} ${step}.` };
  }
  if (blocked) {
    const { branch, commit, step: reader, reason } = blocked.marker;
    return { code: 'workspace_base', message: `Step "${reader}" read workspace ${blocked.dir} and it was not put back (${reason}). It is still not back: ${blocked.left}. Put ${blocked.dir} back on ${branch} at ${commit} as the step found it, then retry this step with teamai workflow retry ${run} ${step}.` };
  }
  const needed = new Map(leaseCommits(workspace).map((item) => [item.commit, item]));
  const fetched = await fetchMissingCommits(root, { run, commits: [...needed.keys()] });
  if (fetched.missing.length > 0) {
    const named = fetched.missing.map((commit) => {
      const branch = needed.get(commit)?.branch;
      return branch ? `commit ${commit} from branch ${branch}` : `commit ${commit}, the run's base, which is on no branch`;
    });
    const said = fetched.fetchError ? ` Git said: ${fetched.fetchError}.` : '';
    return { code: 'workspace_base', message: `Step "${step}" needs ${named.join(', ')}, which this checkout does not have, even after fetching the run's branches from origin.${said} Push each branch to origin from the machine that has its commit, then retry this step with teamai workflow retry ${run} ${step}.` };
  }
  if (setup && await setupUnfinished(place)) await removeWorktree(root, place);
  const opened = await ensureWorktree(root, workspace.branch, workspace.start.commit);
  if ('error' in opened) return { code: 'workspace_base', message: opened.error };
  if (setup && opened.created) await markSetup(opened.dir, 'unfinished');
  return opened;
}
