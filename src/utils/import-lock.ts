import { createHash } from 'node:crypto';
import { writeFile, readFile, unlink, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { memberHome } from './home.js';
import { log } from './logger.js';
import { withFileLock } from '../update.js';

/** Duration after which a lock file is considered stale and safe to ignore. */
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours; a lock older than this is stale

/** Module-level reference counts for reentrant locking within the same process. */
const refCounts = new Map<string, number>();

/** Metadata written into the lock file. */
interface ImportLockMeta {
  pid: number;
  host: string;
  startedAt: string;   // ISO
  teamRepo: string;    // the resolved holder: the team repo, else the teamwiki directory
  /** The `$TEAMAI_RUN_DIR` of the workflow run that holds the lock until it ends. */
  runDir?: string;
}

/**
 * The lock fields judgeLock reads. A mistyped field, or a JSON value that is not an
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
        teamRepo: z.string().optional().catch(undefined),
        runDir: z.string().optional().catch(undefined),
      })
      .catch({}),
  );

/**
 * The lock file of the teamwiki `holder` names: the team repo that holds it, or the teamwiki directory itself when no
 * team repo does. It sits under the member's `~/.teamai/locks`, the same for every process on this machine, a step's
 * in its clone too, and in no checkout, so no git operation and no read-only step check ever sees it.
 */
function lockPathFor(holder: string): string {
  const hash = createHash('sha256').update(path.resolve(holder)).digest('hex').slice(0, 16);

  return path.join(memberHome(), '.teamai', 'locks', `import-${hash}.lock`);
}

/**
 * Names the process that holds an import lock, `<pid>@<host>`. The steps of the run that process drives inherit it, so
 * a step that locks the teamwiki goes on under its hold instead of refusing.
 */
const LOCK_HOLDER_ENV = 'TEAMAI_IMPORT_LOCK_HOLDER';

type ImportLockFields = z.infer<typeof ImportLockFieldsSchema>;

/** The lock file at `lockPath` as read, with its fields; undefined when it is absent or not JSON. */
async function readLock(lockPath: string): Promise<{ raw: string; meta: ImportLockFields } | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');

    return { raw, meta: ImportLockFieldsSchema.parse(JSON.parse(raw)) };
  } catch {
    return undefined;
  }
}

/** Whether `meta` names the process that started this one with its hold, as LOCK_HOLDER_ENV says. */
function isHeldAbove(meta: ImportLockFields): boolean {
  const above = process.env[LOCK_HOLDER_ENV];

  if (above === undefined || above === `${process.pid}@${os.hostname()}`) return false;

  return `${meta.pid}@${meta.host}` === above;
}

/** Whether `meta` names a workflow run on this host that has not ended: its run directory is still there. */
async function isRunLive(meta: ImportLockFields): Promise<boolean> {
  if (meta.runDir === undefined || meta.host !== os.hostname()) return false;

  try {
    return (await stat(meta.runDir)).isDirectory();
  } catch {
    return false;
  }
}

/** Another live process or workflow run holds the import lock of a teamwiki. */
export class ImportLockHeldError extends Error {
  readonly name = 'ImportLockHeldError';
}

/** The run id of `runDir`, a run's `runs/<run>/scratch` directory; undefined for any other path. */
async function runIdOf(runDir: string): Promise<string | undefined> {
  const { isRunId } = await import('../workflow/store.js');
  const run = path.basename(path.dirname(runDir));

  return path.basename(runDir) === 'scratch' && isRunId(run) ? run : undefined;
}

/** Why the lock at `lockPath` refuses: who holds it, and how to end the workflow run that holds it, when one does. */
async function refusal(lockPath: string): Promise<string> {
  const meta = (await readLock(lockPath))?.meta;
  const holder = meta?.pid !== undefined && meta.host !== undefined ? ` (process ${meta.pid} on ${meta.host})` : '';
  const run = meta?.runDir === undefined ? undefined : await runIdOf(meta.runDir);

  if (run !== undefined) {
    return `Another teamai import is writing this teamwiki${holder}, in workflow run ${run}. `
      + `Finish it with teamai workflow resume ${run}, or cancel it with teamai workflow cancel ${run}, then run this command again.`;
  }

  return `Another teamai import is writing this teamwiki${holder}. `
    + `Wait for it to finish, then run this command again. If no import is running, remove ${lockPath}.`;
}

/** How long an import waits for another one taking a stale lock over, or releasing one, before it refuses or leaves it. */
const TAKEOVER_WAIT = { attempts: 20, delayMs: 50 };

/** The lock that serializes judging the lock at `lockPath` stale, removing it and creating it anew, and releasing it. */
function takeoverPath(lockPath: string): string {
  return `${lockPath}.takeover`;
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
 * A step passes its run's `runDir`, which the lock records, so the run holds the lock from step to step until it ends,
 * as `teamai workflow resume` drives it too: another step of that run goes on under it and refreshes its start, and no
 * release removes a lock whose run has not ended. Once the run ends, its directory is gone and the next acquire takes
 * the lock over.
 *
 * A lock another live process or run holds refuses the acquire; one left by a process and run that are gone, or older
 * than the TTL, is removed and created anew, exclusively, so of two imports that take it over at once one refuses. A
 * lock file that cannot be written at all is logged at debug level and the import goes on.
 *
 * @param holder - The team repo that holds the teamwiki, else the teamwiki directory.
 * @param runDir - The `$TEAMAI_RUN_DIR` of the workflow step that acquires it, if one does.
 * @returns An async release function. Calling it multiple times is safe (idempotent).
 * @throws ImportLockHeldError when another live process or run holds the lock.
 */
export async function acquireImportLock(holder: string, runDir?: string): Promise<() => Promise<void>> {
  const lockPath = lockPathFor(holder);
  const count = refCounts.get(lockPath) ?? 0;

  if (count === 0) {
    const meta: ImportLockMeta = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      teamRepo: path.resolve(holder),
    };

    if (runDir !== undefined) meta.runDir = path.resolve(runDir);

    try {
      await mkdir(path.dirname(lockPath), { recursive: true });

      // judgeLock removes a lock whose process is gone or that is stale; another import may create it first.
      if (!(await createLockFile(lockPath, meta))) {
        const held = (await readLock(lockPath))?.meta;

        if (held !== undefined && (isHeldAbove(held) || (meta.runDir !== undefined && held.runDir === meta.runDir && held.host === meta.host))) {
          if (meta.runDir !== undefined) {
            await writeFile(lockPath, JSON.stringify({ ...held, startedAt: meta.startedAt, runDir: meta.runDir }, null, 2), 'utf8');
          }

          return async () => {};
        }

        // One import at a time judges the lock stale, removes it and creates its own, so two that find it stale at once
        // cannot both take it over.
        const taken = await withFileLock(takeoverPath(lockPath), TAKEOVER_WAIT, async () => !(await judgeLock(lockPath)) && await createLockFile(lockPath, meta));

        if (!taken.held || !taken.value) throw new ImportLockHeldError(await refusal(lockPath));
      }

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
      // A step of this process's run may have rewritten its lock; one another process took over, or a run that has not ended holds, stays.
      await withFileLock(takeoverPath(lockPath), TAKEOVER_WAIT, async () => {
        const held = await readLock(lockPath);

        if (held !== undefined && held.meta.pid === process.pid && held.meta.host === os.hostname() && !(await isRunLive(held.meta))) {
          await removeIfUnchanged(lockPath, held.raw, 'Failed to remove lock file');
        }
      });
    } else {
      refCounts.set(lockPath, next);
    }
  };
}

/**
 * Check whether an import is currently in progress for the given team repo.
 *
 * It removes a stale lock it finds under the takeover lock, which serializes that removal with every acquire and
 * release; while another import holds the takeover lock, it reports an import in progress.
 *
 * Detection strategy:
 * - A workflow run on this host that has not ended, its run directory still there, holds it at any age.
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
  const judged = await withFileLock(takeoverPath(lockPath), TAKEOVER_WAIT, () => judgeLock(lockPath));

  return !judged.held || judged.value;
}

/** Whether the lock at `lockPath` is live, removing it when it is stale. Its caller holds the takeover lock. */
async function judgeLock(lockPath: string): Promise<boolean> {
  let raw: string;

  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    // File absent (ENOENT) or unreadable — no lock.
    return false;
  }

  try {
    const meta = ImportLockFieldsSchema.parse(JSON.parse(raw));

    // A run stopped for longer than the TTL still holds it until it is resumed to its end or cancelled.
    if (await isRunLive(meta)) return true;

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

      // Process is dead (ESRCH), or the lock names none, and no run that has not ended holds it — stale lock.
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
