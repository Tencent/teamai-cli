import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/regular-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@teamai/shared/regular-file')>();
  return { ...actual, readRegularFile: vi.fn(actual.readRegularFile) };
});

vi.mock('@teamai/shared/log', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { readRegularFile } from '@teamai/shared/regular-file';
import { log } from '@teamai/shared/log';
import { buildIndex, loadIndex } from '../utils/search-index.js';

/** Reads finish in any order, but the index and its warning follow the listing (#1239). */
describe('buildIndex when reads finish out of order (#1239)', () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-read-order-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(readRegularFile).mockReset();
    await fse.remove(tmpDir);
  });

  /** Hold every read until `count` have settled, then hand them back in the reverse of the order they were asked for. */
  const settleInReverse = async (count: number): Promise<void> => {
    const { readRegularFile: actualRead } = await vi.importActual<typeof import('@teamai/shared/regular-file')>('@teamai/shared/regular-file');
    const releases: (() => void)[] = [];
    let settled = 0;
    vi.mocked(readRegularFile).mockImplementation(async (file: string, encoding: BufferEncoding) => {
      const read = actualRead(file, encoding);
      // The index file itself is read through the same helper; only the docs are held.
      if (!file.endsWith('.md')) return read;
      const turn = new Promise<void>((release) => releases.push(release));
      await read.then(() => undefined, () => undefined);
      if (++settled === count) for (const release of releases.toReversed()) release();
      await turn;
      return read;
    });
  };

  it('keeps the listing order of entries and of unreadable files', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    const docFiles = ['d1.md', 'gone1.md', 'd2.md', 'gone2.md', 'd3.md', 'gone3.md', 'd4.md'];
    for (const file of docFiles.filter((name) => !name.startsWith('gone'))) {
      await fse.outputFile(path.join(docsDir, file), `---\ntitle: ${file}\n---\nbody`);
    }
    await settleInReverse(docFiles.length);

    await buildIndex({ docsDir, docFiles, indexPath });

    expect(vi.mocked(readRegularFile).mock.calls.filter(([file]) => file.endsWith('.md'))).toHaveLength(docFiles.length);

    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.filename)).toEqual(['d1.md', 'd2.md', 'd3.md', 'd4.md']);
    const gone = (file: string): string => `${path.join(docsDir, file)}: ENOENT`;
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining(`(${gone('gone1.md')}, ${gone('gone2.md')}, ${gone('gone3.md')})`),
    ]);
  });
});
