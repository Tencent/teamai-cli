import { writeFile, readFile, unlink, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger.js';

/** Duration after which a lock file is considered stale and safe to ignore. */
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours; a lock older than this is stale

/** Module-level reference counts for reentrant locking within the same process. */
const refCounts = new Map<string, number>();

/** Metadata written into the lock file. */
interface ImportLockMeta {
  pid: number;
  host: string;
  startedAt: string;   // ISO
  teamRepo: string;    // resolved team repo path
}

/**
 * Returns the lock file path for a given team repo directory.
 * Placed in the parent of the resolved team repo path so it is never touched
 * by git operations (reset, clean, checkout) running inside the repo itself.
 */
function lockPathFor(teamRepoPath: string): string {
  return path.join(path.dirname(path.resolve(teamRepoPath)), '.teamai-import.lock');
}

/**
 * Acquire the import lock for the given team repo directory.
 * Returns an idempotent async release function.
 *
 * Re-entrant within the same process: a reference count is maintained so that
 * nested acquire/release pairs do not prematurely delete the lock file written
 * by the outermost caller. The lock file is only created on the first acquire
 * (ref count 0 → 1) and only deleted on the last release (ref count 1 → 0).
 *
 * Lock acquisition is best-effort: if writing the lock file fails, the error is
 * logged at debug level and execution continues — the lock is a protective hint,
 * not a hard barrier that should block an import from running.
 *
 * @param teamRepoPath - Path to the team repo directory (will be resolved).
 * @returns An async release function. Calling it multiple times is safe (idempotent).
 */
export async function acquireImportLock(teamRepoPath: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(teamRepoPath);

  const count = refCounts.get(lockPath) ?? 0;
  refCounts.set(lockPath, count + 1);

  if (count === 0) {
    // First acquire: write the lock file.
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const meta: ImportLockMeta = {
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        teamRepo: path.resolve(teamRepoPath),
      };
      await writeFile(lockPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
      log.debug(`[import-lock] Failed to write lock file ${lockPath}: ${(e as Error).message}`);
    }
  }

  let released = false;

  return async (): Promise<void> => {
    if (released) return;
    released = true;

    const cur = refCounts.get(lockPath) ?? 0;
    const next = Math.max(0, cur - 1);

    if (next === 0) {
      refCounts.delete(lockPath);
      try {
        await unlink(lockPath);
      } catch (e) {
        log.debug(`[import-lock] Failed to remove lock file ${lockPath}: ${(e as Error).message}`);
      }
    } else {
      refCounts.set(lockPath, next);
    }
  };
}

/**
 * Check whether an import is currently in progress for the given team repo.
 *
 * Intended to be called by reportUsageToTeam before executing git reset --hard.
 * Returns true when a live import lock is detected, in which case the caller
 * should skip the reset and pull to avoid overwriting uncommitted import artifacts.
 *
 * Detection strategy:
 * - Same host: use process.kill(pid, 0) to probe whether the locking process is alive.
 * - Different host: cannot probe remotely; treat any non-stale lock as active.
 * - Stale lock (older than LOCK_TTL_MS): treat as abandoned and clean up.
 * - Malformed lock: fall back to file mtime; a fresh but unreadable file is treated
 *   as active to err on the side of protecting uncommitted data.
 *
 * @param teamRepoPath - Path to the team repo directory (will be resolved).
 * @returns True if an active import lock is detected, false otherwise.
 */
export async function isImportInProgress(teamRepoPath: string): Promise<boolean> {
  const lockPath = lockPathFor(teamRepoPath);

  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    // File absent (ENOENT) or unreadable — no lock.
    return false;
  }

  let meta: ImportLockMeta;
  try {
    meta = JSON.parse(raw) as ImportLockMeta;

    // Check TTL.
    const parsed = Date.parse(meta.startedAt);
    const age = Number.isNaN(parsed) ? Infinity : Date.now() - parsed;

    if (age > LOCK_TTL_MS) {
      // Stale lock — clean up and report no active import.
      try {
        await unlink(lockPath);
      } catch (e) {
        log.debug(`[import-lock] Failed to remove stale lock ${lockPath}: ${(e as Error).message}`);
      }
      return false;
    }

    if (meta.host === os.hostname()) {
      // Same host: probe the locking process via signal 0.
      try {
        process.kill(meta.pid, 0);
        // No exception thrown — process is alive — import is in progress.
        return true;
      } catch {
        // Process is dead (ESRCH) — stale lock.
        try {
          await unlink(lockPath);
        } catch (e) {
          log.debug(
            `[import-lock] Failed to remove dead-process lock ${lockPath}: ${(e as Error).message}`,
          );
        }
        return false;
      }
    }

    // Different host — cannot probe; treat as active within TTL.
    return true;
  } catch {
    // JSON parse failed — fall back to mtime heuristic.
    try {
      const { mtimeMs } = await stat(lockPath);
      if (Date.now() - mtimeMs <= LOCK_TTL_MS) {
        // Fresh but unreadable — treat as active to protect uncommitted data.
        return true;
      }
      try {
        await unlink(lockPath);
      } catch (e) {
        log.debug(`[import-lock] Failed to remove malformed lock ${lockPath}: ${(e as Error).message}`);
      }
      return false;
    } catch {
      return false;
    }
  }
}
