import fs from 'node:fs';
import fse from 'fs-extra';
import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from './logger.js';

/**
 * Create a SimpleGit instance for a given base path.
 *
 * Authentication is handled by credentials embedded in the remote URL
 * (set during clone by the provider). No credential-helper injection needed.
 */
export function createGit(basePath?: string): SimpleGit {
  if (basePath) {
    return simpleGit({ baseDir: basePath });
  }
  return simpleGit();
}

/**
 * Initialize an empty git repo at localPath and add the remote.
 * Used as fallback when cloning an empty remote repo doesn't create the directory.
 */
export async function initRepo(remote: string, localPath: string): Promise<void> {
  await fse.ensureDir(localPath);
  const git = simpleGit({ baseDir: localPath });
  await git.init();
  await git.addRemote('origin', remote);
}

/**
 * Configure git user.name and user.email for a repo.
 *
 * If email is not provided and defaultEmailDomain is given,
 * generates `<username>@<domain>`. If neither is provided,
 * skips email configuration (uses git global config).
 */
export async function configureGitUser(
  localPath: string,
  username: string,
  displayName?: string,
  email?: string,
  defaultEmailDomain?: string,
): Promise<void> {
  const git = createGit(localPath);
  const name = displayName || username;
  await git.addConfig('user.name', name);

  const resolvedEmail = email
    || (defaultEmailDomain ? `${username}@${defaultEmailDomain}` : null);

  if (resolvedEmail) {
    await git.addConfig('user.email', resolvedEmail);
    log.debug(`Git user configured: ${name} <${resolvedEmail}>`);
  } else {
    log.debug(`Git user configured: ${name} (email from global git config)`);
  }
}

/**
 * Get the current HEAD commit hash (short form) of a repo.
 */
export async function getHeadRev(localPath: string): Promise<string> {
  const git = createGit(localPath);
  return git.revparse(['--short', 'HEAD']);
}

export async function pullRepo(localPath: string): Promise<string> {
  const git = createGit(localPath);
  const result = await git.pull();
  if (result.summary.changes === 0 && result.summary.insertions === 0 && result.summary.deletions === 0) {
    return 'already up to date';
  }
  return `${result.summary.changes} file(s) changed`;
}

/**
 * Detect the default branch of a repo. Tries in order:
 *   1. origin/HEAD symbolic ref (set by clone or `git remote set-head -a`)
 *   2. origin/main (modern default)
 *   3. origin/master (legacy default)
 *   4. Falls back to 'main'
 *
 * Result is cached per-repo for the process lifetime to avoid repeated git calls.
 */
const defaultBranchCache = new Map<string, string>();
export async function getDefaultBranch(localPath: string): Promise<string> {
  const cached = defaultBranchCache.get(localPath);
  if (cached) return cached;

  const git = createGit(localPath);
  let branch: string | null = null;

  try {
    const ref = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
    if (ref.startsWith('origin/')) {
      branch = ref.slice('origin/'.length);
    }
  } catch {
    // origin/HEAD not set; fall through
  }

  if (!branch) {
    for (const candidate of ['main', 'master']) {
      try {
        await git.revparse([`origin/${candidate}`]);
        branch = candidate;
        break;
      } catch {
        // not found; try next
      }
    }
  }

  branch = branch ?? 'main';
  defaultBranchCache.set(localPath, branch);
  return branch;
}

/**
 * Push directly to the current branch (master). Used only during init for first-time setup.
 */
export async function pushRepoDirectly(localPath: string, message: string, files: string[]): Promise<void> {
  const git = createGit(localPath);
  const existingFiles = [];
  for (const f of files) {
    const fullPath = fs.existsSync(`${localPath}/${f}`);
    if (fullPath) existingFiles.push(f);
  }
  if (existingFiles.length === 0) {
    log.debug('No files to add');
    return;
  }
  await git.add(existingFiles);
  const status = await git.status();
  if (status.staged.length === 0) {
    log.debug('Nothing to commit');
    return;
  }
  await git.commit(message);
  // Use --set-upstream for first push on repos initialized from empty remotes
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  await git.push(['-u', 'origin', branch]);
}

/**
 * Best-effort push all changes in a team repo clone.
 * Logs success/failure without throwing.
 */
export async function autoPushTeamRepo(repoPath: string, message: string): Promise<void> {
  try {
    await pushRepoDirectly(repoPath, message, ['.']);
  } catch {
    // non-blocking: user can manually run teamai push
  }
}

/**
 * Create a new branch, commit files, and push the branch to remote.
 * Returns false if there are no changes to commit.
 * Leaves the local repo on the new branch after pushing so that
 * the provider's createPullRequest (which may internally push HEAD)
 * sees the correct branch.
 * Callers should call `checkoutMaster()` when they are done.
 */
export async function pushRepoBranch(
  localPath: string,
  message: string,
  files: string[],
  branchName: string,
): Promise<boolean> {
  const git = createGit(localPath);

  // Create and switch to new branch
  await git.checkoutLocalBranch(branchName);

  // Stage files
  await git.add(files);
  const status = await git.status();
  if (status.staged.length === 0) {
    const defaultBranch = await getDefaultBranch(localPath);
    log.debug(`Nothing to commit, switching back to ${defaultBranch}`);
    await git.checkout(defaultBranch);
    await git.deleteLocalBranch(branchName, true);
    return false;
  }

  // Commit and push branch
  await git.commit(message);
  await git.push(['-u', 'origin', branchName]);

  return true;
}

/**
 * Switch the repo back to its default branch (main/master).
 * Used after pushRepoBranch + createPullRequest.
 */
export async function checkoutMaster(localPath: string): Promise<void> {
  const git = createGit(localPath);
  const defaultBranch = await getDefaultBranch(localPath);
  await git.checkout(defaultBranch);
}

/**
 * Generate a branch name for teamai push.
 */
export function generateBranchName(username: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `teamai/push/${username}/${timestamp}`;
}

/**
 * Reset the team repo to a clean default-branch state.
 *
 * The team repo is a local cache — any uncommitted or conflicted state is
 * safe to discard. This handles multiple failure modes:
 *
 *  1. Unmerged files WITHOUT MERGE_HEAD (incomplete merge where HEAD was
 *     removed but conflict markers remain) — `merge --abort` would fail,
 *     so we use `git reset --hard HEAD`.
 *  2. Active merge with MERGE_HEAD — `merge --abort` works, but
 *     `reset --hard` handles this too.
 *  3. Stuck on a stale push branch — switch back to the default branch.
 *  4. Uncommitted modifications — reset discards them.
 */
export async function resetToCleanMaster(git: SimpleGit, localPath?: string): Promise<void> {
  const status = await git.status();
  const hasConflicts = status.conflicted.length > 0;
  const isDirty = hasConflicts
    || status.modified.length > 0
    || status.not_added.length > 0
    || status.created.length > 0;

  if (isDirty) {
    log.debug(
      `Resetting dirty team repo (${status.conflicted.length} conflicted, `
      + `${status.modified.length} modified, ${status.not_added.length} untracked)`,
    );
    await git.reset(['--hard', 'HEAD']);
  }

  // Ensure we're on the default branch (previous push may have left us on a feature branch)
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  // Resolve default branch from localPath if given, otherwise infer from origin/HEAD via git
  let defaultBranch = 'main';
  if (localPath) {
    defaultBranch = await getDefaultBranch(localPath);
  } else {
    try {
      const ref = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
      if (ref.startsWith('origin/')) defaultBranch = ref.slice('origin/'.length);
    } catch {
      // origin/HEAD not set; use 'main' as best guess
    }
  }
  if (branch !== defaultBranch) {
    log.debug(`Switching from stale branch '${branch}' back to ${defaultBranch}`);
    await git.checkout(defaultBranch);
  }
}

/**
 * Get the raw content of a file at a specific git revision.
 * Uses `git show <rev>:<path>` to retrieve historical file content.
 * Returns null if the file doesn't exist at that revision or if the rev is invalid.
 */
export async function getFileContentAtRev(
  repoPath: string,
  rev: string,
  filePath: string,
): Promise<Buffer | null> {
  const git = createGit(repoPath);
  try {
    const result = await git.show([`${rev}:${filePath}`]);
    return Buffer.from(result);
  } catch {
    return null;
  }
}

export async function getRepoStatus(localPath: string): Promise<{ ahead: number; behind: number; modified: string[] }> {
  const git = createGit(localPath);
  await git.fetch();
  const status = await git.status();
  return {
    ahead: status.ahead,
    behind: status.behind,
    modified: [...status.modified, ...status.not_added, ...status.created],
  };
}
