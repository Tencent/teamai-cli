import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderFiles } from '../resources/folder-files.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-files-'));
});

afterEach(async () => {
  await fs.chmod(path.join(dir, 'secret.txt'), 0o644).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string, mode = 0o644): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  await fs.chmod(full, mode);
}

describe('FolderFiles.read', () => {
  it('lists every file under the folder, in path order, with its executable bit, and skips hidden entries', async () => {
    await write('HOOK.yaml', 'event: Stop\n');
    await write('scan.sh', '#!/bin/sh\necho ok\n', 0o755);
    await write('examples/good-endpoint.ts', 'export {};\n');
    await write('.DS_Store', 'x');
    await write('.cache/state.json', '{}');

    const read = await FolderFiles.read(dir);

    expect(read).toEqual({
      kind: 'files',
      files: [
        { path: 'HOOK.yaml', executable: false, bytes: Buffer.from('event: Stop\n') },
        { path: 'examples/good-endpoint.ts', executable: false, bytes: Buffer.from('export {};\n') },
        { path: 'scan.sh', executable: process.platform !== 'win32', bytes: Buffer.from('#!/bin/sh\necho ok\n') },
      ],
    });
  });

  it.skipIf(process.platform === 'win32')('makes the folder invalid when it holds a symlink, naming the link', async () => {
    await write('HOOK.yaml', 'event: Stop\n');
    await write('lib/real.sh', 'echo\n');
    await fs.symlink(path.join(dir, 'lib', 'real.sh'), path.join(dir, 'lib', 'link.sh'));
    await fs.symlink(path.join(dir, 'lib'), path.join(dir, 'linked-dir'));

    expect(await FolderFiles.read(dir)).toEqual({
      kind: 'invalid',
      problems: [
        { path: 'lib/link.sh', problem: 'symlink' },
        { path: 'linked-dir', problem: 'symlink' },
      ],
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('makes the folder invalid when a file cannot be read, naming the file', async () => {
    await write('HOOK.yaml', 'event: Stop\n');
    await write('secret.txt', 'x', 0o000);

    expect(await FolderFiles.read(dir)).toEqual({ kind: 'invalid', problems: [{ path: 'secret.txt', problem: 'unreadable' }] });
  });
});
