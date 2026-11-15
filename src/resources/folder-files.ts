import fs from 'node:fs/promises';
import { readRegularFile } from '@teamai/shared/regular-file';
import path from 'node:path';

/** One file of a resource folder: its `/`-separated path from the folder root, its executable bit and its bytes. */
export interface FolderFile {
  readonly path: string;
  readonly executable: boolean;
  readonly bytes: Buffer;
}

/** A path inside a folder that makes the folder invalid (#1787, common rule 7). */
export interface FolderFileProblem {
  readonly path: string;
  readonly problem: 'symlink' | 'unreadable';
}

/** Every file of a folder, or every path that keeps it from being one. */
export type FolderFilesRead =
  | { readonly kind: 'files'; readonly files: readonly FolderFile[] }
  | { readonly kind: 'invalid'; readonly problems: readonly FolderFileProblem[] };

/**
 * Every file under the folder at `dir`, in path order. Hidden entries (a name starting with `.`) are skipped, because
 * `.DS_Store` or an editor's swap file differs from machine to machine. A symlink, or a file or directory that cannot be
 * read, makes the folder invalid, so nothing outside the folder is ever read and nothing is silently left out.
 */
async function read(dir: string): Promise<FolderFilesRead> {
  const files: FolderFile[] = [];
  const problems: FolderFileProblem[] = [];

  const visit = async (relative: string): Promise<void> => {
    const full = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    const names = await fs.readdir(full).catch(() => null);

    if (names === null) {
      problems.push({ path: relative, problem: 'unreadable' });

      return;
    }

    for (const name of names.filter((entry) => !entry.startsWith('.')).sort()) {
      const child = relative === '' ? name : `${relative}/${name}`;
      const childFull = path.join(full, name);
      const stat = await fs.lstat(childFull).catch(() => null);

      if (stat === null) problems.push({ path: child, problem: 'unreadable' });
      else if (stat.isSymbolicLink()) problems.push({ path: child, problem: 'symlink' });
      else if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) {
        const bytes = await readRegularFile(childFull).catch(() => null);

        if (bytes === null) problems.push({ path: child, problem: 'unreadable' });
        else files.push({ path: child, executable: (stat.mode & 0o100) !== 0, bytes });
      }
    }
  };

  await visit('');

  return problems.length > 0 ? { kind: 'invalid', problems } : { kind: 'files', files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

/** What a folder problem looks like in a diagnostic: `lib/link.sh is a symlink`. */
function describe({ path: file, problem }: FolderFileProblem): string {
  switch (problem) {
    case 'symlink': return `${file} is a symlink`;
    case 'unreadable': return `${file} cannot be read`;
    default: {
      const unhandled: never = problem;

      return unhandled;
    }
  }
}

/** A text file teamai renders from a folder, as common rule 12 reads it: CRLF read as LF, and one trailing newline removed, so separators are code's. */
function text(raw: string): string {
  return raw.replaceAll('\r\n', '\n').replace(/\n$/, '');
}

export const FolderFiles = { read, describe, text } as const;
