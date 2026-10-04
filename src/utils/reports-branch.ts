/**
 * The `teamai-reports` orphan branch, plus the disposable worktree that stages
 * knowledge pull requests off the user's active tree.
 *
 * The branch machinery itself lives in `branch-worktree.ts`; reports are one
 * instance of it and learnings are the other. What stays here is the reports
 * spec, the names its callers already import, and the knowledge worktree, which
 * is not a side branch at all: it is a throwaway checkout of the default branch,
 * while a dry-run checkout models the contents after a real refresh.
 */
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { createGit, getDefaultBranch, getHeadCommit, hasCommits } from './git.js';
import { pathExists } from './fs.js';
import { log } from './logger.js';
import {
  ForeignCheckoutError,
  createBranchWorktree,
  isPublished,
  type BranchWrite,
  type EnsureWorktreeOptions,
  type RefreshResult,
} from './branch-worktree.js';
import {
  REPORTS_BRANCH,
  REPORTS_WORKTREE_DIRNAME,
  REPORTS_LOCK_FILENAME,
  KNOWLEDGE_WORKTREE_DIRNAME,
  getBusinessRoot,
  type LocalConfig,
} from '../types.js';

const reportsBranch = createBranchWorktree({
  branch: REPORTS_BRANCH,
  worktreeDirname: REPORTS_WORKTREE_DIRNAME,
  lockFilename: REPORTS_LOCK_FILENAME,
  logTag: 'reports',
  initCommitMessage: '[teamai] Initialize reports branch',
});

export type EnsureReportsWorktreeOptions = EnsureWorktreeOptions;
export type ReportsWrite = BranchWrite;

/** Materialize the reports worktree. See the branch-worktree module. */
export function ensureReportsWorktree(
  localConfig: LocalConfig,
  options: EnsureReportsWorktreeOptions = {},
): Promise<string> {
  return reportsBranch.ensure(localConfig, options);
}

/**
 * The team's votes dir on the reports checkout, or undefined when the checkout
 * there belongs to another repository (a git/self mode switch, #808): its votes
 * are that team's, so nothing may rank or downvote from them. No checkout yet
 * is fine (a caller finds no file). Probes the checkout, like
 * indexableLearningsRoots, so only for index builds and explicit commands.
 */
export async function indexableVotesDir(localConfig: LocalConfig): Promise<string | undefined> {
  try {
    await reportsBranch.checkOwner(localConfig);
  } catch (e) {
    if (e instanceof ForeignCheckoutError) return undefined;
    throw e;
  }
  return path.join(reportsBranch.dir(localConfig), 'votes');
}

/**
 * Best-effort refresh of the reports worktree from origin; busy when the lock
 * cannot be taken, and then nothing is checked; failed when the checkout could
 * not be set up. Throws only CheckoutRefusedError (#808).
 */
export function refreshReportsWorktree(
  localConfig: LocalConfig,
  options: EnsureReportsWorktreeOptions = {},
): Promise<RefreshResult> {
  return reportsBranch.refresh(localConfig, options);
}

/**
 * The reports checkout a reader lists from: refreshed and, if missing,
 * created, without publishing a missing branch. While a write holds the lock,
 * the local copy as it is: that write may be creating the checkout, so a
 * reader must not add or remove it (#808). Throws ForeignCheckoutError when
 * that copy is another repository's.
 */
export async function readableReportsWorktree(
  localConfig: LocalConfig,
  options: { dryRun?: boolean } = {},
): Promise<string> {
  // A dry run reads the local copy as it is: neither refreshed nor created.
  if (options.dryRun) {
    await reportsBranch.checkOwner(localConfig);
    return reportsBranch.dir(localConfig);
  }
  let refreshed = await reportsBranch.refresh(localConfig, { pushIfCreated: false });
  // Failed: try once more, under the lock like every creation, and throw the
  // cause if it fails again. An `ensure` here would create the checkout without
  // the lock, while a writer that took it meanwhile creates it too (#823 item 15).
  if (refreshed.status === 'failed') refreshed = await reportsBranch.refresh(localConfig, { pushIfCreated: false });
  switch (refreshed.status) {
    case 'done':
      return reportsBranch.dir(localConfig);
    case 'busy':
      await reportsBranch.checkOwner(localConfig);
      return reportsBranch.dir(localConfig);
    case 'failed':
      throw new Error(refreshed.reason);
    default: {
      const unhandled: never = refreshed;
      throw new Error(`Unhandled refresh result: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Commit files already written into the reports worktree and push them.
 *
 * Reports are regenerated on the next session, so callers only need to know
 * whether the write landed: anything else (a busy lock, an unchanged tree, a
 * rejected push) is a false they retry by simply reporting again later.
 */
export async function commitAndPushReports(
  localConfig: LocalConfig,
  message: string,
  files: string[],
  options: { pushIfUnchanged?: boolean } = {},
): Promise<boolean> {
  return isPublished(await reportsBranch.commitAndPush(localConfig, message, files, options));
}

/** Under the reports lock: sync with origin, run `write`, commit, push. */
export async function updateReports(
  localConfig: LocalConfig,
  write: (worktree: string) => Promise<ReportsWrite | null>,
  options: { pushIfUnchanged?: boolean } = {},
): Promise<boolean> {
  return isPublished(await reportsBranch.update(localConfig, write, options));
}

/**
 * Thrown when a knowledge worktree is requested but the business repo has no
 * commits yet (unborn HEAD). Callers catch this to print an actionable hint
 * instead of crashing on a raw GitError.
 */
export class EmptyRepoError extends Error {
  constructor(public readonly repoRoot: string) {
    super(
      `The repository at ${repoRoot} has no commits yet, so teamai cannot open a knowledge PR. ` +
      `Make an initial commit and push it first (e.g. \`git add -A && git commit -m "init" && git push -u origin HEAD\`), then retry.`,
    );
    this.name = 'EmptyRepoError';
  }
}

/**
 * Run `fn` against a disposable knowledge worktree for single-repo mode.
 *
 * Knowledge PRs (skills/rules/docs/learnings → main) must never run `checkout -b`
 * / `reset --hard` on the user's active working tree. This checks out a fresh,
 * detached worktree at origin/<default> under .teamai/knowledge-wt, passes fn a
 * clone of localConfig whose repo.localPath points at <wt>/.teamai (so all the
 * existing push/remove/roles machinery operates on the worktree), then removes
 * the worktree afterward. The user's active branch and working tree are untouched.
 *
 * @returns whatever fn returns.
 */
export async function withKnowledgeWorktree<T>(
  localConfig: LocalConfig,
  fn: (worktreeConfig: LocalConfig) => Promise<T>,
): Promise<T> {
  const repoRoot = getBusinessRoot(localConfig);
  const wt = path.join(localConfig.repo.localPath, KNOWLEDGE_WORKTREE_DIRNAME);
  const git = createGit(repoRoot);

  // A knowledge worktree must branch off a base commit. A freshly `git init`'d
  // business repo (unborn HEAD) has none — `worktree add` would fail with an
  // opaque "invalid reference: HEAD". Fail early with an actionable message that
  // callers surface, instead of letting a raw GitError crash the CLI.
  if (!(await hasCommits(repoRoot))) {
    throw new EmptyRepoError(repoRoot);
  }

  // Clean any stale worktree from a previous interrupted run.
  if (await pathExists(wt)) {
    try {
      await git.raw(['worktree', 'remove', '--force', wt]);
    } catch {
      await fse.remove(wt);
    }
  }
  try {
    await git.raw(['worktree', 'prune']);
  } catch {
    // best effort
  }

  // Fetch the latest default branch so the PR is based on current main.
  const defaultBranch = await getDefaultBranch(repoRoot);
  try {
    await git.fetch(['origin', defaultBranch]);
  } catch {
    // offline / no remote — fall back to local default branch state
  }

  // Detached worktree at origin/<default>; pushRepoBranch will create the feature
  // branch inside the worktree, so the active repo never switches branches.
  let base = `origin/${defaultBranch}`;
  try {
    await git.raw(['worktree', 'add', '--detach', wt, base]);
  } catch {
    // origin/<default> may not exist locally (fresh repo); fall back to HEAD.
    base = 'HEAD';
    await git.raw(['worktree', 'add', '--detach', wt, base]);
  }

  const worktreeConfig: LocalConfig = {
    ...localConfig,
    repo: {
      ...localConfig.repo,
      localPath: path.join(wt, '.teamai'),
      businessRepoRoot: wt,
    },
  };

  try {
    return await fn(worktreeConfig);
  } finally {
    try {
      await git.raw(['worktree', 'remove', '--force', wt]);
    } catch {
      await fse.remove(wt);
      try { await git.raw(['worktree', 'prune']); } catch { /* best effort */ }
    }
  }
}

/** A failed refresh, distinct from errors while reading the preview checkout. */
export class PreviewFetchError extends Error {
  constructor(cause: unknown) {
    super((cause as Error).message, { cause });
    this.name = 'PreviewFetchError';
  }
}

/** A clone's dirty files may survive a real pull but are absent from origin. */
export class DirtyPreviewError extends Error {
  constructor(repoRoot: string) {
    super(`Cannot preview a team repo with uncommitted changes at ${repoRoot}. Commit or stash the changes, then retry --dry-run. Nothing was changed.`);
    this.name = 'DirtyPreviewError';
  }
}

/**
 * Run `fn` against a throwaway checkout of the post-pull clone branch, or
 * origin/<default> in self mode, without changing the member checkout.
 *
 * Only a fetch touches the member's repo. Pulling there can reset a clone
 * that diverged from origin and discard its commits, and `withKnowledgeWorktree`
 * adds a worktree (#900). The checkout is a `--shared` clone in the OS temp
 * dir, so history reads work and nothing is written under the repo. `fn`
 * receives a clone of localConfig pointed at it, laid out as the real run's.
 */
export async function withDefaultBranchPreview<T>(
  localConfig: LocalConfig,
  fn: (previewConfig: LocalConfig) => Promise<T>,
  options: { allowStale?: boolean } = {},
): Promise<T> {
  const selfMode = localConfig.repo.kind === 'self';
  const repoRoot = selfMode ? getBusinessRoot(localConfig) : localConfig.repo.localPath;
  const git = createGit(repoRoot);
  // A successful clone pull may preserve dirty manifests/resources. Do not
  // silently replace that view with origin; self mode really reads a worktree.
  if (!selfMode && (await git.raw(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])).trim()) {
    throw new DirtyPreviewError(repoRoot);
  }
  const defaultBranch = await getDefaultBranch(repoRoot);
  const branch = selfMode ? defaultBranch : (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  let fetched = true;
  try {
    await git.fetch(selfMode ? ['origin', branch] : ['origin']);
  } catch (e) {
    if (!options.allowStale) throw new PreviewFetchError(e);
    fetched = false;
    log.warn(`Could not fetch origin/${branch} (${(e as Error).message}); ${selfMode ? 'previewing against the copy fetched last.' : 'previewing against the local checkout.'}`);
  }
  const head = await getHeadCommit(repoRoot);
  // Self mode really creates a default-branch worktree. Clone mode pulls the
  // active branch: ff-only retains an ahead HEAD, advances a behind HEAD,
  // and pullRepo's divergence fallback resets to origin/<active branch>.
  let base = await getHeadCommit(repoRoot, `origin/${branch}`) ?? head;
  if (!selfMode) {
    if (!fetched) {
      base = head; // pullLatest warns and continues with this unchanged checkout.
    } else {
      const upstream = await getHeadCommit(repoRoot, '@{upstream}');
      if (head && upstream) {
        try {
          const common = (await git.raw(['merge-base', head, upstream])).trim();
          if (common === upstream) base = head;
          else if (common === head) base = upstream;
        } catch { /* no common ancestor: pullRepo resets to origin/<branch> */ }
      }
    }
  }
  if (!base) throw new EmptyRepoError(repoRoot);

  const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-preview-'));
  try {
    await git.raw(['clone', '--quiet', '--shared', '--no-checkout', repoRoot, dir]);
    const preview = createGit(dir);
    await preview.raw(['checkout', '--quiet', '--detach', base]);
    // A shared clone's origin/* initially name the member's local branches.
    // History/name resolution must instead see the member's fetched refs,
    // including an ahead HEAD that differs from origin/<active branch>.
    const refs = await git.raw(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/']);
    for (const entry of refs.trim().split('\n').filter(Boolean)) {
      const [ref, commit] = entry.split(' ');
      if (ref !== 'refs/remotes/origin/HEAD') await preview.raw(['update-ref', ref, commit]);
    }
    await preview.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`]);
    const previewConfig: LocalConfig = {
      ...localConfig,
      repo: selfMode
        ? { ...localConfig.repo, localPath: path.join(dir, '.teamai'), businessRepoRoot: dir }
        : { ...localConfig.repo, localPath: dir },
    };
    return await fn(previewConfig);
  } finally {
    await fse.remove(dir);
  }
}
