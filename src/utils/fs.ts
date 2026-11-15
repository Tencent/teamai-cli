import { copyRegularTree, isStagingName, mergeRegularTree, readRegularFile, stagingFolder } from '@teamai/shared/regular-file';
import fse from 'fs-extra';
import crypto from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { log } from '@teamai/shared/log';
import { expandHome } from '@teamai/shared/home';
import { identityOf, isSameProcess, ProcessIdentitySchema } from '@teamai/shared/process-group';
import { parseJson, type JsonSyntax, isJsonObject } from '@teamai/shared/json';
import { editJsonText, isPlainJson, parseJsonAs } from './json.js';

const IGNORED_NAMES = new Set([
  '__pycache__',
  '.pyc',
  '.DS_Store',
  'node_modules',
  '.git',
]);

/** A pre-push sync's update and backup of a skill (`replaceSkillDir`): `.<name>.<pid>.<12 hex>.teamai-sync` and `-prev`. */
const SYNC_NAME = /^\..+\.\d+\.[0-9a-f]{12}\.teamai-(?:sync|prev)$/;

/**
 * The folders a pre-push sync builds beside skill folder `dir`: `staged`, the update, renamed into place once whole, and
 * `previous`, the copy it replaces until then. A sync cut short leaves them, each holding a whole skill, which a scan
 * passes over (`isIgnored`).
 */
export function syncFolders(dir: string) {
  const tag = path.join(path.dirname(dir), `.${path.basename(dir)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);

  return { staged: `${tag}.teamai-sync`, previous: `${tag}.teamai-prev` };
}

/** Whether a scan or a copy passes `name` over: caches, git's folder, and a working folder a copy cut short left. */
export function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith('.pyc') || isStagingName(name) || SYNC_NAME.test(name);
}

/**
 * The suffix of a draft `recall maintenance --update-quality` writes beside a team doc, rule or skill file for a person
 * to review. It is no team knowledge until renamed, so pull delivers none and recall reads none.
 */
export const DRAFT_SUFFIX = '.draft.md';

/** Whether a team file is a draft (`DRAFT_SUFFIX`). Read on the team's side only, so pull still sweeps a copy it delivered before. */
export function isDraft(file: string): boolean {
  return file.endsWith(DRAFT_SUFFIX);
}

const ErrnoErrorSchema = z.object({ code: z.string() });

/**
 * The error code (`ENOENT`, `EACCES`, ...) a failed fs or child-process call
 * carries, or undefined when the thrown value has none.
 */
export function errnoCode(cause: unknown): string | undefined {
  const parsed = ErrnoErrorSchema.safeParse(cause);

  return parsed.success ? parsed.data.code : undefined;
}

/** The error codes of a write the filesystem refused: no permission, a sandbox's or a policy's refusal, a read-only volume. */
const WRITE_REFUSALS = ['EACCES', 'EPERM', 'EROFS'] as const;

/** The calls that write: an EACCES of `spawn` (a program that may not run) or `scandir` (a read) is not a refused write. */
const WRITING_CALLS = new Set(['open', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rmdir', 'rm', 'link', 'symlink', 'copyfile', 'write', 'utime', 'futime', 'chmod', 'chown']);

/** A refused call's error: `dest` is where `rename`, `link`, `copyfile` and `symlink` write, `path` their source. */
const RefusedWriteErrorSchema = z.object({ code: z.enum(WRITE_REFUSALS), path: z.string(), dest: z.string().optional(), syscall: z.string() });

/**
 * Whether a refused `open`, which reads as well as writes, was a read: the file is there, and this process may not read
 * it. One it may read, or one that is not there yet, was refused a write.
 */
function isRefusedRead(file: string): boolean {
  try {
    accessSync(file, fsConstants.R_OK);

    return false;
  } catch (error) {
    return errnoCode(error) !== 'ENOENT';
  }
}

/** Whether `refused` is a write the filesystem refused, rather than a read or, on Windows, a file another process holds open. */
function isRefusedWriteCall({ code, path: file, syscall }: z.infer<typeof RefusedWriteErrorSchema>): boolean {
  if (!WRITING_CALLS.has(syscall)) return false;

  // Windows refuses a rename over a file another process holds open, such as a virus scanner, for a moment.
  if (process.platform === 'win32' && code === 'EPERM' && syscall === 'rename') return false;

  // A copy reads its source, so one refused there is a read.
  return (syscall !== 'open' && syscall !== 'copyfile') || !isRefusedRead(file);
}

/** Whether this process may write in `folder`. */
function mayWriteIn(folder: string): boolean {
  try {
    accessSync(folder, fsConstants.W_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * The folder a refused call was refused a write in: where it writes, or, for a rename that may write there, the folder
 * it takes its source out of.
 */
function refusedFolderOf({ path: file, dest, syscall }: z.infer<typeof RefusedWriteErrorSchema>): string {
  if (dest === undefined) return path.dirname(file);

  return syscall === 'rename' && mayWriteIn(path.dirname(dest)) && !mayWriteIn(path.dirname(file)) ? path.dirname(file) : path.dirname(dest);
}

/** The strerror git prints after the path it may not write, by the code it stands for. */
const GIT_REFUSALS = [
  { strerror: 'Permission denied', code: 'EACCES' },
  { strerror: 'Operation not permitted', code: 'EPERM' },
  { strerror: 'Read-only file system', code: 'EROFS' },
] as const satisfies ReadonlyArray<{ strerror: string; code: (typeof WRITE_REFUSALS)[number] }>;

/** Git's own error line, so ssh's `connect to host … port 22: Operation not permitted` is not read as a path. */
const GIT_REFUSAL_LINE = /^(?:error|fatal): .*?(?:'([^']+)'|([^\s':]*\/[^\s':]*)):\s*(Permission denied|Operation not permitted|Read-only file system)\s*$/m;

/** A write the filesystem refused: the folder it was refused in, and its error code. */
export interface RefusedWrite {
  folder: string;
  code: (typeof WRITE_REFUSALS)[number];
}

/** A refused write, told as an error whose message says where and what to do; every retry fails the same way. */
export class RefusedWriteError extends Error {
  override name = 'RefusedWriteError';
  constructor(readonly refused: RefusedWrite, options?: ErrorOptions) {
    super(refusedWriteAdvice(refused), options);
  }
}

/**
 * The write the filesystem refused that `cause`, or an error it was caused by, reports; undefined for any other
 * failure. A `RefusedWriteError` counts as it is. With `gitCwd`, a git error counts too when its text names the path
 * git may not write, read from `gitCwd`, where git ran.
 */
export function refusedWrite(cause: unknown, { gitCwd }: { gitCwd?: string } = {}): RefusedWrite | undefined {
  for (let current = cause, depth = 0; current !== undefined && depth < 8; depth++) {
    if (current instanceof RefusedWriteError) return current.refused;
    const errno = RefusedWriteErrorSchema.safeParse(current);

    if (errno.success && isRefusedWriteCall(errno.data)) return { folder: refusedFolderOf(errno.data), code: errno.data.code };
    const line = gitCwd !== undefined && current instanceof Error ? GIT_REFUSAL_LINE.exec(current.message) : null;
    const written = line?.[1] ?? line?.[2];
    const code = GIT_REFUSALS.find(({ strerror }) => strerror === line?.[3])?.code;

    if (gitCwd !== undefined && written !== undefined && code !== undefined) return { folder: path.dirname(path.resolve(gitCwd, written)), code };
    current = current instanceof Error ? current.cause : undefined;
  }

  return undefined;
}

/**
 * The write the filesystem refuses in `folder`, found by creating a file there and removing it: for a failure whose
 * own text does not say, such as git's in a language other than English.
 */
export async function refusedWriteIn(folder: string): Promise<RefusedWrite | undefined> {
  const probe = path.join(folder, `.teamai-write-${crypto.randomBytes(4).toString('hex')}`);

  try {
    await fse.writeFile(probe, '', { flag: 'wx' });
  } catch (error) {
    return refusedWrite(error);
  }

  await fse.remove(probe);

  return undefined;
}

/** What to tell the person of a write the filesystem refused: where, why, and what to do. */
export function refusedWriteAdvice({ folder, code }: RefusedWrite): string {
  return `teamai may not write in ${folder} (${code}). Give this process write access to that folder, or run the command outside its sandbox.`;
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dir: string): Promise<void> {
  await fse.ensureDir(expandHome(dir));
}

/**
 * Read a file, return null if not found or not a regular file
 */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readRegularFile(expandHome(filePath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read a file that is allowed to be absent. `null` means the file does not
 * exist; any other failure (permissions, I/O) is thrown, unlike `readFileSafe`,
 * which folds every error into `null`. Use this where a caller must tell
 * "the team has no such file" apart from "the file could not be read".
 */
export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readRegularFile(expandHome(filePath), 'utf-8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write a file, creating parent dirs as needed. Bytes are written as they are.
 */
export async function writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const expanded = expandHome(filePath);
  await fse.ensureDir(path.dirname(expanded));
  await fse.writeFile(expanded, content, 'utf-8');
}

const MAX_SYMLINK_HOPS = 40;

/**
 * The path a link chain starting at `filePath` ends at, whether or not a file
 * exists there yet; `filePath` itself when it is not a link. Each hop resolves
 * against the real directory of the link, as the kernel does.
 */
export async function symlinkTarget(filePath: string): Promise<string> {
  let target = filePath;

  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    try {
      if (!(await fse.lstat(target)).isSymbolicLink()) return target;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return target;
      throw error;
    }

    target = path.resolve(await fse.realpath(path.dirname(target)), await fse.readlink(target));
  }

  throw new Error(
    `Cannot write ${filePath}: it is part of a symbolic link loop. Point the link at a regular file, then retry.`,
  );
}

/**
 * Write a text file atomically (same-dir temp file + rename), preserving the
 * target's existing permission bits (or defaulting to 0o600 for a new file).
 *
 * rename(2) within a filesystem is atomic, so a failed or interrupted write
 * (ENOSPC, EFBIG, a crash mid-write) can NEVER truncate or corrupt an existing
 * target — the original file is untouched until the fully-written temp file
 * replaces it in one step, and on any error the temp file is removed and the
 * original left in place. Use this for a single-copy, must-not-be-lost file
 * such as a partition's config.yaml; `writeFile` (a plain overwrite) is fine
 * for regenerable files. Pass options.mode to force restrictive permissions
 * for a file that newly contains credentials.
 *
 * A symlinked target is written at the file its link chain ends at, so the
 * links stay; for a dangling link that file (and its directory) is created.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number },
): Promise<void> {
  const expanded = await symlinkTarget(expandHome(filePath));
  await fse.ensureDir(path.dirname(expanded));
  let mode = options?.mode ?? 0o600;

  try {
    if (options?.mode === undefined) mode = (await fse.stat(expanded)).mode & 0o777;
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }

  const tmp = `${expanded}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  try {
    // Created with the mode, so it is never readable wider than the target; chmod undoes the umask.
    await fse.writeFile(tmp, content, { encoding: 'utf-8', mode, flag: 'wx' });
    await fse.chmod(tmp, mode);
    await fse.rename(tmp, expanded);
  } catch (error) {
    await fse.remove(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Read JSON file, return null if not found
 */
export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  const content = await readFileSafe(filePath);

  if (content === null) return null;

  try {
    // SAFETY: not checked. A caller names T only for a file that teamai alone writes (a manifest, stamp, or cache) and
    // trusts it as written. A file another tool or a person may edit, even one teamai also writes, is read as
    // `JsonValue` (or `unknown`) and narrowed with a schema before use.
    return JSON.parse(content) as T;
  } catch {
    log.warn(`Failed to parse JSON: ${filePath}`);

    return null;
  }
}

/** A JSON file read as an object: missing, not a JSON object (and why), or its value. */
export type JsonObjectRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- callers merge their own typed entries into the object and write it back
  | { kind: 'ok'; value: Record<string, unknown> };

/**
 * Read a file that should hold a JSON object, parsed as the tool that reads it does (`syntax`), saying why when it
 * does not. Never throws, never logs.
 */
export async function readJsonObject(filePath: string, syntax: JsonSyntax = 'json'): Promise<JsonObjectRead> {
  const raw = await readFileSafe(filePath);

  if (raw === null) return { kind: 'missing' };

  try {
    const value = parseJsonAs(raw, syntax);

    return isJsonObject(value)
      ? { kind: 'ok', value }
      : { kind: 'invalid', error: 'not a JSON object' };
  } catch (e) {
    return { kind: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Write `data` over a JSON file a tool may read with comments. A file that is
 * absent, blank or plain JSON is written by `writePlain`, as before; one that
 * holds comments or trailing commas is edited key by key (`editJsonText`) and
 * written atomically at its link's target, mode kept, so the comments stay.
 */
export async function writeJsonKeepingComments<T>(
  filePath: string,
  data: T,
  writePlain: () => Promise<void>,
  options?: { mode?: number },
): Promise<void> {
  const current = await readFileSafe(filePath);

  if (current === null || isPlainJson(current)) {
    await writePlain();

    return;
  }

  await writeFileAtomic(filePath, editJsonText(current, parseJson(JSON.stringify(data))), options);
}

/**
 * Write JSON file
 */
export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Write JSON atomically (temp file + rename), preserving the target's
 * existing permission bits (or defaulting to 0o600 for a new file).
 *
 * rename(2) within a filesystem is atomic, so concurrent readers never see a
 * half-written file and concurrent writers cannot interleave partial data.
 * Intended for small, security-sensitive, concurrently-written files such as
 * the local-agent config. Not for shell-profile / dotfile paths, which may be
 * symlinks a caller expects writes to follow.
 *
 * @param filePath - Destination path (may use ~).
 * @param data - JSON-serializable value.
 * @param options.mode - Force permission bits instead of preserving the target.
 * @param options.compact - Write without indentation, for a large file no one reads by hand.
 */
export async function writeJsonAtomic<T>(
  filePath: string,
  data: T,
  options?: { mode?: number; compact?: boolean },
): Promise<void> {
  const expanded = expandHome(filePath);
  await fse.ensureDir(path.dirname(expanded));
  const content = JSON.stringify(data, null, options?.compact ? undefined : 2) + '\n';
  let mode = options?.mode ?? 0o600;

  if (options?.mode === undefined) {
    try {
      mode = (await fse.stat(expanded)).mode & 0o777;
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }

  const tmp = `${expanded}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  try {
    // Created with the mode, so it is never readable wider than the target; chmod undoes the umask.
    await fse.writeFile(tmp, content, { encoding: 'utf-8', mode, flag: 'wx' });
    await fse.chmod(tmp, mode);
    await fse.rename(tmp, expanded);
  } catch (error) {
    await fse.remove(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Copy a directory recursively, all or nothing: into a folder beside `dest` first, so an entry the copy refuses, such
 * as a FIFO, leaves `dest` as it was, or absent. The whole copy is then renamed to `dest`, or moved entry by entry into
 * the folder already there, which keeps what `skip` names and anything else of the member's in it.
 * If `dest` is a symlink (e.g. left over from setup-links.sh), it is removed once the copy is whole, so a real
 * directory takes its place.
 * With `onLink`, a link in `src` is not copied (nor followed): `onLink` gets its
 * path relative to `src`. Without it, links are copied as links.
 */
export async function copyDir(
  src: string, dest: string, onLink?: (relativePath: string) => void, skip: readonly string[] = [],
): Promise<void> {
  const destExpanded = expandHome(dest);
  const srcExpanded = expandHome(src);
  let there: fse.Stats | undefined;

  try {
    there = await fse.lstat(destExpanded);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }

  if (there !== undefined && !there.isDirectory() && !there.isSymbolicLink()) throw new Error(`${destExpanded} is not a folder, so teamai does not copy the folder ${srcExpanded} over it`);
  await removeLeftStaging(destExpanded);
  const staging = stagingFolder(destExpanded);
  // The copy sits a folder below, beside the process making it, so the next copy can tell a folder whose copy died.
  const copy = path.join(staging, 'copy');
  copyingNow.add(path.basename(staging));

  try {
    await fse.outputFile(path.join(staging, STAGING_OWNER), JSON.stringify({ ...(await identityOf(process.pid)), startedAt: new Date().toISOString(), host: os.hostname() }));
    await copyRegularTree(srcExpanded, copy, {
      filter: async (srcPath: string) => {
        if (isIgnored(path.basename(srcPath)) || isDraft(srcPath)) return false;
        // An entry `skip` names, and everything under it, is left as the destination has it.
        const rel = path.relative(srcExpanded, srcPath).split(path.sep).join('/');

        if (skip.some((entry) => rel === entry || rel.startsWith(`${entry}/`))) return false;

        if (onLink === undefined || srcPath === srcExpanded || !(await fse.lstat(srcPath)).isSymbolicLink()) return true;
        onLink(path.relative(srcExpanded, srcPath).split(path.sep).join('/'));

        return false;
      },
    });

    if (there?.isSymbolicLink()) await fse.remove(destExpanded);

    if (there === undefined || there.isSymbolicLink()) await fse.rename(copy, destExpanded);
    else await mergeRegularTree(copy, destExpanded);
  } finally {
    copyingNow.delete(path.basename(staging));
    await fse.remove(staging);
  }
}

/** The file in a staging folder naming the process that copies into it, as a lock names its holder, and its host. */
const STAGING_OWNER = 'owner.json';

/** The names of the staging folders this process copies into now: one it owns that is not among them, it left. */
const copyingNow = new Set<string>();

const StagingOwnerSchema = ProcessIdentitySchema.extend({ host: z.string().min(1) });

/** How old a staging folder is before it counts as one a crash left, when nothing tells whether its copy runs: a copy takes seconds. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Removes the staging folders beside `dest` that copies cut short left, whichever folder they copied: at once when the
 * process copying is gone from this host, never while it runs, else an hour on.
 */
async function removeLeftStaging(dest: string): Promise<void> {
  const parent = path.dirname(dest);

  for (const name of await fse.readdir(parent).catch(() => [])) {
    if (isStagingName(name) && await isLeftBehind(path.join(parent, name))) await fse.remove(path.join(parent, name));
  }
}

/**
 * The staging folders in `parent`: `left`, those no copy still writes into, which an uninstall removes with the copies
 * since the member asked for all of it to go, whatever their age, and `inUse`, those a copy still writes into, or may:
 * one on this host, or one another host sharing this home named within the hour.
 */
export async function stagingLeftIn(parent: string): Promise<{ left: string[]; inUse: string[] }> {
  const left: string[] = [];
  const inUse: string[] = [];

  for (const entry of await fse.readdir(parent, { withFileTypes: true }).catch(() => [])) {
    const staging = path.join(parent, entry.name);

    if (!entry.isDirectory() || !isStagingName(entry.name)) continue;
    const copier = await copierOf(staging);
    const mayCopy = copier === 'copying' || copier === 'unknown' || (copier === 'elsewhere' && !await isStale(staging));
    (mayCopy ? inUse : left).push(staging);
  }

  return { left, inUse };
}

/**
 * Whether a copy still writes into `staging`, from the owner file it holds: `copying` when the process it names runs on
 * this host, `gone` when it does not, `unknown` when its pid runs but nothing tells it is that process, `elsewhere`
 * when another host's process is named, as a container sharing the home names one, and `untold` when none is: none
 * written yet, or one from a teamai that wrote none.
 */
async function copierOf(staging: string): Promise<'copying' | 'gone' | 'unknown' | 'elsewhere' | 'untold'> {
  const owner = StagingOwnerSchema.safeParse(await readRegularFile(path.join(staging, STAGING_OWNER), 'utf8').then(parseJson).catch(() => undefined));

  if (!owner.success) return 'untold';

  // A pid another host recorded names nothing here.
  if (owner.data.host !== os.hostname()) return 'elsewhere';

  // This process's pid in another pid namespace, as a container on the host's network writes it, is another process.
  if (owner.data.pid === process.pid && owner.data.pidNamespace === (await identityOf(process.pid)).pidNamespace) {
    return copyingNow.has(path.basename(staging)) ? 'copying' : 'gone';
  }

  const verdict = await isSameProcess(owner.data);

  return verdict === 'same' ? 'copying' : verdict === 'other' ? 'gone' : 'unknown';
}

/** Whether `staging` is older than a copy takes, so one a crash left; a folder already gone is not. */
async function isStale(staging: string): Promise<boolean> {
  const there = await fse.lstat(staging).catch(() => undefined);

  return there !== undefined && there.mtimeMs + STALE_STAGING_MS < Date.now();
}

async function isLeftBehind(staging: string): Promise<boolean> {
  if (!await fse.pathExists(staging)) return false;
  const copier = await copierOf(staging);

  if (copier === 'copying' || copier === 'gone') return copier === 'gone';

  return isStale(staging);
}

/**
 * Recursively delete directories under `target` that contain no files at any
 * depth, and `target` itself when it ends up empty.
 *
 * Git tracks files, not directories: a copied skill whose source has an empty
 * subdirectory (e.g. an unused `assets/`) leaves that subdirectory behind as an
 * untracked shell when git switches back to the default branch after a push.
 * Such a shell has no SKILL.md, which makes later scans mistake it for a skill
 * namespace. Missing paths and files are left untouched.
 */
export async function pruneEmptyDirs(target: string): Promise<boolean> {
  const expanded = expandHome(target);
  let entries;

  try {
    const stat = await fse.lstat(expanded);

    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    entries = await fse.readdir(expanded, { withFileTypes: true });
  } catch {
    return false; // missing or unreadable — nothing to prune
  }

  let empty = true;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!await pruneEmptyDirs(path.join(expanded, entry.name))) empty = false;
    } else {
      empty = false;
    }
  }

  if (!empty) return false;

  try {
    await fse.rmdir(expanded);

    return true;
  } catch {
    return false;
  }
}

export async function copyFile(src: string, dest: string): Promise<void> {
  const destExpanded = expandHome(dest);
  await fse.ensureDir(path.dirname(destExpanded));
  await copyRegularTree(expandHome(src), destExpanded);
}

/**
 * List directories in a path (non-recursive, only directories)
 */
export async function listDirs(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);

  if (!await fse.pathExists(expanded)) return [];
  const entries = await fse.readdir(expanded, { withFileTypes: true });

  return entries.filter(e => e.isDirectory() && !isIgnored(e.name)).map(e => e.name);
}

/**
 * List files in a path (non-recursive, only files)
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);

  if (!await fse.pathExists(expanded)) return [];
  const entries = await fse.readdir(expanded, { withFileTypes: true });

  return entries.filter(e => e.isFile()).map(e => e.name);
}

/**
 * List files recursively, returning relative paths (e.g. "sub/file.md").
 */
export async function listFilesRecursive(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);

  if (!await fse.pathExists(expanded)) return [];
  const results: string[] = [];
  await _walkFiles(expanded, '', results);

  return results;
}

async function _walkFiles(base: string, prefix: string, results: string[]): Promise<void> {
  const entries = await fse.readdir(path.join(base, prefix), { withFileTypes: true });

  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isFile()) {
      results.push(rel);
    } else if (entry.isDirectory()) {
      await _walkFiles(base, rel, results);
    }
  }
}

const VCS_METADATA_NAMES = new Set(['.git', '.hg', '.svn']);

/**
 * Recursively detect local version-control metadata (`.git`/`.hg`/`.svn`) at ANY
 * depth under `dir`. Deliberately does NOT reuse the file-walk helpers above:
 * they skip `.git` via IGNORED_NAMES, which is exactly what would hide a nested
 * repo. `.git` is matched whether it is a directory or a file (submodule/worktree
 * links store it as a file). `node_modules` is skipped — its VCS metadata is
 * dependency noise, not the user's own unpushed work. Used to keep a deployed
 * skill that embeds a git repo (root OR nested) from being auto-deleted, since
 * such a repo can hide stashes / unpushed history a content compare cannot see.
 */
export async function hasVcsMetadataRecursive(dir: string): Promise<boolean> {
  const expanded = expandHome(dir);

  if (!await fse.pathExists(expanded)) return false;
  let entries;

  try {
    entries = await fse.readdir(expanded, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (VCS_METADATA_NAMES.has(entry.name)) return true; // dir or file (submodule link)

    if (entry.isDirectory() && entry.name !== 'node_modules') {
      if (await hasVcsMetadataRecursive(path.join(expanded, entry.name))) return true;
    }
  }

  return false;
}

/**
 * Check if a path exists
 */
/** Whether `left` and `right` name the same place once symlinks resolve; a path that does not exist compares as resolved. */
export async function isSameRealPath(left: string, right: string): Promise<boolean> {
  const [one, other] = await Promise.all([left, right].map((each) => fse.realpath(each).catch(() => path.resolve(each))));

  return one === other;
}

export async function pathExists(p: string): Promise<boolean> {
  return fse.pathExists(expandHome(p));
}

/**
 * Who wrote a file teamai generates into another tool's directory: nobody yet,
 * teamai (its content carries `marker`), or someone else. teamai writes and
 * removes only `absent` and `teamai` files, so a same-named file of the
 * user's is never overwritten or deleted.
 */
export type GeneratedFileState = 'absent' | 'teamai' | 'foreign';

export async function generatedFileState(file: string, marker: string): Promise<GeneratedFileState> {
  const content = await readFileSafe(file);

  if (content === null) return await pathExists(file) ? 'foreign' : 'absent';

  return content.includes(marker) ? 'teamai' : 'foreign';
}

/**
 * Remove a file or directory
 */
export async function remove(p: string): Promise<void> {
  await fse.remove(expandHome(p));
}

/**
 * Get the mtime (last modification time) of a file.
 * Returns 0 if the file does not exist.
 */
export async function getFileMtime(filePath: string): Promise<number> {
  try {
    const stat = await fse.stat(expandHome(filePath));

    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Get the latest mtime across all files in a directory (recursive).
 * Returns 0 if the directory does not exist or is empty.
 */
export async function getDirLatestMtime(dirPath: string): Promise<number> {
  const expanded = expandHome(dirPath);

  if (!await fse.pathExists(expanded)) return 0;

  let latest = 0;
  const entries = await fse.readdir(expanded, { withFileTypes: true });

  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const fullPath = path.join(expanded, entry.name);

    if (entry.isFile()) {
      const stat = await fse.stat(fullPath);

      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } else if (entry.isDirectory()) {
      const sub = await getDirLatestMtime(fullPath);

      if (sub > latest) latest = sub;
    }
  }

  return latest;
}

/**
 * Compute SHA-256 hash of a file's contents. Returns null if file does not exist.
 */
export async function fileHash(filePath: string): Promise<string | null> {
  try {
    const content = await readRegularFile(filePath);

    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compare a file's content against a Buffer by SHA-256 hash.
 * Returns true if the file has identical content to the buffer.
 * Returns false if the file does not exist.
 */
export async function fileContentEqualToBuffer(filePath: string, buffer: Buffer): Promise<boolean> {
  const fileHashVal = await fileHash(expandHome(filePath));

  if (fileHashVal === null) return false;
  const bufHash = crypto.createHash('sha256').update(buffer).digest('hex');

  return fileHashVal === bufHash;
}

/**
 * Compare two files by content. Returns true if they have identical content.
 * Returns false if either file does not exist or content differs.
 */
export async function fileContentEqual(fileA: string, fileB: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    fileHash(expandHome(fileA)),
    fileHash(expandHome(fileB)),
  ]);

  if (hashA === null || hashB === null) return false;

  return hashA === hashB;
}

/**
 * Recursively compare two directories by content.
 * Returns true only if both directories have exactly the same files with identical content.
 * Returns false if either directory does not exist.
 */
export async function dirContentEqual(dirA: string, dirB: string, ignore?: string[]): Promise<boolean> {
  const expandedA = expandHome(dirA);
  const expandedB = expandHome(dirB);

  if (!await fse.pathExists(expandedA) || !await fse.pathExists(expandedB)) return false;

  const ignoreSet = ignore ? new Set(ignore) : undefined;

  // Collect all relative file paths from both directories
  const filesA = await collectFiles(expandedA, '', ignoreSet);
  const filesB = await collectFiles(expandedB, '', ignoreSet);

  // Same set of files?
  if (filesA.size !== filesB.size) return false;

  for (const rel of filesA) {
    if (!filesB.has(rel)) return false;
  }

  // Same content?
  for (const rel of filesA) {
    const equal = await fileContentEqual(
      path.join(expandedA, rel),
      path.join(expandedB, rel),
    );

    if (!equal) return false;
  }

  return true;
}

/**
 * Team-repo-centric directory comparison.
 * Returns true if every file in `teamDir` exists in `localDir` with identical content.
 * Extra files in `localDir` (e.g. scripts/, agents/, references/) are ignored.
 * This prevents false-positive "modified" detection when the local copy has
 * additional enhancement files that the team repo version does not.
 *
 * Returns false if `teamDir` does not exist (nothing to compare against).
 * Returns false if `localDir` does not exist (local copy missing).
 */
export async function dirTeamSubsetEqual(
  localDir: string,
  teamDir: string,
  ignore?: string[],
): Promise<boolean> {
  const expandedLocal = expandHome(localDir);
  const expandedTeam = expandHome(teamDir);

  if (!await fse.pathExists(expandedLocal) || !await fse.pathExists(expandedTeam)) return false;

  const ignoreSet = ignore ? new Set(ignore) : undefined;

  // Collect files from team repo only — this is the "source of truth" file set
  const teamFiles = await collectFiles(expandedTeam, '', ignoreSet);

  if (teamFiles.size === 0) return true; // Empty team dir matches anything

  // Check that every team file exists in local with identical content
  for (const rel of teamFiles) {
    const equal = await fileContentEqual(
      path.join(expandedLocal, rel),
      path.join(expandedTeam, rel),
    );

    if (!equal) return false;
  }

  return true;
}

/**
 * Recursively collect all relative file paths under a directory.
 */
async function collectFiles(base: string, prefix: string, ignore?: Set<string>): Promise<Set<string>> {
  const result = new Set<string>();
  const entries = await fse.readdir(path.join(base, prefix), { withFileTypes: true });

  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;

    if (ignore?.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isFile()) {
      result.add(rel);
    } else if (entry.isDirectory()) {
      const sub = await collectFiles(base, rel, ignore);

      for (const s of sub) result.add(s);
    }
  }

  return result;
}

/**
 * Write content only if it differs from existing file (by SHA-256 hash).
 * Avoids mtime updates on unchanged files. Returns true if written.
 */
export async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const newHash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  const existingHash = await fileHash(filePath);

  if (existingHash === newHash) return false;
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, 'utf-8');

  return true;
}
