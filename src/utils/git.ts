import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from './logger.js';

export function createGit(basePath?: string): SimpleGit {
  return simpleGit(basePath ? { baseDir: basePath } : undefined);
}

export async function cloneRepo(remote: string, localPath: string): Promise<void> {
  const git = simpleGit();
  await git.clone(remote, localPath);
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

export async function pushRepo(localPath: string, message: string, files: string[]): Promise<void> {
  const git = createGit(localPath);
  await git.add(files);
  const status = await git.status();
  if (status.staged.length === 0) {
    log.debug('Nothing to commit');
    return;
  }
  await git.commit(message);
  await git.push();
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
