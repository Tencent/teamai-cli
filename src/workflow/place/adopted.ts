/**
 * A place the host made for a lease, which TeamAI adopts as the copy of the lease's branch instead of creating one. The
 * checks change nothing, so a refused place costs the attempt nothing, and TeamAI never adds or removes the worktree.
 */
import fs from 'node:fs/promises';
import { gitCommonDir } from '../../utils/git.js';
import type { WorkflowFailure } from '../types.js';
import type { WorkspaceContract } from '../workspace.js';
import { fetchMissingCommits, git, hooksPath, offBranch, setupUnfinished, worktreeHooks } from '../worktree.js';
import { leaseCommits } from './created.js';
import type { PlaceRecord } from './record.js';

interface Adoption {
  /** The checkout the run started from. */
  root: string;
  /** The place the host made. */
  dir: string;
  run: string;
  attempt: string;
  workspace: WorkspaceContract;
}

/**
 * Why attempt `lease.attempt` cannot adopt `adopt`, as the message `adopt_mismatch` answers with, or undefined when it
 * can, or adopts nothing. A place recorded for the attempt answers for itself, so only that place may be adopted again.
 * A lease in the checkout adopts none, and a reader only `hosted`, the place the host made for its branch.
 */
export async function adoptRefusal(input: {
  /** The checkout the run started from. */
  root: string;
  run: string;
  recorded: PlaceRecord | undefined;
  lease: { attempt: string; step: string; workspace?: WorkspaceContract };
  adopt: string | undefined;
  hosted: string | undefined;
}): Promise<string | undefined> {
  const { root, run, recorded, lease, adopt, hosted } = input;
  if (adopt === undefined) return undefined;
  if (recorded !== undefined && recorded.phase !== 'abandoned') {
    if (recorded.dir !== adopt) return `Attempt ${lease.attempt} is already prepared in ${recorded.dir}, so it cannot adopt ${adopt}. Prepare it again without --adopt, which answers with that place.`;
    if (recorded.phase !== 'opening') return undefined;
  }
  const { workspace } = lease;
  if (!workspace) return `Step "${lease.step}" runs in the checkout itself, so attempt ${lease.attempt} cannot adopt a place. Prepare it without --adopt.`;
  if (workspace.mode === 'read-only' && adopt !== hosted) return `Step "${lease.step}" reads a copy TeamAI keeps, so attempt ${lease.attempt} cannot adopt a place. Prepare it without --adopt.`;
  return adoptedMismatch({ root, dir: adopt, run, attempt: lease.attempt, workspace });
}

/**
 * Why `dir` cannot be the copy of `workspace.branch`, or undefined when it can: the top of a worktree of the checkout's
 * repository, with nothing the step would commit, on the branch, or detached at its start while no such branch exists,
 * with that start in its history and every commit the lease merges or restores agent files from, once the run's
 * branches are fetched.
 */
async function adoptedMismatch({ root, dir, run, attempt, workspace }: Adoption): Promise<string | undefined> {
  const { branch, start } = workspace;
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || await realpath(top.stdout.trim()) !== await realpath(dir)) {
    return `${dir} is not the top directory of a git worktree, so attempt ${attempt} was not prepared there. Adopt the top directory of a worktree on branch ${branch}.`;
  }
  if (await gitCommonDir(dir) !== await gitCommonDir(root)) {
    return `${dir} is not a worktree of the repository of ${root}, so attempt ${attempt} was not prepared there. Adopt a worktree of ${root} on branch ${branch}, as git worktree add makes.`;
  }
  if (await setupUnfinished(dir)) {
    return `Setup did not finish in ${dir} the last time it ran there. What it left would pass the next setup's checks, and may hold a key the step must not read, so attempt ${attempt} was not prepared there. Remove that worktree with git worktree remove --force ${dir}, make the place again on branch ${branch}, then adopt it.`;
  }
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  const changed = status.stdout.split('\n').filter((line) => line.trim() !== '');
  if (status.code !== 0) {
    return `git cannot read the status of ${dir} (${status.stderr.trim()}), so attempt ${attempt} was not prepared there. Adopt a worktree git can read, on branch ${branch}.`;
  }
  if (changed.length > 0) {
    return `${dir} has changes the step would commit (${changed.join(', ')}), so attempt ${attempt} was not prepared there. Commit, stash or remove them, or adopt a clean worktree on branch ${branch}.`;
  }
  const on = await offBranch(dir, branch);
  if (on !== undefined && on !== `detached at ${start.commit}`) {
    return `${dir} is ${on}, not on branch ${branch} nor detached at its start ${start.commit}, so attempt ${attempt} was not prepared there. Check out ${branch} in ${dir}, then adopt it again.`;
  }
  if (on !== undefined && (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
    return `${dir} is detached at the start of branch ${branch}, which already exists, so attempt ${attempt} was not prepared there. Check out ${branch} in ${dir}, then adopt it again.`;
  }
  if ((await git(dir, ['merge-base', '--is-ancestor', start.commit, 'HEAD'])).code !== 0) {
    return `Branch ${branch} in ${dir} does not contain ${start.commit}, the commit the step starts from, so attempt ${attempt} was not prepared there. Adopt a worktree whose ${branch} contains it.`;
  }
  const fetched = await fetchMissingCommits(dir, { run, commits: leaseCommits(workspace).map((item) => item.commit) });
  if (fetched.missing.length > 0) {
    return `${dir} lacks ${fetched.missing.join(', ')}, which the step needs, even after fetching the run's branches from origin, so attempt ${attempt} was not prepared there. Push the branches that hold them to origin, then adopt it again.`;
  }
  return undefined;
}

/**
 * Makes `dir`, which `adoptRefusal` accepted, the copy of `workspace.branch`: its hooks point at the checkout's empty
 * hooks directory, and a place detached at the start gets the branch there.
 */
export async function takeAdopted({ root, dir, workspace }: Omit<Adoption, 'run' | 'attempt'>): Promise<{ dir: string } | WorkflowFailure> {
  const hooks = hooksPath(root);
  await fs.mkdir(hooks, { recursive: true });
  await worktreeHooks(dir, hooks);
  if (await offBranch(dir, workspace.branch) !== undefined) {
    const switched = await git(dir, ['switch', '-q', '-c', workspace.branch]);
    if (switched.code !== 0) {
      return { code: 'workspace_base', message: `git could not make branch ${workspace.branch} in ${dir}: ${switched.stderr.trim()}. Check out ${workspace.branch} in ${dir}, then retry the step.` };
    }
  }
  return { dir };
}

async function realpath(dir: string): Promise<string> {
  return fs.realpath(dir).catch(() => dir);
}
