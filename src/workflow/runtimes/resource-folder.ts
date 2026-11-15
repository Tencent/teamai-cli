import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';

// A resource kept as a folder that teamai runs or builds from, such as a runtime or a sandbox profile, is taken at its
// revision: what a person accepts, and what a record names, is every file the folder holds.

/**
 * What a resource folder holds, by relative path, sorted: its files, folders and links. A linked folder is not walked,
 * so nothing outside the folder is listed or read.
 */
export async function folderEntries(dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [''];

  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await fs.readdir(path.join(dir, folder), { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      found.push(relative);

      if (entry.isDirectory()) pending.push(relative);
    }
  }

  return found.sort();
}

/** The first link a resource folder holds, by relative path, or none; a folder it cannot read is not taken as holding none. */
export async function firstLink(dir: string): Promise<{ ok: true; link?: string } | { ok: false; reason: string }> {
  try {
    for (const relative of await folderEntries(dir)) {
      if ((await fs.lstat(path.join(dir, relative))).isSymbolicLink()) return { ok: true, link: relative.split(path.sep).join('/') };
    }
  } catch (error) {
    return { ok: false, reason: `its folder cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }

  return { ok: true };
}

/**
 * A resource folder's revision: a hash of every file under it, by relative path, kind, executable bit and content, with
 * a link hashed as the path it names, never what it points to. Each file's header gives its content's length, so no
 * content can stand in for the next file's header: any change a teammate pushes there is a new revision.
 */
export async function folderRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');

  for (const relative of await folderEntries(dir)) {
    const at = path.join(dir, relative);
    const stat = await fs.lstat(at);

    if (stat.isDirectory()) continue;
    const isLink = stat.isSymbolicLink();
    const body = isLink ? Buffer.from(await fs.readlink(at)) : await readRegularFileNoLink(at);
    hash.update(`${JSON.stringify([relative.split(path.sep).join('/'), isLink ? 'link' : 'file', stat.mode & 0o111 ? 'x' : '-', body.byteLength])}\n`).update(body);
  }

  return hash.digest('hex');
}
