import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The version pull names a delivered hook or MCP folder with (#1787), worked out from the team repo's folder at
 * `dir` as the guide states it: the first 8 hex digits of the SHA-256 of the folder's files as canonical JSON, each
 * file's `/`-separated path, whether it is executable, and the SHA-256 of its bytes, in path order, hidden entries
 * left out.
 */
export function folderVersion(dir: string): string {
  const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
  const files: Array<{ executable: boolean; path: string; sha256: string }> = [];

  const walk = (at: string, prefix: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(at, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) walk(full, rel);
      else files.push({ executable: (fs.statSync(full).mode & 0o100) !== 0, path: rel, sha256: sha256(fs.readFileSync(full)) });
    }
  };

  walk(dir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  return sha256(JSON.stringify(files)).slice(0, 8);
}
