import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { entriesUnder } from './entries-under.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-entries-under-'));
  dirs.push(dir);

  return dir;
}

/** Each entry as `relative:kind`, so a link reads as a link and not as what it points to. */
function listed(dir: string): string[] {
  return entriesUnder(dir).map(({ relative, entry }) => `${relative.split(path.sep).join('/')}:${entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'file'}`).sort();
}

it('lists every file and folder under a folder by its path from it, with the folder it was read in', () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.md'), '');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.md'), '');

  expect(listed(dir)).toEqual(['a/b/deep.md:file', 'a/b:folder', 'a:folder', 'top.md:file']);
  expect(entriesUnder(dir).find(({ entry }) => entry.name === 'deep.md')?.entry.parentPath).toBe(path.join(dir, 'a', 'b'));
});

it('lists a link to a folder outside as a link, and nothing behind it', () => {
  const dir = scratch();
  const outside = scratch();
  fs.writeFileSync(path.join(outside, 'elsewhere.md'), '');
  fs.mkdirSync(path.join(dir, 'rules'));
  fs.symlinkSync(outside, path.join(dir, 'rules', 'linked'));

  expect(listed(dir)).toEqual(['rules/linked:link', 'rules:folder']);
});

it('ends on two links to a parent, which a recursive readdir follows round and round', () => {
  const dir = scratch();
  for (const folder of ['a', 'b']) {
    fs.mkdirSync(path.join(dir, folder));
    fs.symlinkSync('..', path.join(dir, folder, 'up'));
  }

  expect(listed(dir)).toEqual(['a/up:link', 'a:folder', 'b/up:link', 'b:folder']);
});

it('throws the error of a folder that is not there, as readdir does', () => {
  expect(() => entriesUnder(path.join(scratch(), 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});
