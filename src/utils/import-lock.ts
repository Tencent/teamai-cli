import { writeFile, readFile, unlink, stat, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { log } from './logger.js';

/** Duration after which a lock file is considered stale and safe to ignore. */
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours; a lock older than this is stale

/** Module-level reference counts for reentrant locking within the same process. */
const refCounts = new Map<string, number>();

/** What this process wrote to each lock file it holds: the last release removes the file only while it still says so. */
const written = new Map<string, string>();

/** The first directory an acquire created for a lock file, by lock path: the last release removes it again when empty. */
const createdDirs = new Map<string, string>();

/** Removes the directories from `dir` up to `created`, while each is empty, so a refused import leaves no output behind. */
async function removeEmptyDirs(dir: string, created: string): Promise<void> {
  for (let current = dir; current.startsWith(created); current = path.dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }

    if (current === created) return;
  }
}

/** Metadata written into the lock file. */
interface ImportLockMeta {
  pid: number;
  host: string;
  startedAt: string;   // ISO
  teamRepo: string;    // the resolved holder: the team repo, else the teamwiki directory
}

/**
 * The lock fields isImportInProgress reads. A mistyped field, or a JSON value that is not an
 * object, reads as absent, as a bare property read did; a null document is malformed.
 */
const ImportLockFieldsSchema = z
  .unknown()
  .refine((value) => value !== null)
  .pipe(
    z
      .object({
        pid: z.number().optional().catch(undefined),
        host: z.string().optional().catch(undefined),
        startedAt: z.string().optional().catch(undefined),
      })
      .catch({}),
  );

/**
 * The lock file of the teamwiki `holder` names: the team repo that holds it, or the teamwiki directory itself when no
 * team repo does. It sits in the holder's parent, so git operations inside a team repo never touch it.
 */
function lockPathFor(holder: string): string {
  return path.join(path.dirname(path.resolve(holder)), '.teamai-import.lock');
}

/**
 * Names the process that holds an import lock, `<pid>@<host>`. The steps of the run that process drives inherit it, so
 * a step that locks the teamwiki goes on under its hold instead of refusing.
 */
const LOCK_HOLDER_ENV = 'TEAMAI_IMPORT_LOCK_HOLDER';

/** Whether the lock file at `lockPath` names the process that started this one with its hold, as LOCK_HOLDER_ENV says. */
async function isHeldAbove(lockPath: string): Promise<boolean> {
  const above = process.env[LOCK_HOLDER_ENV];

  if (above === undefined || above === `${process.pid}@${os.hostname()}`) return false;

  try {
    const meta = ImportLockFieldsSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));

    return `${meta.pid}@${meta.host}` === above;
  } catch {
    return false;
  }
}

/** Another live process holds the import lock of a teamwiki. */
export class ImportLockHeldError extends Error {
  readonly name = 'ImportLockHeldError';
}

/** Who holds a lock, as the refusal names it; empty when the file does not say. */
async function holderOf(lockPath: string): Promise<string> {
  try {
    const meta = ImportLockFieldsSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));

    return meta.pid !== undefined && meta.host !== undefined ? ` (process ${meta.pid} on ${meta.host})` : '';
  } catch {
    return '';
  }
}

/** Removes the lock file at `lockPath` only while it still holds `raw`, so a lock another process took meanwhile stays. */
async function removeIfUnchanged(lockPath: string, raw: string, failure: string): Promise<void> {
  try {
    if (await readFile(lockPath, 'utf8') === raw) await unlink(lockPath);
  } catch (e) {
    log.debug(`[import-lock] ${failure} ${lockPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Writes the lock file only when none exists; false when one does. */
async function createLockFile(lockPath: string, meta: ImportLockMeta): Promise<boolean> {
  try {
    await writeFile(lockPath, JSON.stringify(meta, null, 2), { encoding: 'utf8', flag: 'wx' });

    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Acquire the exclusive import lock of the teamwiki `holder` names (see `lockPathFor`), so two imports never write one
 * teamwiki at once. Returns an idempotent async release function.
 *
 * Re-entrant within the same process: a reference count is maintained so that
 * nested acquire/release pairs do not prematurely delete the lock file written
 * by the outermost caller. The lock file is only created on the first acquire
 * (ref count 0 → 1) and only deleted on the last release (ref count 1 → 0).
 * Re-entrant for a workflow step too: a process that inherited the holder's
 * LOCK_HOLDER_ENV goes on under its hold, and its release leaves the file.
 *
 * A lock another live process holds refuses the acquire; one left by a process that is gone, or older than the TTL, is
 * removed and created anew, exclusively, so of two imports that take it over at once one refuses. A lock file that
 * cannot be written at all is logged at debug level and the import goes on.
 *
 * @param holder - The team repo that holds the teamwiki, else the teamwiki directory.
 * @returns An async release function. Calling it multiple times is safe (idempotent).
 * @throws ImportLockHeldError when another live process holds the lock.
 */
export async function acquireImportLock(holder: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(holder);
  const count = refCounts.get(lockPath) ?? 0;

  if (count === 0) {
    const meta: ImportLockMeta = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      teamRepo: path.resolve(holder),
    };

    try {
      const created = await mkdir(path.dirname(lockPath), { recursive: true });

      if (created) createdDirs.set(lockPath, created);

      // isImportInProgress removes a lock whose process is gone or that is stale; another import may create it first.
      if (!(await createLockFile(lockPath, meta))) {
        if (await isHeldAbove(lockPath)) return async () => {};

        if (await isImportInProgress(holder) || !(await createLockFile(lockPath, meta))) {
          throw new ImportLockHeldError(`Another teamai import is writing this teamwiki${await holderOf(lockPath)}. `
            + `Wait for it to finish, then run this command again. If no import is running, remove ${lockPath}.`);
        }
      }

      written.set(lockPath, JSON.stringify(meta, null, 2));

      process.env[LOCK_HOLDER_ENV] = `${meta.pid}@${meta.host}`;
    } catch (e) {
      if (e instanceof ImportLockHeldError) throw e;
      log.debug(`[import-lock] Failed to write lock file ${lockPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  refCounts.set(lockPath, count + 1);

  let released = false;

  return async (): Promise<void> => {
    if (released) return;
    released = true;

    const cur = refCounts.get(lockPath) ?? 0;
    const next = Math.max(0, cur - 1);

    if (next === 0) {
      refCounts.delete(lockPath);
      const own = written.get(lockPath);
      written.delete(lockPath);

      if (own !== undefined) await removeIfUnchanged(lockPath, own, 'Failed to remove lock file');

      const created = createdDirs.get(lockPath);
      createdDirs.delete(lockPath);

      if (created) await removeEmptyDirs(path.dirname(lockPath), created);
    } else {
      refCounts.set(lockPath, next);
    }
  };
}

/**
 * Check whether an import is currently in progress for the given team repo.
 *
 * Intended to be called by reportUsage before executing git reset --hard.
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
 * @param teamRepoPath - The team repo that holds the teamwiki, else the teamwiki directory.
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

  try {
    const meta = ImportLockFieldsSchema.parse(JSON.parse(raw));

    // Check TTL.
    const parsed = Date.parse(meta.startedAt ?? '');
    const age = Number.isNaN(parsed) ? Infinity : Date.now() - parsed;

    if (age > LOCK_TTL_MS) {
      // Stale lock — clean up and report no active import.
      await removeIfUnchanged(lockPath, raw, 'Failed to remove stale lock');

      return false;
    }

    if (meta.host === os.hostname()) {
      // Same host: probe the locking process via signal 0.
      if (meta.pid !== undefined && isProcessAlive(meta.pid)) {
        return true;
      }

      // Process is dead (ESRCH), or the lock names none — stale lock.
      await removeIfUnchanged(lockPath, raw, 'Failed to remove dead-process lock');

      return false;
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

      await removeIfUnchanged(lockPath, raw, 'Failed to remove malformed lock');

      return false;
    } catch {
      return false;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}
