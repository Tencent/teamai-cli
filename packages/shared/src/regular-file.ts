import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

// ─── Reading a file that someone else may have replaced ───
//
//  A step writes where teamai later reads: its result file, its evidence, its copy, its tool home and transcripts. A
//  FIFO planted at such a path blocks a plain read's open until a writer comes, past any deadline, and holds one of
//  libuv's few workers meanwhile (a synchronous read stalls the whole process). So the file is opened without blocking,
//  and the handle's own type is checked before a byte is read: no other process can swap the path between the check
//  and the read, as it can between a stat of the path and an open of it.
//

/** Opening for reading without waiting: a FIFO opens at once. Windows has no flag, and no FIFO a path opens. */
const NONBLOCKING_READ = process.platform === 'win32' ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

/** `NONBLOCKING_READ` that fails on a link at the path (ELOOP) rather than following it. Windows has no flag. */
const NONBLOCKING_READ_NO_LINK = process.platform === 'win32' ? NONBLOCKING_READ : NONBLOCKING_READ | fs.constants.O_NOFOLLOW;

/** What stands at a path in place of a regular file, as an error names it. */
export type NotRegularFileKind = 'a link' | 'a pipe' | 'a directory' | 'a device' | 'a socket' | 'a special file';

function kindOf(stats: fs.Stats): NotRegularFileKind {
  if (stats.isSymbolicLink()) return 'a link';

  if (stats.isFIFO()) return 'a pipe';

  if (stats.isDirectory()) return 'a directory';

  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device';

  if (stats.isSocket()) return 'a socket';

  return 'a special file';
}

/** A path that holds something other than a regular file, which is never read or written. */
export class NotRegularFileError extends Error {
  override name = 'NotRegularFileError';
  /** What is there instead, such as `a pipe`. */
  readonly kind: NotRegularFileKind;

  constructor(readonly file: string, stats: fs.Stats, use: 'read' | 'write' = 'read') {
    const kind = kindOf(stats);
    super(use === 'read' ? `${file} is ${kind}, not a regular file, so teamai does not read it` : `${file} is ${kind}, not a regular file, so teamai does not write it`);
    this.kind = kind;
  }
}

/** The open handle of `file`, a regular file; a missing file rejects with its own error, anything else with `NotRegularFileError`. */
export async function openRegularFile(file: string): Promise<FileHandle> {
  return openRegularFileWith(file, NONBLOCKING_READ);
}

async function openRegularFileWith(file: string, flags: number): Promise<FileHandle> {
  const handle = await fs.promises.open(file, flags);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) throw new NotRegularFileError(file, stats);

    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The contents of `file`, which must be a regular file, as `openRegularFile` checks. */
export async function readRegularFile(file: string): Promise<Buffer>;
export async function readRegularFile(file: string, encoding: BufferEncoding): Promise<string>;
export async function readRegularFile(file: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  const handle = await openRegularFile(file);

  try {
    return encoding === undefined ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

/**
 * The contents of `file`, which must be a regular file and not a link to one: for a folder whose hash or acceptance
 * holds a link's text and not what it points to, so what is read is what was accepted. A link rejects with
 * `NotRegularFileError`, and off Windows so does one put there after the check, which the open does not follow.
 */
export async function readRegularFileNoLink(file: string): Promise<Buffer>;
export async function readRegularFileNoLink(file: string, encoding: BufferEncoding): Promise<string>;
export async function readRegularFileNoLink(file: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  const stats = await fs.promises.lstat(file);

  if (stats.isSymbolicLink()) throw new NotRegularFileError(file, stats);
  let handle: FileHandle;

  try {
    handle = await openRegularFileWith(file, NONBLOCKING_READ_NO_LINK);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new NotRegularFileError(file, await fs.promises.lstat(file));
    throw error;
  }

  try {
    return encoding === undefined ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

/**
 * The descriptor of `file`, a regular file, for a synchronous contract that cannot wait: the same check as
 * `openRegularFile`. Reading a regular file ends at its end, so only the open could block, and it does not here.
 */
export function openRegularFileSync(file: string): number {
  const fd = fs.openSync(file, NONBLOCKING_READ);

  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) throw new NotRegularFileError(file, stats);

    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** `readRegularFile` for a synchronous contract, through `openRegularFileSync`. */
export function readRegularFileSync(file: string): Buffer;
export function readRegularFileSync(file: string, encoding: BufferEncoding): string;
export function readRegularFileSync(file: string, encoding?: BufferEncoding): string | Buffer {
  const fd = openRegularFileSync(file);

  try {
    return encoding === undefined ? fs.readFileSync(fd) : fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Writing where a step may have left something else ───
//
//  Opening a FIFO for writing waits for a reader as a read waits for a writer. Opened without blocking, a FIFO no one
//  reads fails at once (ENXIO), and one a reader holds is caught by the handle's own type, as for a read. A link at the
//  path fails the open (ELOOP), so nothing is written through it to a file of the member's, or created where it points.
//

/** Opening without waiting or following a link, creating a missing file. Windows has neither flag, and no FIFO a path opens. */
const NONBLOCKING_CREATE = (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW) | fs.constants.O_CREAT;

/**
 * The open handle of `file` for writing, created when missing, with `mode` when given: at its end when `append`, else
 * emptied; with `read`, it reads as well, as an append that looks at the file's last byte first does. Anything but a
 * regular file there, a link to one included, rejects with `NotRegularFileError`, and is left as it was.
 */
export async function openRegularFileForWrite(file: string, { append, mode, read = false }: { append: boolean; mode?: number; read?: boolean }): Promise<FileHandle> {
  let handle: FileHandle;

  try {
    handle = await fs.promises.open(file, NONBLOCKING_CREATE | (read ? fs.constants.O_RDWR : fs.constants.O_WRONLY) | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC), mode);
  } catch (error) {
    // A FIFO no process reads, or a device with nothing behind it.
    if (error instanceof Error && 'code' in error && error.code === 'ENXIO') throw new NotRegularFileError(file, await fs.promises.stat(file), 'write');

    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new NotRegularFileError(file, await fs.promises.lstat(file), 'write');
    throw error;
  }

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) throw new NotRegularFileError(file, stats, 'write');

    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Appends `data` to `file`, a regular file or none yet, as `openRegularFileForWrite` checks. */
export async function appendRegularFile(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await openRegularFileForWrite(file, { append: true });

  try {
    await handle.appendFile(data);
  } finally {
    await handle.close();
  }
}

/** Writes `data` as the whole of `file`, a regular file or none yet (then created with `mode`), as `openRegularFileForWrite` checks. */
export async function writeRegularFile(file: string, data: string | Uint8Array, { mode }: { mode?: number } = {}): Promise<void> {
  const handle = await openRegularFileForWrite(file, { append: false, ...(mode !== undefined && { mode }) });

  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** `writeRegularFile` for a caller that cannot await: the same open and check, so `file` is written in place, never removed first. */
export function writeRegularFileSync(file: string, data: string | Uint8Array, { mode }: { mode?: number } = {}): void {
  let fd: number;

  try {
    fd = fs.openSync(file, NONBLOCKING_CREATE | fs.constants.O_WRONLY | fs.constants.O_TRUNC, mode);
  } catch (error) {
    // A FIFO no process reads, or a device with nothing behind it.
    if (error instanceof Error && 'code' in error && error.code === 'ENXIO') throw new NotRegularFileError(file, fs.statSync(file), 'write');

    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new NotRegularFileError(file, fs.lstatSync(file), 'write');
    throw error;
  }

  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) throw new NotRegularFileError(file, stats, 'write');
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes `data` to `file` as a new file, for a caller that cannot await `writeRegularFile`: what is at `file` (a file, a
 * FIFO, a link) is removed first, and the create fails rather than open whatever appears there meanwhile. Only for a
 * file nothing reads while it is written, such as a temporary one renamed into place: a reader can find it missing,
 * and a second writer fails. `writeRegularFileSync` writes in place.
 */
export function writeNewFileSync(file: string, data: string | Uint8Array, { mode }: { mode?: number } = {}): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, data, { flag: 'wx', ...(mode !== undefined && { mode }) });
}

const COPY_CHUNK = 1024 * 1024;

/**
 * Copies `from`, a regular file as `openRegularFile` checks, over `to`, a regular file or none yet as
 * `openRegularFileForWrite` checks, keeping `from`'s mode as `fs.copyFile` does. A link at `to` is replaced, as
 * `copyRegularTree` replaces one, never written through.
 */
export async function copyRegularFile(from: string, to: string): Promise<void> {
  const source = await openRegularFile(from);

  try {
    const { mode } = await source.stat();

    if ((await lstatOrMissing(to))?.isSymbolicLink() === true) await fs.promises.unlink(to);
    const target = await openRegularFileForWrite(to, { append: false, mode });

    try {
      // In chunks, as a git pack a team clone holds can pass the 2 GiB a whole read allows.
      const chunk = Buffer.allocUnsafe(COPY_CHUNK);

      for (let { bytesRead } = await source.read(chunk, 0, COPY_CHUNK); bytesRead > 0; { bytesRead } = await source.read(chunk, 0, COPY_CHUNK)) {
        for (let written = 0; written < bytesRead;) written += (await target.write(chunk, written, bytesRead - written)).bytesWritten;
      }

      await target.chmod(mode & 0o7777);
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * How `copyRegularTree` treats an entry it copies: `filter` leaves out an entry and all under it; `existing` says what
 * an entry already at the destination gets; `keepTimes` gives each copied file its source's access and modification
 * times, as fs-extra's `preserveTimestamps` does.
 */
export interface CopyTreeOptions {
  readonly filter?: (source: string) => boolean | Promise<boolean>;
  readonly keepTimes?: true;
  /**
   * `replace` (the default) puts the copy in its place, never writing through a link there; `keep` leaves it and copies
   * the rest; `fail` rejects with EEXIST and leaves it.
   */
  readonly existing?: 'replace' | 'keep' | 'fail';
}

async function lstatOrMissing(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Whether `to`, or a folder above it, is `from` itself, however either path spells it: by device and inode, so a link
 * above `to` or a filesystem that ignores case cannot hide it. `to` itself is looked at without following a link there.
 */
async function isAtOrInside(from: string, to: string): Promise<boolean> {
  const source = await fs.promises.lstat(from, { bigint: true });

  for (let at = path.resolve(to), look = fs.promises.lstat; ; at = path.dirname(at), look = fs.promises.stat) {
    try {
      const there = await look(at, { bigint: true });

      if (there.dev === source.dev && there.ino === source.ino) return true;
    } catch (error) {
      // Nothing there yet, or a file where a folder above `to` would be: neither is `from`.
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
    }

    if (path.dirname(at) === at) return false;
  }
}

/** Whether to copy a file or link to `to`, making way for it as `existing` says: false when `keep` finds one there. */
async function makeWay(from: string, to: string, existing: 'replace' | 'keep' | 'fail'): Promise<boolean> {
  const there = await lstatOrMissing(to);

  if (there === undefined) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });

    return true;
  }

  if (there.isDirectory()) throw new Error(`${to} is a folder, so teamai does not copy ${from} over it`);

  switch (existing) {
    case 'keep':
      return false;
    case 'fail':
      throw Object.assign(new Error(`${to} already exists, so teamai does not copy over it`), { code: 'EEXIST' });
    case 'replace':
      await fs.promises.unlink(to);

      return true;
    default: {
      const unhandled: never = existing;

      return unhandled;
    }
  }
}

/**
 * Copies `from`, a file or a folder, to `to`, as fs-extra's `copy` does: folders are merged into, links are copied as
 * links, and each file keeps its mode. Anything but a regular file, a folder or a link, such as a FIFO or a device,
 * rejects with `NotRegularFileError`, and each file is read as `openRegularFile` opens it, so nothing waits on a writer.
 * As fs-extra does, it refuses `to` at or inside `from`, a folder over anything but a folder, and a file over a folder,
 * so a copy never makes way by removing what it copies from.
 */
export async function copyRegularTree(from: string, to: string, options: CopyTreeOptions = {}): Promise<void> {
  if (await isAtOrInside(from, to)) throw new Error(`${to} is ${from} or a folder inside it, so teamai does not copy ${from} there`);

  await copyEntry(from, to, options);
}

async function copyEntry(from: string, to: string, options: CopyTreeOptions): Promise<void> {
  if (options.filter !== undefined && !(await options.filter(from))) return;
  const stats = await fs.promises.lstat(from);

  if (stats.isDirectory()) {
    if ((await lstatOrMissing(to))?.isDirectory() === false) throw new Error(`${to} is not a folder, so teamai does not copy the folder ${from} over it`);
    const created = await fs.promises.mkdir(to, { recursive: true });

    for (const entry of await fs.promises.readdir(from)) await copyEntry(path.join(from, entry), path.join(to, entry), options);

    if (created !== undefined) await fs.promises.chmod(to, stats.mode & 0o7777);

    return;
  }

  if (!stats.isFile() && !stats.isSymbolicLink()) throw new NotRegularFileError(from, stats);

  if (!(await makeWay(from, to, options.existing ?? 'replace'))) return;

  if (stats.isSymbolicLink()) {
    await fs.promises.symlink(await fs.promises.readlink(from), to);

    return;
  }

  await copyRegularFile(from, to);

  if (options.keepTimes === true) await fs.promises.utimes(to, stats.atime, stats.mtime);
}

/** How long a rename Windows refuses for a moment is tried again, as graceful-fs, under fs-extra's `move`, tries it. */
const RENAME_RETRY_MS = 60_000;

/**
 * Renames `from` to `to`. On Windows a scanner or an indexer holding a file under `from` makes a rename fail EACCES,
 * EPERM or EBUSY for a moment, so it is tried again, backing off, while nothing has taken `to`, or, `isReplacing` a file
 * at `to`, however long that file stays.
 */
async function renameRetrying(from: string, to: string, { isReplacing = false }: { isReplacing?: boolean } = {}): Promise<void> {
  const started = Date.now();

  for (let backoff = 0; ; backoff = Math.min(backoff + 10, 100)) {
    try {
      await fs.promises.rename(from, to);

      return;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const isMomentary = process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY');

      if (!isMomentary || Date.now() - started >= RENAME_RETRY_MS || (!isReplacing && await lstatOrMissing(to) !== undefined)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, backoff); });
    }
  }
}

/**
 * The folder beside `to` a copy into it is built in, renamed or copied into place once whole: `.<name>.<8 hex>.staging`.
 * A copy cut short leaves it, which a scan passes over (`isStagingName`).
 */
export function stagingFolder(to: string): string {
  return path.join(path.dirname(to), `.${path.basename(to)}.${randomBytes(4).toString('hex')}.staging`);
}

/** Whether `name` is a folder `stagingFolder` makes: for a destination named `of` when given, else for any. */
export function isStagingName(name: string, of?: string): boolean {
  const prefix = of === undefined ? undefined : `.${of}.`;

  return prefix === undefined ? /^\..+\.[0-9a-f]{8}\.staging$/.test(name) : name.startsWith(prefix) && /^[0-9a-f]{8}\.staging$/.test(name.slice(prefix.length));
}

/**
 * Puts what `from`, a folder, holds into `to`, a folder on the same filesystem, as `copyRegularTree(from, to)` would,
 * but by rename, so nothing is read again: a folder in both is merged into, a file or link at `to` is replaced, and
 * what only `to` holds stays. As the copy does, it refuses a folder over anything but a folder, and a file over a folder.
 */
export async function mergeRegularTree(from: string, to: string): Promise<void> {
  for (const entry of await fs.promises.readdir(from)) {
    const [source, target] = [path.join(from, entry), path.join(to, entry)];
    const [moving, there] = await Promise.all([fs.promises.lstat(source), lstatOrMissing(target)]);

    if (moving.isDirectory() && there?.isDirectory() === true) {
      await mergeRegularTree(source, target);
      continue;
    }

    if (moving.isDirectory() && there !== undefined) throw new Error(`${target} is not a folder, so teamai does not copy the folder ${source} over it`);

    if (there?.isDirectory() === true) throw new Error(`${target} is a folder, so teamai does not copy ${source} over it`);

    try {
      // A rename replaces a file or link there in one step, so one that fails leaves it as it was.
      await renameRetrying(source, target, { isReplacing: there !== undefined });
    } catch (error) {
      // Another merge put the same new folder in place first: this one merges into it.
      if (!moving.isDirectory() || (await lstatOrMissing(target))?.isDirectory() !== true) throw error;
      await mergeRegularTree(source, target);
    }
  }
}

/**
 * Moves `from`, a file or a folder, to `to`, where nothing is yet, as fs-extra's `move` does: a rename, or across
 * filesystems a copy through `copyRegularTree` and then a removal of `from`. The copy goes into a folder beside `to`,
 * renamed into place once whole, so a copy that refuses an entry leaves `from` as it was and nothing at `to`.
 */
export async function moveRegularTree(from: string, to: string): Promise<void> {
  if (await isAtOrInside(from, to)) throw new Error(`${to} is ${from} or a folder inside it, so teamai does not move ${from} there`);

  if (await lstatOrMissing(to) !== undefined) throw Object.assign(new Error(`${to} already exists, so teamai does not move ${from} over it`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(to), { recursive: true });

  try {
    await renameRetrying(from, to);

    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
  }

  const staging = stagingFolder(to);

  try {
    await copyRegularTree(from, staging, { existing: 'fail' });
    await renameRetrying(staging, to);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }

  await fs.promises.rm(from, { recursive: true, force: true });
}
