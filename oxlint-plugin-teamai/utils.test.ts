import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { repositoryPath, sourcePath, workspaceRoot } from './utils.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// sourcePath resolves a linted file from its nearest package.json, so one under a src/ would make that subtree a package
// of its own, out of every rule scoped to production source.
it('finds no package.json under a src/ of this checkout, committed or not, which sourcePath would read as a package root', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*package.json'], { cwd: REPO, encoding: 'utf8' }).split('\n');

  expect(files.filter((file) => /(^|\/)src\/(.+\/)?package\.json$/.test(file))).toEqual([]);
});

it.each([false, true])('keeps a file outside any workspace independent of the linter cwd (package: %s)', (hasPackage) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lint-root-'));
  try {
    if (hasPackage) fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const file = path.join(root, 'src', 'example.ts');
    const context = { filename: file } as Parameters<typeof repositoryPath>[0];
    const normalized = root.split('\\').join('/');

    expect(workspaceRoot(normalized)).toBeUndefined();
    expect(repositoryPath(context)).toEqual({ root: hasPackage ? normalized : `${normalized}/src`, relative: hasPackage ? 'src/example.ts' : 'example.ts' });
    expect(sourcePath(context)).toBe(hasPackage ? 'src/example.ts' : `${normalized}/src/example.ts`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
