import { createHash } from 'node:crypto';
import { FolderFiles, type FolderFilesRead } from '../resources/folder-files.js';
import { createGit } from '../utils/git.js';

// ─── Workflow folders (#1787) ────────────────────────────
//
//  workflows/<name>/WORKFLOW.yaml with the files the workflow
//  needs beside it. Pull keeps every file of the folder in the
//  workflow's cache entry, as UTF-8 text with LF line endings,
//  so the entry's sourceHash covers them and a run started on
//  one machine reads the same bytes on another.
//

/** The file that makes a directory under `workflows/` a workflow folder. */
export const WORKFLOW_MARKER = 'WORKFLOW.yaml';

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
 * Every file of the workflow folder at `dir` in a team checkout, in path order, each executable as git records it, so a
 * checkout on a file system without the bit reads the same folder. A file git does not track keeps the bit it has.
 */
async function read(dir: string): Promise<WorkflowFolderRead> {
  const [found, modes] = await Promise.all([FolderFiles.read(dir), gitModes(dir)]);

  return fromFiles(found, modes);
}

/** Whether git's index has each file under `dir` executable, by its path from `dir`; none outside a git checkout. */
async function gitModes(dir: string): Promise<ReadonlyMap<string, boolean>> {
  try {
    const listed = await createGit(dir).raw(['ls-files', '-s', '-z', '--', '.']);

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

  for (const { path, executable, bytes } of found.files) {
    const text = utf8(bytes);

    if (text === undefined) binary.push(path);
    else files.push({ path, executable: modes.get(path) ?? executable, content: text.replace(/\r\n/g, '\n') });
  }

  if (binary.length > 0) return { kind: 'invalid', problem: binary.map((file) => `${file} is not UTF-8 text`).join(', ') };
  const sizes = files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) }));
  const total = sizes.reduce((sum, { bytes }) => sum + bytes, 0);

  if (total > MAX_BYTES) {
    const largest = [...sizes].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, 5).map(({ path, bytes }) => `${path} (${bytes} bytes)`);

    return { kind: 'invalid', problem: `it holds ${total} bytes, more than the ${MAX_BYTES} bytes (1 MB) a workflow folder may hold. Its largest files: ${largest.join(', ')}` };
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

export const WorkflowFolder = { read, hash } as const;
