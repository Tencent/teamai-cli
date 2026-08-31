import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fs.js';
import { pushLearningToOrigin } from './git.js';
import { withTimeout } from './async.js';
import { log } from './logger.js';

/**
 * Directory holding learnings whose push failed, persisted OUTSIDE the team-repo
 * clone so a `git reset --hard` inside the clone (pullRepo's diverged realign)
 * cannot discard them. Placed as a sibling of the clone root.
 */
export function pendingLearningsDir(repoPath: string): string {
  return path.join(path.dirname(repoPath), 'pending-learnings');
}

/**
 * Persist a learning whose push failed, so the next pull can retry it.
 *
 * @param repoPath - Team-repo clone root.
 * @param filename - Learning file name (e.g. `foo-2026-01-01-ab12cd.md`).
 * @param content - Full learning file content.
 *
 * Precondition: repoPath is a dedicated team-repo clone root, NOT a single-repo
 * `<business>/.teamai` path — callers must guard self mode (pull.ts and
 * contribute.ts already do).
 */
export async function savePendingLearning(
  repoPath: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = pendingLearningsDir(repoPath);
  await ensureDir(dir);
  await fs.promises.writeFile(path.join(dir, filename), content, 'utf-8');
}

/**
 * Re-push learnings saved by a previous failed contribute. Best-effort:
 * copies each into the clone's `learnings/` and pushes it, dropping the pending
 * copy only after a successful push. Stops at the first push failure (network
 * still down) so the remainder are retried next time; unreadable entries are
 * skipped. Returns the number successfully pushed.
 *
 * @param repoPath - Team-repo clone root.
 * @param username - Contributor name for the commit message.
 * @returns Count of pending learnings pushed this run.
 *
 * Precondition: repoPath is a dedicated team-repo clone root, NOT a single-repo
 * `<business>/.teamai` path — callers must guard self mode (pull.ts and
 * contribute.ts already do).
 */
export async function flushPendingLearnings(repoPath: string, username: string): Promise<number> {
  const dir = pendingLearningsDir(repoPath);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }

  let pushed = 0;
  for (const filename of names) {
    if (filename.startsWith('.')) {
      continue;
    }
    const pendingPath = path.join(dir, filename);
    let content: string;
    try {
      content = await fs.promises.readFile(pendingPath, 'utf-8');
    } catch {
      // Not a readable file (e.g. a subdirectory) — skip it.
      continue;
    }
    try {
      const destDir = path.join(repoPath, 'learnings');
      await ensureDir(destDir);
      await fs.promises.writeFile(path.join(destDir, filename), content, 'utf-8');
      const commitMsg = `[teamai] Contribute session knowledge from ${username}`;
      const confirmed = await withTimeout(
        pushLearningToOrigin(repoPath, filename, commitMsg),
        10_000,
        'Push timeout (10s)',
      );
      if (!confirmed) {
        // Push returned but the branch is still ahead of origin — do NOT drop
        // the durable backup; retry on the next pull.
        log.debug(`flushPendingLearnings: ${filename} not confirmed on origin, keeping backup`);
        break;
      }
      await fs.promises.rm(pendingPath, { force: true });
      pushed += 1;
    } catch (e) {
      log.debug(`flushPendingLearnings: retry deferred for ${filename}: ${(e as Error).message}`);
      break;
    }
  }
  if (pushed > 0) {
    log.debug(`flushPendingLearnings: re-pushed ${pushed} pending learning(s)`);
  }
  return pushed;
}
