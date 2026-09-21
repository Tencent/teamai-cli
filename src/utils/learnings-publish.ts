/**
 * Publishing queued learnings: the one place that knows where a learning goes.
 *
 * `teamai contribute` writes to the durable queue and calls this. So does
 * `teamai pull`, which is what makes an offline or rejected contribution reach
 * the team later instead of being lost. A queue entry is dropped only once its
 * content is confirmed on origin, so a failure of any kind is always safe.
 */
import path from 'node:path';
import fs from 'node:fs';

import { ensureDir } from './fs.js';
import { learningsBranch } from './learnings-branch.js';
import type { PublishResult } from './branch-worktree.js';
import { log } from './logger.js';
import {
  dropPendingLearning,
  listPendingLearnings,
  readPendingLearning,
} from './pending-learnings.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, SYNC_LOCK_FILENAME, type LocalConfig } from '../types.js';

export interface PublishQueueReport {
  /** Learnings confirmed on origin during this run, relative to `learnings/`. */
  published: string[];
  /** Learnings still queued afterwards. */
  remaining: number;
  /**
   * Why the queue did not drain, when it did not. Present only when something
   * is still queued because publishing failed, not when the queue was empty.
   */
  lastError?: string;
}

function commitMessageFor(username: string): string {
  return `[teamai] Contribute session knowledge from ${username}`;
}

/**
 * Publish everything in the queue, as one commit. Best-effort and non-blocking:
 * it never throws, and a failure leaves every entry queued for the next run
 * rather than hammering an unreachable origin.
 */
export async function publishQueuedLearnings(
  localConfig: LocalConfig,
  username: string,
  options: { holdsSyncLock?: boolean } = {},
): Promise<PublishQueueReport> {
  const queued = await listPendingLearnings(localConfig);
  if (queued.length === 0) {
    return { published: [], remaining: 0 };
  }

  // Publishing writes to the team clone, which `pull` and `push` guard with the
  // partition sync lock. On contention nothing is lost and nothing is forced:
  // the learnings stay queued and the run that holds the lock publishes them.
  // `pull` already holds the lock when it calls this, and the lock is not
  // reentrant, so it says so instead of deadlocking against itself.
  const syncLock = options.holdsSyncLock ? null : syncLockPath(localConfig);
  if (syncLock && !(await acquireLock(syncLock))) {
    log.debug('[learnings] a pull or push is in progress; leaving the queue for it');
    return {
      published: [],
      remaining: queued.length,
      lastError: 'another teamai pull or push is in progress',
    };
  }

  try {
    const report = await publishToLearningsBranch(localConfig, username, queued);

    for (const relPath of report.published) {
      await dropPendingLearning(localConfig, relPath);
    }
    return { ...report, remaining: queued.length - report.published.length };
  } catch (e) {
    // Never throw: a contribution is already safe in the queue, and publishing
    // it is never the reason a command fails.
    log.debug(`[learnings] publishing failed (non-blocking): ${(e as Error).message}`);
    return { published: [], remaining: queued.length, lastError: (e as Error).message };
  } finally {
    if (syncLock) await releaseLock(syncLock);
  }
}

/**
 * The partition sync lock, or null when this config cannot resolve one. A
 * `scope: 'project'` config without a project root is permitted by the schema,
 * and publishing must not be the thing that crashes on it: it just runs
 * unguarded, exactly as contribute always did.
 */
function syncLockPath(localConfig: LocalConfig): string | null {
  try {
    return path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  } catch {
    return null;
  }
}

/**
 * Publish whatever maintenance just changed in the learnings worktree.
 *
 * Pruning, promotion and confidence write-backs used to mutate a checkout
 * nothing pushes, so their result reached no teammate and the next realign
 * could undo it. They now write into the worktree, and this is what makes the
 * change leave the machine.
 */
export async function publishLearningsMaintenance(
  localConfig: LocalConfig,
  message: string,
): Promise<PublishResult> {
  // `commitAndPush`, not `update`: maintenance already wrote into the worktree
  // before this call, and `update` syncs with origin first, which can carry
  // those uncommitted files into a rebase or leave them behind.
  return learningsBranch.commitAndPush(localConfig, message, ['learnings']);
}

/**
 * Write every queued learning into the `teamai-learnings` worktree and push it.
 *
 * One path for every git-backed repo: an independent clone and a single-repo
 * business repo differ only in where the worktree sits. Nothing touches the
 * default branch, so a member needs no write access to it, and nothing touches
 * the user's active working tree either.
 */
async function publishToLearningsBranch(
  localConfig: LocalConfig,
  username: string,
  queued: string[],
): Promise<Omit<PublishQueueReport, 'remaining'>> {
  const published: string[] = [];
  // An entry nobody can read will be skipped again on every run. Naming it is
  // the difference between "1 learning is not published" forever with no
  // reason, and something the member can act on.
  const unreadable: string[] = [];

  const result = await learningsBranch.update(localConfig, async (worktree) => {
    const files: string[] = [];
    for (const relPath of queued) {
      const content = await readPendingLearning(localConfig, relPath);
      if (content === null) {
        log.debug(`[learnings] skipping unreadable queue entry ${relPath}`);
        unreadable.push(relPath);
        continue;
      }
      const destAbs = path.join(worktree, 'learnings', relPath);
      await ensureDir(path.dirname(destAbs));
      await fs.promises.writeFile(destAbs, content, 'utf-8');
      files.push(path.posix.join('learnings', relPath.split(path.sep).join('/')));
      published.push(relPath);
    }
    if (files.length === 0) return null;
    return { files, message: commitMessageFor(username) };
  });

  const unreadableReason = unreadable.length > 0
    ? `cannot read ${unreadable.join(', ')} in the contribution queue`
    : undefined;

  switch (result.status) {
    case 'published':
      return { published, lastError: unreadableReason };
    case 'already-present':
      // The branch already carries exactly this content: an earlier run pushed
      // it and could not confirm. Dropping the queue entry now is safe.
      return { published, lastError: unreadableReason };
    case 'busy':
      return { published: [], lastError: 'another teamai write is in progress' };
    case 'failed':
      return { published: [], lastError: result.reason };
  }
}
