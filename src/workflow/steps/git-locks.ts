import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { entriesUnder } from '@teamai/shared/entries-under';
import { readRegularFile } from '@teamai/shared/regular-file';
import { worktreeCheckout } from '../worktree.js';

/**
 * Who made the place a stopped step ran in: teamai's `clone` (a step's clone, or the team repo's), teamai's `worktree`
 * of the member's checkout, or the member's own checkout.
 */
export type GitLockPlace = 'clone' | 'worktree' | 'member';

/**
 * Settles the locks a git process leaves when it is killed mid-write, once the tool that ran it is stopped and its
 * process group is gone, so none of them is held any more: the ones in a place teamai made are removed, and the ones in
 * the member's repository are kept, since teamai deletes nothing there, and returned. A worktree's own locks, such as
 * its `index.lock`, are teamai's; its refs are the member's checkout's.
 */
export async function settleGitLocks({ cwd, place }: { cwd: string; place: GitLockPlace }): Promise<string[]> {
  switch (place) {
    case 'clone':
      await removeLocks(await gitLocksIn(path.join(cwd, '.git')));

      return [];
    case 'worktree': {
      const checkout = worktreeCheckout(cwd);

      if (checkout === undefined) return membersLocks(cwd);
      const common = await commonGitDir(checkout);

      if (common === undefined) return [];
      const own = await worktreeGitDir(cwd, common);

      if (own !== undefined) await removeLocks(await gitLocksIn(own));

      // A step in a linked worktree writes its own index and HEAD in its own git directory: the repository's are the
      // member's, which their git may hold now.
      return (await gitLocksIn(common)).filter((lock) => path.dirname(lock) !== common || !isPerWorktreeLock(path.basename(lock)));
    }

    case 'member':
      return membersLocks(cwd);
    default: {
      const unhandled: never = place;

      return unhandled;
    }
  }
}

/** What a member runs to remove `locks`, which teamai kept in their checkout. */
export function keptLocksNotice(locks: string[], tool: string): string {
  const command = process.platform === 'win32'
    ? `Remove-Item -LiteralPath ${locks.map((lock) => `'${lock.replaceAll("'", "''")}'`).join(',')}`
    : `rm ${locks.map((lock) => `'${lock.replaceAll("'", "'\\''")}'`).join(' ')}`;

  return `Git left ${locks.join(', ')} in your checkout when teamai stopped ${tool}, and teamai deletes nothing there. Once no git runs in that checkout, remove it: ${command}`;
}

/**
 * The locks of the member's checkout holding `cwd`, a folder inside it a step may start from: its own git directory's
 * and, for a linked worktree, its repository's.
 */
async function membersLocks(cwd: string): Promise<string[]> {
  const checkout = await checkoutHolding(cwd);

  if (checkout === undefined) return [];
  const [own, common] = await Promise.all([ownGitDir(checkout), commonGitDir(checkout)]);

  if (own === undefined || common === undefined) return [];

  return own === common ? gitLocksIn(own) : [...await gitLocksIn(own), ...await gitLocksIn(common)];
}

/** The nearest folder from `cwd` up that has a `.git`, or undefined when none has. */
async function checkoutHolding(cwd: string): Promise<string | undefined> {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (await fs.lstat(path.join(dir, '.git')).catch(() => undefined)) return dir;

    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The git directory of the checkout at `checkout`: its `.git` folder, or the one its `.git` file names. */
async function ownGitDir(checkout: string): Promise<string | undefined> {
  const dotGit = path.join(checkout, '.git');
  const entry = await fs.lstat(dotGit).catch(() => undefined);

  if (entry?.isDirectory()) return dotGit;

  return entry?.isFile() ? linkedGitDir(checkout) : undefined;
}

/**
 * The git directory the checkout at `checkout` shares its refs in: its own, or for a linked worktree the one its
 * `commondir` names. A submodule's git directory has none, and is its own.
 */
async function commonGitDir(checkout: string): Promise<string | undefined> {
  const own = await ownGitDir(checkout);

  if (own === undefined) return undefined;
  const common = (await readRegularFile(path.join(own, 'commondir'), 'utf8').catch(() => '')).trim();

  return common === '' ? own : path.resolve(own, common);
}

/** A lock git takes in each worktree's own git directory: the index's, and a pseudo-ref's such as `HEAD.lock`. */
function isPerWorktreeLock(name: string): boolean {
  return name === 'index.lock' || /^[A-Z_]+\.lock$/u.test(name);
}

/** The git directory a linked worktree's `.git` file at `cwd` names, or undefined when it names none. */
async function linkedGitDir(cwd: string): Promise<string | undefined> {
  const named = /^gitdir: (.+)$/mu.exec(await readRegularFile(path.join(cwd, '.git'), 'utf8').catch(() => ''))?.[1]?.trim();

  return named === undefined || named === '' ? undefined : path.resolve(cwd, named);
}

/**
 * The git directory of teamai's worktree at `cwd`, or undefined when its `.git` names one that is not under the
 * `worktrees` of its repository's git directory `common`: the agent shaped the worktree, and a link out of it would
 * lose a lock elsewhere.
 */
async function worktreeGitDir(cwd: string, common: string): Promise<string | undefined> {
  const parts = path.resolve(cwd).split(path.sep);
  const root = parts.slice(0, parts.lastIndexOf('workflow-worktrees') + 2).join(path.sep);
  const named = await linkedGitDir(root);

  if (named === undefined) return undefined;
  const [real, worktrees] = await Promise.all([fs.realpath(named).catch(() => undefined), fs.realpath(path.join(common, 'worktrees')).catch(() => undefined)]);

  return real !== undefined && worktrees !== undefined && path.dirname(real) === worktrees ? real : undefined;
}

/**
 * The locks on which the report's commit would fail: those directly under `gitDir`, such as `index.lock` and
 * `HEAD.lock`, and those of its refs. None under `objects/` blocks a commit. A `gitDir` or `refs` that is not a real
 * directory, such as a link the agent made, is left alone.
 */
async function gitLocksIn(gitDir: string): Promise<string[]> {
  const isDirectory = async (at: string): Promise<boolean> => (await fs.lstat(at).catch(() => undefined))?.isDirectory() === true;

  if (!await isDirectory(gitDir)) return [];
  const top = await fs.readdir(gitDir, { withFileTypes: true }).catch((): Dirent[] => []);
  // The walk enters no link under refs, which the agent may have made too: one out of the place would lose a lock there.
  const refs = await isDirectory(path.join(gitDir, 'refs')) ? refsUnder(path.join(gitDir, 'refs')) : [];

  // A folder the agent named like a lock is none of git's, and rm would refuse it.
  return [...top.map((entry) => ({ at: path.join(gitDir, entry.name), entry })), ...refs.map(({ relative, entry }) => ({ at: path.join(gitDir, 'refs', relative), entry }))]
    .flatMap(({ at, entry }) => (at.endsWith('.lock') && !entry.isDirectory() ? [at] : []));
}

async function removeLocks(locks: string[]): Promise<void> {
  await Promise.all(locks.map((at) => fs.rm(at, { force: true })));
}

/** The entries under `refs`; none when it cannot be read, such as when it went away. */
function refsUnder(refs: string): ReturnType<typeof entriesUnder> {
  try {
    return entriesUnder(refs);
  } catch {
    return [];
  }
}
