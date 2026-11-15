import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// sourcePath resolves a linted file from its nearest package.json, so one under a src/ would make that subtree a package
// of its own, out of every rule scoped to production source.
it('finds no package.json under a src/ of this checkout, committed or not, which sourcePath would read as a package root', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*package.json'], { cwd: REPO, encoding: 'utf8' }).split('\n');

  expect(files.filter((file) => /(^|\/)src\/(.+\/)?package\.json$/.test(file))).toEqual([]);
});
