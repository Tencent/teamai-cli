import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The version pull names a delivered hook or MCP folder with (#1787), worked out from the team repo's folder at
 * `dir` as the guide states it: the first 8 hex digits of the SHA-256 of the folder's files as canonical JSON, each
 * file's git blob id, mode and `/`-separated path in NFC, in path order, hidden entries left out. A file git tracks and the
 * checkout has not changed counts as the index holds it; any other file as it is on disk; a file git ignores not at all.
 */
export function folderVersion(dir: string): string {
  const onDisk = walk(dir);
  const inGit = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' }).status === 0;
  const git = (...args: string[]): string[] => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).split('\0').filter((line) => line !== '');
  const staged = new Map(inGit ? git('ls-files', '-z', '-s', '--', '.').map((line) => {
    const [info = '', file = ''] = line.split('\t');
    const [mode = '', blob = ''] = info.split(' ');

    return [file, { mode, blob }] as const;
  }) : []);

  const changed = new Set(inGit ? [...git('ls-files', '-z', '-m', '--', '.'), ...git('ls-files', '-z', '-o', '--exclude-standard', '--', '.')] : onDisk.map((file) => file.path));
  const ids = onDisk.flatMap((file) => {
    if (!changed.has(file.path)) {
      const index = staged.get(file.path);

      return index === undefined ? [] : [{ blob: index.blob, mode: index.mode, path: file.path }];
    }

    const blob = execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { input: fs.readFileSync(file.full), encoding: 'utf8' }).trim();

    return [{ blob, mode: file.executable ? '100755' : '100644', path: file.path }];
  });

  return createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 8);
}

/** Every file under `dir`, hidden entries left out, in path order. */
function walk(dir: string): Array<{ path: string; full: string; executable: boolean }> {
  const files: Array<{ path: string; full: string; executable: boolean }> = [];

  const visit = (at: string, prefix: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(at, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) visit(full, rel);
      else files.push({ path: rel.normalize('NFC'), full, executable: process.platform !== 'win32' && (fs.statSync(full).mode & 0o111) !== 0 });
    }
  };

  visit(dir, '');

  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
