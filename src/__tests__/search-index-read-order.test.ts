import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { readFile } from 'node:fs/promises';
import { log } from '../utils/logger.js';
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
    vi.mocked(readFile).mockReset();
    await fse.remove(tmpDir);
  });

  /** Hold every read until `count` have settled, then hand them back in the reverse of the order they were asked for. */
  const settleInReverse = async (count: number): Promise<void> => {
    const { readFile: actualReadFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const releases: (() => void)[] = [];
    let settled = 0;
    vi.mocked(readFile).mockImplementation(async (file, options) => {
      const read = actualReadFile(file, options);
      const turn = new Promise<void>((release) => releases.push(release));
      await read.then(() => undefined, () => undefined);
      if (++settled === count) for (const release of [...releases].reverse()) release();
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

    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.filename)).toEqual(['d1.md', 'd2.md', 'd3.md', 'd4.md']);
    const gone = (file: string): string => `${path.join(docsDir, file)}: ENOENT`;
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining(`(${gone('gone1.md')}, ${gone('gone2.md')}, ${gone('gone3.md')})`),
    ]);
  });
});
