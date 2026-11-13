/**
 * An append-only JSON-lines file that concurrent hooks can write safely (#788,
 * #884). Every writer takes `<file>.lock`: appends, and rewrites that prune or
 * truncate. A rewrite therefore cannot drop an append made while it runs, and
 * two rewrites cannot interleave.
 *
 * An append waits only briefly for the lock, because hooks run inside the
 * host's foreground budget. When the lock stays held, the record goes to a side
 * file of its own, `<name>.pending-<uuid>.jsonl`, which the next lock holder
 * folds into the file. Readers can include those side records, so a record is
 * visible before it is folded.
 *
 * A hook process is killed when its handler times out, so any step may be cut
 * short: a lock whose owner is gone is reclaimed, a side record still missing
 * its newline is left for a later holder, a torn last line is skipped on read
 * and never glued to the next record, and a rewrite's temp copy is removed by
 * the next rewrite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isJsonObject, type JsonlRecord, type JsonValue } from '@teamai/shared/json';
import { acquireLock, releaseLock } from '../update.js';
import { ensureDir, errnoCode } from './fs.js';
import { log } from './logger.js';

/** How long a writer waits for the lock, in wall time. */
export interface LockWait {
  budgetMs: number;
  delayMs: number;
}

/** A hook append waits at most ~250 ms of wall time for the lock, inside its foreground budget. */
export const HOOK_LOCK_WAIT: LockWait = { budgetMs: 250, delayMs: 25 };

/** A rewrite waits up to ~5 s of wall time for a peer's rewrite to finish. Too long for a hook. */
export const REWRITE_LOCK_WAIT: LockWait = { budgetMs: 5_000, delayMs: 50 };

export interface JsonlStoreOptions {
  /** How long to wait for the lock. Appends default to {@link HOOK_LOCK_WAIT}, rewrites to {@link REWRITE_LOCK_WAIT}. */
  wait?: LockWait;
  /** Mode the file is created with (the umask can only narrow it). Defaults to owner-only, 0o600. */
  mode?: number;
  /** Runs before a side file (a side record or a rewrite's temp copy) is written beside the file. */
  beforeSideFile?: () => Promise<void>;
}

/** A parsed record. The side-record id the store adds is never part of it. */

const OWNER_ONLY = 0o600;

/** A record's side-record id: a string, or absent for any other value. */
const PendingIdSchema = z.string().optional().catch(undefined);

/**
 * Append one record. Returns null when it landed in the file, or the side
 * record's path when the lock was still held after the wait. Throws on I/O
 * errors; the caller decides whether a lost record is worth reporting.
 */
export async function appendJsonl<Entry extends object>(filePath: string, record: Entry, options: JsonlStoreOptions = {}): Promise<string | null> {
  return appendJsonlBatch(filePath, [record], options);
}

/**
 * Append records in order, under one lock and in one write, or in one side
 * record when the lock stays held, as {@link appendJsonl} does for one. An
 * empty batch writes nothing and returns null.
 */
export async function appendJsonlBatch(filePath: string, records: object[], options: JsonlStoreOptions = {}): Promise<string | null> {
  if (records.length === 0) return null;
  const mode = options.mode ?? OWNER_ONLY;
  await ensureDir(path.dirname(filePath));
  const lines = records.map((record) => JSON.stringify(record) + '\n').join('');

  if (await withLock(filePath, options.wait ?? HOOK_LOCK_WAIT, mode, () => appendWhole(filePath, lines, mode))) return null;
  // The lock is still held: record them in a side file of their own for the
  // next lock holder to fold in, rather than race a rewrite.
  await options.beforeSideFile?.();
  // Each line's id lets a fold tell whether that very line is already in the
  // file; readers drop it, so it never leaves the store.
  const pendingPath = path.join(path.dirname(filePath), `${pendingPrefix(filePath)}${randomUUID()}.jsonl`);
  // It holds what the file holds, so it gets no wider mode than that file;
  // owner-only while there is no file yet.
  const sideMode = await fs.promises.stat(filePath).then((s) => s.mode & 0o777, () => OWNER_ONLY);
  const pending = records.map((record) => JSON.stringify({ ...record, pendingId: randomUUID() }) + '\n').join('');
  await fs.promises.writeFile(pendingPath, pending, { encoding: 'utf-8', flag: 'wx', mode: sideMode });

  return pendingPath;
}

/**
 * Read every record, skipping blank and malformed lines. With `includePending`
 * (the default) the side records not yet folded in follow the file's records;
 * one a fold already appended is read once. A missing file reads as empty.
 */
export async function readJsonl(filePath: string, options: { includePending?: boolean } = {}): Promise<JsonlRecord[]> {
  const pending: JsonlRecord[] = [];

  // Read side records first so a fold cannot move a record past both reads.
  if (options.includePending !== false) {
    for (const pendingPath of await sideRecordPaths(filePath)) {
      const content = await readOrEmpty(pendingPath).catch(() => '');

      // One without its newline is still being written.
      if (!content.endsWith('\n')) continue;

      for (const record of parseLines(content)) pending.push(record);
    }
  }

  const records = parseLines(await readOrEmpty(filePath));
  const inFile = new Set(records.flatMap((r) => PendingIdSchema.parse(r.pendingId) ?? []));

  for (const record of pending) {
    const pendingId = PendingIdSchema.parse(record.pendingId);

    if (pendingId !== undefined && inFile.has(pendingId)) continue;
    records.push(record);
  }

  return records.map(({ pendingId: _pendingId, ...rest }) => rest);
}

/**
 * Replace the file with the non-empty lines `keep` returns, or leave it
 * untouched when `keep` returns null. Runs under the lock, after folding in the
 * side records. The copy is written to a temp file beside the file, with its
 * mode, and renamed over it, so a kill or a full disk leaves the old file
 * whole. A symlinked file is replaced at its target. Throws when the lock is
 * still held after the wait, or when the file does not exist (ENOENT).
 *
 * Its default wait exceeds a hook's budget: prune from a command such as
 * `pull`, never from a hook.
 */
export async function rewriteJsonl(
  filePath: string,
  keep: (lines: string[]) => string[] | null,
  options: JsonlStoreOptions = {},
): Promise<void> {
  const wait = options.wait ?? REWRITE_LOCK_WAIT;

  const rewritten = await withLock(filePath, wait, options.mode ?? OWNER_ONLY, async () => {
    // Replace the file itself, not a symlink to it.
    const target = await fs.promises.realpath(filePath);
    await removeOrphanTemps(target);
    await options.beforeSideFile?.();
    const lines = (await fs.promises.readFile(target, 'utf-8')).split('\n').filter((l) => l.trim());
    const kept = keep(lines);

    if (!kept) return;
    const mode = (await fs.promises.stat(target)).mode & 0o7777;
    const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

    try {
      await fs.promises.writeFile(tmpPath, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf-8', mode });
      // The create mode passes through the umask.
      await fs.promises.chmod(tmpPath, mode);
      await fs.promises.rename(tmpPath, target);
    } catch (e) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      throw e;
    }
  });

  if (!rewritten) {
    throw new Error(
      `${filePath}.lock is still held after ${wait.budgetMs / 1000} s, so the file was left as it is; remove the lock if no teamai process is running`,
    );
  }
}

/**
 * Run `fn` holding the file's lock, after folding in the side records of
 * appends that gave up waiting. A lock whose owner is gone is reclaimed.
 * Returns false, without running `fn`, when the lock is still held after the
 * wait.
 */
async function withLock(filePath: string, wait: LockWait, mode: number, fn: () => Promise<void>): Promise<boolean> {
  const lockPath = `${filePath}.lock`;
  // Wall clock, not an attempt count: a busy event loop runs each sleep late,
  // and 100 late sleeps blow past the budget this wait promises.
  const deadline = Date.now() + wait.budgetMs;

  for (;;) {
    if (await acquireLock(lockPath)) {
      try {
        await foldSideRecords(filePath, mode);
        await fn();
      } finally {
        await releaseLock(lockPath);
      }

      return true;
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(wait.delayMs, remaining)));
  }
}

/** Name prefix of the side records an append writes while the lock is held. */
function pendingPrefix(filePath: string): string {
  return `${path.basename(filePath, '.jsonl')}.pending-`;
}

async function sideRecordPaths(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const prefix = pendingPrefix(filePath);
  const names = await fs.promises.readdir(dir).catch((): string[] => []);

  return names.filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl')).map((n) => path.join(dir, n));
}

/**
 * Append the side records to the file, then remove them. Each holds whole
 * lines; one without its final newline is still being written and waits for
 * the next holder. A line whose id the file already holds was folded by a
 * holder that died or could not remove its side record, so it is not appended
 * again; identical records keep their own ids and lines.
 */
async function foldSideRecords(filePath: string, mode: number): Promise<void> {
  let folded: Set<string> | undefined;

  for (const pendingPath of await sideRecordPaths(filePath)) {
    try {
      const content = await fs.promises.readFile(pendingPath, 'utf-8');

      if (!content.endsWith('\n')) continue;
      const known = folded ??= new Set((await readOrEmpty(filePath).catch(() => '')).split('\n').map(pendingIdOf).filter((i) => i !== undefined));

      const fresh = content.split('\n').filter((line) => {
        const id = pendingIdOf(line);

        return line.trim() !== '' && (id === undefined || !known.has(id));
      });

      if (fresh.length > 0) {
        await appendWhole(filePath, fresh.join('\n') + '\n', mode);

        for (const id of fresh.map(pendingIdOf)) if (id !== undefined) known.add(id);
      }

      await fs.promises.rm(pendingPath, { force: true });
    } catch (e) {
      log.debug(`Could not fold ${pendingPath} into ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Append `text` (whole lines) to the file, creating it with `mode`. When a
 * killed writer left a last line without its newline, a newline goes first, so
 * that torn line stays malformed on its own instead of swallowing this one.
 */
async function appendWhole(filePath: string, text: string, mode: number): Promise<void> {
  const handle = await fs.promises.open(filePath, 'a+', mode);

  try {
    const { size } = await handle.stat();
    let torn = false;

    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      torn = last[0] !== 0x0a;
    }

    await handle.appendFile(torn ? '\n' + text : text, 'utf-8');
  } finally {
    await handle.close();
  }
}

/** Remove the temp copies a killed rewrite left beside `target`; only the lock holder writes one. */
async function removeOrphanTemps(target: string): Promise<void> {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  const names = await fs.promises.readdir(dir).catch((): string[] => []);

  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+\.[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/** The id a side record gave its line, if the line has one. */
function pendingIdOf(line: string): string | undefined {
  if (!line.includes('"pendingId"')) return undefined;

  try {
    return z.looseObject({ pendingId: PendingIdSchema }).safeParse(JSON.parse(line)).data?.pendingId;
  } catch {
    return undefined;
  }
}

async function readOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return '';
    throw e;
  }
}

function parseLines(content: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    try {
      // JSON.parse returns `any`; what it builds is a JsonValue by construction.
      const parsed: JsonValue = JSON.parse(trimmed);

      if (isJsonObject(parsed)) {
        records.push(parsed);
        continue;
      }
    } catch {
      // Reported below.
    }

    log.debug(`Skipping corrupted JSONL line: ${trimmed.slice(0, 50)}`);
  }

  return records;
}
