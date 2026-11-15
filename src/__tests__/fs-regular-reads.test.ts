import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotRegularFileError } from '@teamai/shared/regular-file';
import { afterEach, describe, expect, it } from 'vitest';
import { fileContentEqual, fileHash, readFileIfExists, readFileSafe, readJson } from '../utils/fs.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A FIFO in a fresh directory, beside a regular file `same.txt`. A read that waits on it ends only once another process opens it, from three seconds on. */
function fifo(): { pipe: string; regular: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fs-fifo-'));
  dirs.push(root);
  const pipe = path.join(root, 'evidence.json');
  const regular = path.join(root, 'same.txt');
  execFileSync('mkfifo', [pipe]);
  fs.writeFileSync(regular, '');
  releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', pipe], { stdio: 'ignore' }));

  return { pipe, regular };
}

describe.skipIf(process.platform === 'win32')('the read helpers of src/utils/fs.ts at a FIFO a step left', () => {
  it('answer at once as for a file that is not there, rather than waiting for a writer', async () => {
    const { pipe, regular } = fifo();
    const start = Date.now();

    const reads = [await readFileSafe(pipe), await readJson(pipe), await fileHash(pipe), await fileContentEqual(pipe, regular)];

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(reads).toEqual([null, null, null, false]);
  });

  it('refuse it at once, naming what is there, where only a missing file reads as null', async () => {
    const { pipe } = fifo();
    const start = Date.now();

    const read = readFileIfExists(pipe);

    await expect(read).rejects.toBeInstanceOf(NotRegularFileError);
    await expect(read).rejects.toThrow(`${pipe} is a pipe, not a regular file`);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
