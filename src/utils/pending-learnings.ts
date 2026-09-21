import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, listFilesRecursive } from './fs.js';
import { isSelfMode, type LocalConfig } from '../types.js';

/**
 * Durable queue of learnings a member has written but that are not published
 * yet. Every contribution lands here first, so nothing depends on the network,
 * on push rights, or on a git operation succeeding right now.
 *
 * It lives outside anything git rewrites:
 *  - git: beside the clone, where pullRepo's diverged `reset --hard` on the
 *    clone cannot reach it.
 *  - self: inside `.teamai/`, which is gitignored. The parent is the user's own
 *    product repo, where an untracked directory would show up in `git status`
 *    and be swept into a commit by `git add -A`.
 */
export function pendingLearningsDir(localConfig: LocalConfig): string {
  if (isSelfMode(localConfig)) {
    return path.join(localConfig.repo.localPath, 'pending-learnings');
  }
  return path.join(path.dirname(localConfig.repo.localPath), 'pending-learnings');
}

/**
 * Write a learning into the queue.
 *
 * @param relPath - Learning path RELATIVE to `learnings/` (e.g.
 *   `alpha-notes/foo-2026-01-01-ab12cd.md` for a project-namespaced learning, or
 *   `foo-....md` for a shared-root one). The namespace subdirectory is preserved
 *   here and when publishing, so a project contribution is never downgraded to a
 *   shared-root learning.
 */
export async function savePendingLearning(
  localConfig: LocalConfig,
  relPath: string,
  content: string,
): Promise<string> {
  const dest = path.join(pendingLearningsDir(localConfig), relPath);
  await ensureDir(path.dirname(dest));
  await fs.promises.writeFile(dest, content, 'utf-8');
  return dest;
}

/**
 * Every queued learning, as paths relative to `learnings/`, oldest entries
 * included. Hidden files and anything that is not Markdown are ignored, so a
 * stray editor swap file never reaches the team repo.
 */
export async function listPendingLearnings(localConfig: LocalConfig): Promise<string[]> {
  try {
    return (await listFilesRecursive(pendingLearningsDir(localConfig)))
      .filter((relPath) => relPath.endsWith('.md'))
      .filter((relPath) => !relPath.split('/').some((segment) => segment.startsWith('.')));
  } catch {
    return [];
  }
}

/** Read one queued learning, or null when it is unreadable. */
export async function readPendingLearning(
  localConfig: LocalConfig,
  relPath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(pendingLearningsDir(localConfig), relPath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Forget a queued learning. Only ever called once its content is confirmed on
 * origin: this copy is the only one that survives a worktree reset.
 */
export async function dropPendingLearning(
  localConfig: LocalConfig,
  relPath: string,
): Promise<void> {
  await fs.promises.rm(path.join(pendingLearningsDir(localConfig), relPath), { force: true });
}
