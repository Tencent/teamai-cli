import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { refusedWrite } from '../utils/fs.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    for (const dir of [root, ...fs.readdirSync(root).map((name) => path.join(root, name))]) fs.chmodSync(dir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A folder `writable` this process may write in, beside one `refusing` it may not, with a file `source` in the first. */
function folders(): { writable: string; refusing: string; source: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-refused-write-'));
  roots.push(root);
  const writable = path.join(root, 'writable');
  const refusing = path.join(root, 'refusing');
  fs.mkdirSync(writable);
  fs.mkdirSync(refusing);
  const source = path.join(writable, 'source.txt');
  fs.writeFileSync(source, 'kept\n');
  fs.chmodSync(refusing, 0o555);

  return { writable, refusing, source };
}

async function thrown(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().then(() => { throw new Error('the operation was not refused'); }, (error: unknown) => error);
}

// A process that runs as root may write anywhere a mode forbids, so no refusal can be made here.
const isRoot = process.getuid?.() === 0;

it.skipIf(process.platform === 'win32' || isRoot)('reads a refused create or overwrite as a refused write in its folder', async () => {
  const { refusing } = folders();
  const kept = path.join(refusing, 'kept.txt');
  fs.chmodSync(refusing, 0o755);
  fs.writeFileSync(kept, 'kept\n');
  fs.chmodSync(kept, 0o444);
  fs.chmodSync(refusing, 0o555);

  expect(refusedWrite(await thrown(() => fs.promises.writeFile(path.join(refusing, 'new.txt'), 'x')))).toEqual({ folder: refusing, code: 'EACCES' });
  expect(refusedWrite(await thrown(() => fs.promises.writeFile(kept, 'x')))).toEqual({ folder: refusing, code: 'EACCES' });
});

it.skipIf(process.platform === 'win32' || isRoot)('reads no refused write in a read the filesystem refused', async () => {
  const { source } = folders();
  fs.chmodSync(source, 0o200);

  expect(refusedWrite(await thrown(() => fs.promises.readFile(source)))).toBeUndefined();
});

it.skipIf(process.platform === 'win32' || isRoot).each([
  ['rename', (from: string, to: string) => fs.promises.rename(from, to)],
  ['link', (from: string, to: string) => fs.promises.link(from, to)],
  ['copyfile', (from: string, to: string) => fs.promises.copyFile(from, to)],
  ['symlink', (from: string, to: string) => fs.promises.symlink(from, to)],
])('names the folder a refused %s writes into, not its source\'s', async (_call, operation) => {
  const { refusing, source } = folders();

  expect(refusedWrite(await thrown(() => operation(source, path.join(refusing, 'target.txt'))))).toEqual({ folder: refusing, code: 'EACCES' });
});

it.skipIf(process.platform === 'win32' || isRoot)('names the source\'s folder when a rename may not take the file out of it', async () => {
  const { writable, refusing } = folders();
  fs.chmodSync(refusing, 0o755);
  const source = path.join(refusing, 'source.txt');
  fs.writeFileSync(source, 'kept\n');
  fs.chmodSync(refusing, 0o555);

  expect(refusedWrite(await thrown(() => fs.promises.rename(source, path.join(writable, 'target.txt'))))).toEqual({ folder: refusing, code: 'EACCES' });
});

it.skipIf(process.platform === 'win32' || isRoot)('reads no refused write in a copy whose source may not be read', async () => {
  const { writable, source } = folders();
  fs.chmodSync(source, 0o200);

  expect(refusedWrite(await thrown(() => fs.promises.copyFile(source, path.join(writable, 'target.txt'))))).toBeUndefined();
});

it('reads no refused write in an EPERM of a rename on Windows, where another process holding the file open causes it', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const renamed = (code: string) => Object.assign(new Error(`${code}: rename`), { code, syscall: 'rename', path: 'C:\\team\\lock.new', dest: 'C:\\team\\lock' });

  expect(refusedWrite(renamed('EPERM'))).toBeUndefined();
  expect(refusedWrite(renamed('EACCES'))).toBeDefined();
});
