import path from 'node:path';
import fse from 'fs-extra';
import { acquireLock, releaseLock } from '../update.js';
import { LEARNINGS_LOCK_FILENAME, REPORTS_LOCK_FILENAME, SYNC_LOCK_FILENAME, WORKTREE_DIRNAMES } from '../types.js';
import { completeWorktreeList, createGitWithBlockTimeout, gitCommonDir } from './git.js';

/**
 * Keep the complete old repository, including unpublished refs and dirty side
 * worktrees, before init reuses its cache path for another team. Never move a
 * checkout whose ownership cannot be proved, or an unrelated linked worktree.
 */
export async function archiveReplacedClone(localPath: string, beforeMove: () => Promise<void>): Promise<string> {
  const parent = path.dirname(localPath);
  const locks: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  let backup: string | undefined;
  let cloneMoved = false;
  try {
    for (const name of [SYNC_LOCK_FILENAME, REPORTS_LOCK_FILENAME, LEARNINGS_LOCK_FILENAME]) {
      const lock = path.join(parent, name);
      if (!await acquireLock(lock)) throw new Error(`Cannot replace the team clone while ${lock} is held. Retry when that command finishes.`);
      locks.push(lock);
    }
    const common = await gitCommonDir(localPath);
    const gitEntry = path.join(localPath, '.git');
    const expected = await fse.realpath(gitEntry);
    if (!(await fse.lstat(gitEntry)).isDirectory() || common !== expected) throw new Error(`Cannot archive ${localPath}: it is not a dedicated team clone.`);
    const registered = await completeWorktreeList(localPath, common);
    if (!registered) throw new Error(`Cannot prove the complete worktree list for ${localPath}; the old clone was kept.`);
    const own = new Set([await fse.realpath(localPath)]);
    const side: string[] = [];
    for (const name of WORKTREE_DIRNAMES) {
      const dir = path.join(parent, name);
      const stat = await fse.lstat(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink() || await gitCommonDir(dir) !== common || !registered.includes(await fse.realpath(dir))) {
        throw new Error(`Cannot replace the team clone: ${dir} is not a proven worktree of it. Move or repair that checkout first; nothing was archived.`);
      }
      own.add(await fse.realpath(dir));
      side.push(dir);
    }
    // A user's additional checkout also depends on this .git directory.
    for (const dir of registered) {
      const real = await fse.realpath(dir).catch(() => path.resolve(dir));
      if (!own.has(real)) throw new Error(`Cannot replace the team clone: another registered worktree depends on it (${dir}). Remove or relocate it first.`);
    }
    await beforeMove();
    backup = await fse.mkdtemp(path.join(parent, 'previous-team-'));
    const git = createGitWithBlockTimeout(localPath);
    for (const from of side) {
      const to = path.join(backup, path.basename(from));
      await git.raw(['worktree', 'move', from, to]);
      moved.push({ from, to });
    }
    const savedClone = path.join(backup, path.basename(localPath));
    await fse.rename(localPath, savedClone);
    cloneMoved = true;
    if (moved.length) await createGitWithBlockTimeout(savedClone).raw(['worktree', 'repair', ...moved.map(entry => entry.to)]);
    return backup;
  } catch (error) {
    // Restore the original layout if a move fails; no destructive cleanup is
    // attempted when recovery itself fails, so every copy remains on disk.
    try {
      if (cloneMoved) await fse.rename(path.join(backup!, path.basename(localPath)), localPath);
      if (moved.length) {
        const git = createGitWithBlockTimeout(localPath);
        await git.raw(['worktree', 'repair', ...moved.map(entry => entry.to)]);
        for (const entry of [...moved].reverse()) await git.raw(['worktree', 'move', entry.to, entry.from]);
      }
      if (backup) await fse.rmdir(backup);
    } catch (recoveryError) {
      throw new Error(`Could not finish archiving the old clone or restore its layout. All data was kept at ${localPath} and ${backup}: ${String(recoveryError)}`, { cause: error });
    }
    throw error;
  } finally {
    for (const lock of locks.reverse()) await releaseLock(lock);
  }
}
