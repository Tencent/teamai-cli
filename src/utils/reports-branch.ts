/**
 * Single-repo mode: manage the `teamai-reports` orphan branch via an isolated
 * git worktree under <business-repo>/.teamai/reports-wt.
 *
 * Why an orphan branch + dedicated worktree?
 *  - In single-repo mode the business repo IS the team repo. High-frequency,
 *    noisy report data (members/sessions/votes/stats) must NOT pollute main.
 *    The orphan branch has an independent history, so main stays clean.
 *  - Report writes involve `git reset --hard` / `rebase --hard`. Running those
 *    on the user's active working tree would destroy their uncommitted business
 *    code. A separate worktree confines every destructive git op to the orphan
 *    branch checkout — the active tree is never touched.
 *
 * Concurrency: the branch is shared by the whole team, but each member only ever
 * writes their own `<user>.yaml`, so files never collide. Pushes race at the git
 * layer (non-fast-forward); we resolve with fetch + rebase + retry.
 */
import path from 'node:path';
import fse from 'fs-extra';
import { createGit, isGitRepo, getDefaultBranch, hasCommits } from './git.js';
import { acquireLock, releaseLock } from '../update.js';
import { ensureDir, writeFile, pathExists } from './fs.js';
import { log } from './logger.js';
import {
  REPORTS_BRANCH,
  REPORTS_WORKTREE_DIRNAME,
  REPORTS_LOCK_FILENAME,
  KNOWLEDGE_WORKTREE_DIRNAME,
  getReportsDir,
  type LocalConfig,
} from '../types.js';

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

/** Path to the reports worktree directory (<repo>/.teamai/reports-wt). */
function reportsWorktreePath(localConfig: LocalConfig): string {
  return path.join(localConfig.repo.localPath, REPORTS_WORKTREE_DIRNAME);
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
 * Ensure a git worktree checked out on the `teamai-reports` orphan branch exists
 * at <repo>/.teamai/reports-wt. Idempotent. Returns the worktree absolute path.
 *
 * Cold-start cases handled:
 *  - worktree already present  → return it (optionally refreshed by caller).
 *  - remote branch exists      → worktree add --track -b from origin/teamai-reports.
 *  - remote branch absent      → create the orphan branch locally, then first-push.
 */
export async function ensureReportsWorktree(localConfig: LocalConfig): Promise<string> {
  const wt = reportsWorktreePath(localConfig);
  const repoRoot = businessRoot(localConfig);

  // Already a valid worktree — nothing to do.
  if (await isGitRepo(wt)) {
    return wt;
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
      await git.fetch(['origin', REPORTS_BRANCH]);
    } catch {
      // fetch may fail offline; worktree add can still work if we have it locally
    }
    // If a local branch of the same name exists, add tracking it; otherwise create tracking branch.
    const branches = await git.branchLocal();
    if (branches.all.includes(REPORTS_BRANCH)) {
      await git.raw(['worktree', 'add', wt, REPORTS_BRANCH]);
    } else {
      await git.raw(['worktree', 'add', wt, '--track', '-b', REPORTS_BRANCH, `origin/${REPORTS_BRANCH}`]);
    }
  } else {
    // Remote branch absent: create the orphan branch in the worktree.
    await createOrphanWorktree(repoRoot, wt);
    await writeWorktreeGitignore(wt);
    const wtGit = createGit(wt);
    await wtGit.add(['.gitignore']);
    await wtGit.commit('[teamai] Initialize reports branch');
    try {
      await wtGit.push(['-u', 'origin', REPORTS_BRANCH]);
    } catch (e) {
      log.debug(`[reports] initial push skipped: ${(e as Error).message}`);
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

const MAX_PUSH_RETRIES = 5;

/**
 * Commit the given files (relative to the reports worktree) to the reports orphan
 * branch and push, retrying with fetch + rebase on non-fast-forward races.
 *
 * Callers write their files into getReportsDir(localConfig)/<...> (which is the
 * worktree) BEFORE calling this. Best-effort: logs and returns false on failure
 * rather than throwing, matching the existing pushRepoDirectly contract.
 *
 * @returns true if something was committed & pushed, false if nothing to do or on failure.
 */
export async function commitAndPushReports(
  localConfig: LocalConfig,
  message: string,
  files: string[],
): Promise<boolean> {
  const lockPath = path.join(localConfig.repo.localPath, REPORTS_LOCK_FILENAME);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    log.debug('[reports] another reports write is in progress; skipping');
    return false;
  }

  try {
    const wt = await ensureReportsWorktree(localConfig);
    const git = createGit(wt);

    await git.add(files);
    const status = await git.status();
    if (status.staged.length === 0) {
      log.debug('[reports] nothing to commit');
      return false;
    }

    await git.commit(message);

    // Push with fetch+rebase retry. Each member only writes <user>.yaml, so
    // rebase conflicts are effectively impossible; retries handle the pure
    // non-fast-forward race.
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
          await git.fetch(['origin', REPORTS_BRANCH]);
          await git.rebase([`origin/${REPORTS_BRANCH}`]);
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
    log.debug(`[reports] commitAndPushReports failed (non-blocking): ${(e as Error).message}`);
    return false;
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Best-effort refresh of the reports worktree from origin so reader commands
 * (digest/members/stats) see other members' latest data. Safe: only touches the
 * orphan-branch worktree, never the active tree.
 */
export async function refreshReportsWorktree(localConfig: LocalConfig): Promise<void> {
  try {
    const wt = await ensureReportsWorktree(localConfig);
    const git = createGit(wt);
    await git.fetch(['origin', REPORTS_BRANCH]);
    await git.raw(['reset', '--hard', `origin/${REPORTS_BRANCH}`]);
  } catch (e) {
    log.debug(`[reports] refresh skipped: ${(e as Error).message}`);
  }
}

/**
 * Ensure the reports directory exists and return it. For self mode this creates
 * the worktree first; for other modes it just returns localPath (reports live
 * alongside knowledge).
 */
export async function ensureReportsDir(localConfig: LocalConfig): Promise<string> {
  if (localConfig.repo.kind === 'self') {
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
