/**
 * Manage the `teamai-reports` orphan branch via an isolated git worktree.
 *
 * Used for every non-HTTP team repo (`kind !== 'http'`):
 *  - self: worktree under <business-repo>/.teamai/reports-wt
 *  - git / legacy: sibling of the clone (`<dirname(localPath)>/reports-wt`) so
 *    clone `reset --hard` cannot nest-destroy it
 *
 * Why an orphan branch + dedicated worktree?
 *  - High-frequency report data (members/sessions/votes/stats) must NOT pollute
 *    the default branch, so members can use the team repo with branch protection.
 *    The orphan branch has an independent history, so main stays clean.
 *  - Report writes involve `git reset --hard` / rebase. Running those on the
 *    user's active working tree (self) or nesting the worktree inside the
 *    knowledge clone (git) would destroy uncommitted work. A separate worktree
 *    confines every destructive git op to the orphan-branch checkout.
 *
 * Concurrency: the branch is shared by the whole team, but each member only ever
 * writes their own `<user>.yaml`, so files from different members never collide.
 * Writers merge into their own file, so `updateReports` syncs the worktree with
 * origin under the reports lock before the write — a stale checkout (another
 * machine of the same member) would otherwise diverge. Pushes race at the git
 * layer (non-fast-forward); we resolve with fetch + rebase + retry.
 */
import path from 'node:path';
import fse from 'fs-extra';
import type { SimpleGit } from 'simple-git';
import { createGit, isGitRepo, getDefaultBranch, hasCommits, commitSkippingHooks, isDedicatedRepoRoot } from './git.js';
import { acquireLock, releaseLock } from '../update.js';
import { ensureDir, writeFile, pathExists } from './fs.js';
import { log } from './logger.js';
import {
  REPORTS_BRANCH,
  REPORTS_WORKTREE_DIRNAME,
  REPORTS_LOCK_FILENAME,
  KNOWLEDGE_WORKTREE_DIRNAME,
  getReportsDir,
  isSelfMode,
  usesReportsBranch,
  type LocalConfig,
} from '../types.js';

/** Remote-tracking ref of the reports branch. */
const REPORTS_UPSTREAM = `origin/${REPORTS_BRANCH}`;

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

/** Resolve the business repo git root for a self-mode config. */
function businessRoot(localConfig: LocalConfig): string {
  return localConfig.repo.businessRepoRoot ?? path.dirname(localConfig.repo.localPath);
}

/**
 * Git repository that owns the reports worktree.
 * - self: the business repo (knowledge lives in `.teamai/` inside it)
 * - git: the dedicated team clone (`localPath` itself)
 */
function reportsGitRoot(localConfig: LocalConfig): string {
  if (isSelfMode(localConfig)) {
    return businessRoot(localConfig);
  }
  return localConfig.repo.localPath;
}

/** Path to the reports worktree directory (see getReportsDir). */
function reportsWorktreePath(localConfig: LocalConfig): string {
  return getReportsDir(localConfig);
}

/** Lock file sitting beside the reports worktree (never inside the clone). */
function reportsLockPath(localConfig: LocalConfig): string {
  return path.join(path.dirname(getReportsDir(localConfig)), REPORTS_LOCK_FILENAME);
}

/** Whether the remote already has the reports branch. */
async function remoteBranchExists(repoRoot: string): Promise<boolean> {
  const git = createGit(repoRoot);
  try {
    const res = await git.listRemote(['--heads', 'origin', REPORTS_BRANCH]);
    return typeof res === 'string' && res.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the reports branch into its remote-tracking ref. The explicit refspec
 * keeps `origin/teamai-reports` current even when the clone's fetch refspec
 * does not cover the branch (e.g. a `--single-branch` business repo).
 */
async function fetchReportsBranch(git: SimpleGit): Promise<void> {
  await git.fetch(['origin', `+refs/heads/${REPORTS_BRANCH}:refs/remotes/${REPORTS_UPSTREAM}`]);
}

/**
 * Ensure a git worktree checked out on the `teamai-reports` orphan branch exists.
 * Self: <knowledgeDir>/reports-wt. Independent git: sibling of the clone.
 * Idempotent. Returns the worktree absolute path. Does not fetch an existing
 * worktree; readers use refreshReportsWorktree, writers use updateReports.
 *
 * Cold-start cases handled:
 *  - worktree already present  → return it as-is.
 *  - remote branch exists      → worktree add --track -b from origin/teamai-reports.
 *  - remote branch absent      → reuse an unpublished local branch, or create the
 *                                orphan branch locally; then first-push unless
 *                                `pushIfCreated` is false.
 */
export interface EnsureReportsWorktreeOptions {
  /**
   * Whether a cold start may publish a newly created reports branch. Writers
   * keep the default; read-only callers must pass false so they materialize a
   * local view without changing origin.
   */
  pushIfCreated?: boolean;
}

export async function ensureReportsWorktree(
  localConfig: LocalConfig,
  options: EnsureReportsWorktreeOptions = {},
): Promise<string> {
  if (!usesReportsBranch(localConfig)) {
    return getReportsDir(localConfig);
  }

  const wt = reportsWorktreePath(localConfig);
  const repoRoot = reportsGitRoot(localConfig);

  if (!isSelfMode(localConfig) && !(await isDedicatedRepoRoot(repoRoot))) {
    throw new Error(
      `Refusing to create a reports worktree: ${repoRoot} is not a dedicated team-repo clone root`,
    );
  }

  // Already a valid worktree — nothing to do. `isGitRepo` only checks that a
  // `.git` file/dir exists; after a sibling clone is deleted and re-cloned the
  // worktree gitdir (`<clone>/.git/worktrees/reports-wt`) is gone and git ops
  // fail with "not a git repository". Probe a real git command and fall through
  // to remove+recreate when the link is stale.
  if (await isGitRepo(wt)) {
    try {
      await createGit(wt).revparse(['--is-inside-work-tree']);
      return wt;
    } catch {
      // stale/dangling worktree link (clone was re-cloned/pruned) — recreate below.
    }
  }

  // Path exists but is not a git worktree (stale/partial) — clear it so we can recreate.
  if (await pathExists(wt)) {
    await fse.remove(wt);
  }

  await ensureDir(path.dirname(wt));
  const git = createGit(repoRoot);

  // Prune any dangling worktree registration left from a previous removal.
  try {
    await git.raw(['worktree', 'prune']);
  } catch {
    // best effort
  }

  if (await remoteBranchExists(repoRoot)) {
    // Remote branch exists: fetch and check it out into the worktree.
    try {
      await fetchReportsBranch(git);
    } catch {
      // fetch may fail offline; worktree add can still work if we have it locally
    }
    // If a local branch of the same name exists, add tracking it; otherwise create tracking branch.
    const branches = await git.branchLocal();
    if (branches.all.includes(REPORTS_BRANCH)) {
      await git.raw(['worktree', 'add', wt, REPORTS_BRANCH]);
    } else {
      await git.raw(['worktree', 'add', wt, '--track', '-b', REPORTS_BRANCH, REPORTS_UPSTREAM]);
    }
  } else {
    // Remote branch absent. A read-only cold start (or a failed first push)
    // leaves an unpublished local branch; reuse it, because creating the orphan
    // branch again fails with "a branch named 'teamai-reports' already exists".
    const branches = await git.branchLocal();
    if (branches.all.includes(REPORTS_BRANCH)) {
      await git.raw(['worktree', 'add', wt, REPORTS_BRANCH]);
    } else {
      await createOrphanWorktree(repoRoot, wt);
      await writeWorktreeGitignore(wt);
      const wtGit = createGit(wt);
      await wtGit.add(['.gitignore']);
      await commitSkippingHooks(wtGit, '[teamai] Initialize reports branch');
    }
    if (options.pushIfCreated !== false) {
      try {
        await createGit(wt).push(['-u', 'origin', REPORTS_BRANCH]);
      } catch (e) {
        log.debug(`[reports] initial push skipped: ${(e as Error).message}`);
      }
    }
  }

  return wt;
}

/**
 * Create an orphan-branch worktree. Uses the modern `--orphan` flag (git 2.42+)
 * and falls back to the detach + `checkout --orphan` dance for older git.
 */
async function createOrphanWorktree(repoRoot: string, wt: string): Promise<void> {
  const git = createGit(repoRoot);
  try {
    // git 2.42+: create a worktree on a fresh orphan branch directly.
    // The branch name must be given via -b; a positional after <path> is treated
    // as a commit-ish and errors ("--orphan and commit-ish cannot be used together").
    await git.raw(['worktree', 'add', '--orphan', '-b', REPORTS_BRANCH, wt]);
    // The --orphan worktree may inherit the index/files from HEAD in some git
    // versions; clear tracked entries so the branch starts empty.
    const wtGit = createGit(wt);
    try {
      await wtGit.raw(['rm', '-rf', '--cached', '.']);
    } catch {
      // nothing staged — fine
    }
    await clearWorktreeFiles(wt);
  } catch {
    // Older git (<2.42): detach a worktree at HEAD, then orphan-checkout inside it.
    await git.raw(['worktree', 'add', '--detach', wt, 'HEAD']);
    const wtGit = createGit(wt);
    await wtGit.raw(['checkout', '--orphan', REPORTS_BRANCH]);
    try {
      await wtGit.raw(['rm', '-rf', '--cached', '.']);
    } catch {
      // nothing staged
    }
    await clearWorktreeFiles(wt);
  }
}

/** Remove all files (except .git) from a freshly-created orphan worktree. */
async function clearWorktreeFiles(wt: string): Promise<void> {
  const entries = await fse.readdir(wt);
  await Promise.all(
    entries
      .filter((e) => e !== '.git')
      .map((e) => fse.remove(path.join(wt, e))),
  );
}

/** Write a .gitignore inside the reports worktree to prevent nested-worktree recursion. */
async function writeWorktreeGitignore(wt: string): Promise<void> {
  const content = [
    '# teamai reports branch — machine-local artifacts should never be tracked here',
    `${REPORTS_WORKTREE_DIRNAME}/`,
    'knowledge-wt/',
    '',
  ].join('\n');
  await writeFile(path.join(wt, '.gitignore'), content);
}

/**
 * Bring the reports worktree up to date with origin. The caller must hold the
 * reports lock, so no writer sits between writing and committing its files.
 *
 *  - fetch fails (offline, or origin has no reports branch yet) → keep the local copy.
 *  - uncommitted leftovers from an interrupted writer → discarded.
 *  - no unpushed commits → move to origin.
 *  - unpushed commits that rebase cleanly → kept on top of origin for the next push.
 *  - unpushed commits that conflict (the same member reported from another
 *    checkout) → dropped, so the worktree is never left permanently diverged.
 */
async function syncReportsWorktree(wt: string): Promise<void> {
  const git = createGit(wt);
  try {
    await fetchReportsBranch(git);
  } catch (e) {
    log.debug(`[reports] fetch failed, using the local copy: ${(e as Error).message}`);
    return;
  }

  const status = await git.status();
  if (!status.isClean()) {
    await git.raw(['reset', '--hard', 'HEAD']);
    await git.raw(['clean', '-fd']);
  }

  const ahead = Number.parseInt((await git.raw(['rev-list', '--count', `${REPORTS_UPSTREAM}..HEAD`])).trim(), 10);
  if (ahead > 0) {
    try {
      await git.rebase([REPORTS_UPSTREAM]);
      return;
    } catch (e) {
      try {
        await git.rebase(['--abort']);
      } catch {
        // no rebase in progress
      }
      log.debug(`[reports] dropping ${ahead} unpushed report commit(s) that conflict with ${REPORTS_UPSTREAM}: ${(e as Error).message}`);
    }
  }
  await git.raw(['reset', '--hard', REPORTS_UPSTREAM]);
}

const MAX_PUSH_RETRIES = 5;

/** A report change written into the worktree by an `updateReports` callback. */
export interface ReportsWrite {
  /** Paths relative to the reports worktree (files or directories) to commit. */
  files: string[];
  message: string;
}

/**
 * Write report data on top of origin's latest reports branch and publish it.
 *
 * Every report writer merges into an existing per-member file (stats, votes,
 * session log, member roster), so the merge must start from origin's copy, not
 * from whatever this checkout last saw. Under the reports lock this syncs the
 * worktree, runs `write` (which reads, merges, and writes files inside the
 * worktree and returns what changed, or null for nothing), then commits and
 * pushes with fetch + rebase retries.
 *
 * @returns true if something was committed & pushed. false when there was
 *   nothing to publish, another report write holds the lock, or commit/push
 *   failed (best-effort, logged at debug level). Errors from creating the
 *   worktree or from `write` propagate to the caller.
 */
export async function updateReports(
  localConfig: LocalConfig,
  write: (worktree: string) => Promise<ReportsWrite | null>,
): Promise<boolean> {
  if (!usesReportsBranch(localConfig)) {
    throw new Error('updateReports requires a repo that stores reports on the teamai-reports branch');
  }

  const lockPath = reportsLockPath(localConfig);
  if (!(await acquireLock(lockPath))) {
    log.debug('[reports] another reports write is in progress; skipping');
    return false;
  }

  try {
    const wt = await ensureReportsWorktree(localConfig);
    try {
      await syncReportsWorktree(wt);
    } catch (e) {
      log.debug(`[reports] sync before write failed, writing onto the local copy: ${(e as Error).message}`);
    }

    const change = await write(wt);
    if (!change || change.files.length === 0) {
      return false;
    }
    return await commitAndPush(wt, change);
  } finally {
    await releaseLock(lockPath);
  }
}

/** Commit `change` in the worktree and push it. Caller holds the reports lock. */
async function commitAndPush(wt: string, change: ReportsWrite): Promise<boolean> {
  const git = createGit(wt);
  try {
    await git.add(change.files);
    const status = await git.status();
    if (status.staged.length === 0) {
      log.debug('[reports] nothing to commit');
      return false;
    }

    await commitSkippingHooks(git, change.message);

    // Push with fetch+rebase retry. The write started from a freshly synced
    // worktree, so a rebase conflict needs the same member writing the same file
    // from another checkout within seconds; the next sync drops such a commit.
    for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
      try {
        await git.push(['origin', REPORTS_BRANCH]);
        return true;
      } catch (pushErr) {
        if (attempt === MAX_PUSH_RETRIES) {
          log.debug(`[reports] push failed after ${attempt} attempts: ${(pushErr as Error).message}`);
          return false;
        }
        try {
          await fetchReportsBranch(git);
          await git.rebase([REPORTS_UPSTREAM]);
        } catch (rebaseErr) {
          log.debug(`[reports] rebase failed, retrying: ${(rebaseErr as Error).message}`);
          // Abort a half-finished rebase so the next attempt starts clean.
          try {
            await git.rebase(['--abort']);
          } catch {
            // no rebase in progress
          }
        }
      }
    }
    return false;
  } catch (e) {
    log.debug(`[reports] commit/push failed (non-blocking): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Best-effort refresh of the reports worktree from origin so readers (pull's
 * search index and recommendations, members, digest, maintenance) see other
 * members' latest data. Read-only callers pass `pushIfCreated: false`. When a
 * report write holds the lock, the local copy is used as-is. Never throws.
 * Safe: only touches the orphan-branch worktree, never the active tree.
 */
export async function refreshReportsWorktree(
  localConfig: LocalConfig,
  options: EnsureReportsWorktreeOptions = {},
): Promise<void> {
  if (!usesReportsBranch(localConfig)) {
    return;
  }

  const lockPath = reportsLockPath(localConfig);
  let locked = false;
  try {
    locked = await acquireLock(lockPath);
    const wt = await ensureReportsWorktree(localConfig, options);
    if (!locked) {
      log.debug('[reports] a reports write is in progress; reading the local copy');
      return;
    }
    await syncReportsWorktree(wt);
  } catch (e) {
    log.debug(`[reports] refresh skipped: ${(e as Error).message}`);
  } finally {
    if (locked) {
      await releaseLock(lockPath);
    }
  }
}

/**
 * Ensure the reports directory exists and return it. For non-HTTP repos this
 * creates the reports worktree first; HTTP keeps reports alongside knowledge.
 */
export async function ensureReportsDir(localConfig: LocalConfig): Promise<string> {
  if (usesReportsBranch(localConfig)) {
    return ensureReportsWorktree(localConfig);
  }
  return getReportsDir(localConfig);
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
  const repoRoot = businessRoot(localConfig);
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
