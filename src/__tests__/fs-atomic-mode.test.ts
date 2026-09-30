import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';

/**
 * The secret and model key stores write through these helpers (#879): the
 * temp file must never be readable by group or other, not even between its
 * creation and the chmod that sets the target's mode.
 */
describe.skipIf(process.platform === 'win32')('atomic writes create the temp file with the target mode', () => {
  let tmpDir: string;
  let previousUmask: number;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-fs-atomic-'));
    previousUmask = process.umask(0o022);
  });

  afterEach(async () => {
    process.umask(previousUmask);
    vi.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  const writers = [
    ['writeFileAtomic', (file: string) => writeFileAtomic(file, 'fixture-secret\n', { mode: 0o600 })],
    ['writeJsonAtomic', (file: string) => writeJsonAtomic(file, { KEY: { value: 'fixture-secret' } }, { mode: 0o600 })],
  ] as const;

  it.each(writers)('%s: the temp file has no group or other bits before its chmod', async (_name, write) => {
    const seen: number[] = [];
    const chmod = fse.chmod.bind(fse);
    vi.spyOn(fse, 'chmod').mockImplementation(async (file: fse.PathLike, mode: fse.Mode) => {
      seen.push((await fse.stat(file)).mode & 0o777);
      return chmod(file, mode);
    });
    const file = path.join(tmpDir, 'store.json');

    await write(file);

    expect(seen).toHaveLength(1);
    expect(seen[0] & 0o077).toBe(0);
    expect((await fse.stat(file)).mode & 0o777).toBe(0o600);
  });
});
