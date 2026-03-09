import fs from 'node:fs';
import fse from 'fs-extra';
import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from './logger.js';

export function createGit(basePath?: string): SimpleGit {
  return simpleGit(basePath ? { baseDir: basePath } : undefined);
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

const DEFAULT_EMAIL_DOMAIN = 'tencent.com';

/**
 * Configure git user.name and user.email for a repo.
 * Email defaults to `<username>@tencent.com` but can be overridden.
 */
export async function configureGitUser(
  localPath: string,
  username: string,
  displayName?: string,
  email?: string,
): Promise<void> {
  const git = createGit(localPath);
  const name = displayName || username;
  const resolvedEmail = email || `${username}@${DEFAULT_EMAIL_DOMAIN}`;
  await git.addConfig('user.name', name);
  await git.addConfig('user.email', resolvedEmail);
  log.debug(`Git user configured: ${name} <${resolvedEmail}>`);
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
 * Create a new branch, commit files, and push the branch to remote.
 * Returns false if there are no changes to commit.
 * Leaves the local repo on the new branch after pushing so that
 * `gf mr create` (which internally pushes HEAD) sees the correct branch.
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
    log.debug('Nothing to commit, switching back to master');
    await git.checkout('master');
    await git.deleteLocalBranch(branchName, true);
    return false;
  }

  // Commit and push branch
  await git.commit(message);
  await git.push(['-u', 'origin', branchName]);

  return true;
}

/**
 * Switch the repo back to master. Used after pushRepoBranch + gfMrCreate.
 */
export async function checkoutMaster(localPath: string): Promise<void> {
  const git = createGit(localPath);
  await git.checkout('master');
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
