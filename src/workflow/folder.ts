import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { FolderFiles, type FolderFilesRead } from '../resources/folder-files.js';
import { WORKFLOW_DIR_ENV } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { createGit } from '../utils/git.js';
import { withFileLock } from '../update.js';

// ─── Workflow folders (#1787) ────────────────────────────
//
//  workflows/<name>/WORKFLOW.yaml with the files the workflow
//  needs beside it. Pull keeps every file of the folder in the
//  workflow's cache entry, as UTF-8 text with LF line endings,
//  so the entry's sourceHash covers them and a run started on
//  one machine reads the same bytes on another.
//

/** The file that makes a directory under `workflows/` a workflow folder. */
export const WORKFLOW_MARKER = FOLDER_MARKERS.workflows.marker;

/** What a workflow folder may hold in all, its files' text with LF line endings: each run keeps a copy of its own. */
const MAX_BYTES = 1024 * 1024;

/** One file of a workflow folder: its `/`-separated path from the folder root, whether it is executable, and its text with LF line endings. */
export interface WorkflowFolderFile {
  readonly path: string;
  readonly executable: boolean;
  readonly content: string;
}

/** Every file of a workflow folder, or why it is not one, as `lib/link.sh is a symlink`. */
export type WorkflowFolderRead =
  | { readonly kind: 'files'; readonly files: WorkflowFolderFile[] }
  | { readonly kind: 'invalid'; readonly problem: string };

/**
 * Every file of the workflow folder at `folderDir` in a team checkout, in path order, each executable as git records it, so a
 * checkout on a file system without the bit reads the same folder. A file git does not track keeps the bit it has.
 */
async function read(folderDir: string): Promise<WorkflowFolderRead> {
  const [found, modes] = await Promise.all([FolderFiles.read(folderDir), gitModes(folderDir)]);

  return fromFiles(found, modes);
}

/** Whether git's index has each file under `folderDir` executable, by its path from it; none outside a git checkout. */
async function gitModes(folderDir: string): Promise<ReadonlyMap<string, boolean>> {
  try {
    const listed = await createGit(folderDir).raw(['ls-files', '-s', '-z', '--', '.']);

    return new Map(listed.split('\0').flatMap((line) => {
      const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(line);

      return match?.[1] && match[2] ? [[match[2], match[1] === '100755'] as const] : [];
    }));
  } catch {
    return new Map();
  }
}

/** A folder as {@link FolderFiles.read} found it, with `modes` in place of the bits on disk where git records one. */
function fromFiles(found: FolderFilesRead, modes: ReadonlyMap<string, boolean>): WorkflowFolderRead {
  if (found.kind === 'invalid') return { kind: 'invalid', problem: found.problems.map(FolderFiles.describe).join(', ') };
  const files: WorkflowFolderFile[] = [];
  const binary: string[] = [];

  for (const { path: file, executable, bytes } of found.files) {
    const text = utf8(bytes);

    if (text === undefined) binary.push(file);
    else files.push({ path: file, executable: modes.get(file) ?? executable, content: text.replace(/\r\n/g, '\n') });
  }

  if (binary.length > 0) return { kind: 'invalid', problem: binary.map((file) => `${file} is not UTF-8 text`).join(', ') };

  return withinLimit(files);
}

/** `files` as a folder read, or why not when together they hold more than a folder may: an inherited folder counts as merged. */
function withinLimit(files: WorkflowFolderFile[]): WorkflowFolderRead {
  const sizes = files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) }));
  const total = sizes.reduce((sum, { bytes }) => sum + bytes, 0);

  if (total > MAX_BYTES) {
    const largest = [...sizes].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, 5).map((size) => `${size.path} (${size.bytes} bytes)`);

    return { kind: 'invalid', problem: `it holds ${total} bytes, more than the ${MAX_BYTES} bytes (1 MB) a folder may hold. Its largest files: ${largest.join(', ')}` };
  }

  return { kind: 'files', files };
}

/** `bytes` as UTF-8 text, or undefined when they are not. */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The sourceHash of a folder: every file's path, mode and content, in path order. */
function hash(files: readonly WorkflowFolderFile[]): string {
  const digest = createHash('sha256');

  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(file.path).update('\0').update(file.executable ? '100755' : '100644').update('\0').update(file.content).update('\0');
  }

  return digest.digest('hex');
}

/** What a sourceHash looks like, so a path built from one stays in the folders directory. */
const SOURCE_HASH = /^[0-9a-f]{64}$/;

/** Where the files of the folder with `sourceHash` are kept for the runs that use it: `<dataHome>/workflows/folders/<sourceHash>`. */
function dir(config: LocalConfig, sourceHash: string): string | undefined {
  return SOURCE_HASH.test(sourceHash) ? path.join(getDataHome(config), 'workflows', 'folders', sourceHash) : undefined;
}

/**
 * What every process of a step of the folder with `sourceHash` gets, as it gets $TEAMAI_RUN_DIR: the folder's {@link dir},
 * with forward slashes on Windows too, which Git Bash, node and PowerShell all read. Nothing for a malformed hash.
 */
function env(config: LocalConfig, sourceHash: string): Record<string, string> {
  const at = dir(config, sourceHash);

  return at === undefined ? {} : { [WORKFLOW_DIR_ENV]: at.split(path.sep).join('/') };
}

/** The folder `value` names when it is a value {@link env} gives, and undefined for any other path, which a step's own `env:` may set. */
function named(config: LocalConfig, value: string | undefined): string | undefined {
  const sourceHash = value === undefined ? undefined : path.basename(value);

  return sourceHash !== undefined && env(config, sourceHash)[WORKFLOW_DIR_ENV] === value ? dir(config, sourceHash) : undefined;
}

/**
 * The lock {@link pin} and {@link prune} both take on a stored folder, so a prune never removes a folder a pin found
 * there and kept: beside the folder, under a name the prune passes over.
 */
function lockOf(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.lock`);
}

/** How long a pin waits for a prune or another pin of the same folder: each holds the lock for one look and one write or removal. */
const PIN_WAIT = { attempts: 200, delayMs: 50 } as const;

/**
 * Writes `files` to {@link dir} once, for every run that uses the folder with `sourceHash`: into a new sibling first,
 * renamed into place, so a run never sees a folder half written. A folder already there is kept as it is, its time set
 * to now, so {@link prune} keeps it for a run that pins it before its record names it, as a start and a claim do.
 */
async function pin(config: LocalConfig, { sourceHash, files }: { sourceHash: string; files: readonly WorkflowFolderFile[] }): Promise<void> {
  const target = dir(config, sourceHash);

  if (target === undefined) throw new Error(`${sourceHash} is not the sourceHash of a workflow folder`);
  const locked = await withFileLock(lockOf(target), PIN_WAIT, () => store(target, files));

  if (!locked.held) {
    throw new Error(`Could not store the workflow folder ${sourceHash}: another teamai process held ${lockOf(target)} for ${(PIN_WAIT.attempts * PIN_WAIT.delayMs) / 1000} s. Run the command again; if no teamai process is running, delete that file.`);
  }
}

/** {@link pin}'s write, under its lock. */
async function store(target: string, files: readonly WorkflowFolderFile[]): Promise<void> {
  if (await pathExists(target)) {
    const now = new Date();
    await fs.utimes(target, now, now);

    return;
  }

  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString('hex')}`);

  try {
    for (const file of files) {
      const full = path.join(staging, ...file.path.split('/'));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, file.content, { mode: file.executable ? 0o755 : 0o644, flag: 'wx' });
    }

    await fs.mkdir(staging, { recursive: true });
    await fs.rename(staging, target);
  } catch (error) {
    // Another process pinned the same folder first.
    if (!await pathExists(target)) throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** How long a stored folder no run references stays: a start or a claim stores the folder before it writes the run. */
const UNREFERENCED_GRACE_MS = 60 * 60 * 1000;

/**
 * Removes each stored folder whose sourceHash is not in `referenced` and that was stored more than an hour before `now`,
 * so a run whose start or claim stored its folder but has not yet written its record keeps it. Each folder is looked at
 * and removed under {@link pin}'s lock; one a pin holds now is in use, and stays.
 */
async function prune(config: LocalConfig, { referenced, now }: { referenced: ReadonlySet<string>; now: number }): Promise<void> {
  const root = path.join(getDataHome(config), 'workflows', 'folders');
  const names = await fs.readdir(root).catch(() => []);

  for (const name of names) {
    if (!SOURCE_HASH.test(name) || referenced.has(name)) continue;
    const target = path.join(root, name);

    await withFileLock(lockOf(target), { attempts: 1, delayMs: 0 }, async () => {
      const stored = await fs.stat(target).catch(() => undefined);

      if (stored && stored.mtimeMs + UNREFERENCED_GRACE_MS <= now) await fs.rm(target, { recursive: true, force: true });
    });
  }
}

/** A folder teamai's package ships, as {@link FolderFiles.read} found it: no git index records its modes. */
function shipped(found: FolderFilesRead): WorkflowFolderRead {
  return fromFiles(found, new Map());
}

export const WorkflowFolder = { MAX_BYTES, read, withinLimit, shipped, hash, dir, env, named, pin, prune } as const;
