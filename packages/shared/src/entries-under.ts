import fs from 'node:fs';
import path from 'node:path';

/**
 * Every entry under `dir`, by its path relative to `dir`, without following links: a link to a folder is listed, as a
 * link, and not entered. Node's `readdir({ recursive: true })` enters one (on Node 26 every form of it does), so a link
 * out of `dir` lists what is outside, and two links to a parent never end. Each entry's `parentPath` is the folder it
 * was read in, as the recursive form gives it; folders are read breadth first, as that form reads them.
 */
export function entriesUnder(dir: string): Array<{ relative: string; entry: fs.Dirent }> {
  const found: Array<{ relative: string; entry: fs.Dirent }> = [];
  const folders = [''];

  for (let next = 0; next < folders.length; next += 1) {
    const folder = folders[next] ?? '';

    for (const entry of fs.readdirSync(path.join(dir, folder), { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      found.push({ relative, entry });

      if (entry.isDirectory()) folders.push(relative);
    }
  }

  return found;
}
