import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #808: git and self mode share the data home, so the indexes an install built
// point into the other repository once `init` changes its kind.

const { dropAllSearchIndexes } = await import('../utils/search-index.js');

describe('dropAllSearchIndexes (#808)', () => {
  let dataHome: string;

  beforeEach(() => {
    dataHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-drop-indexes-')));
  });

  afterEach(() => {
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  const write = (rel: string): string => {
    const file = path.join(dataHome, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    return file;
  };

  it('deletes the root index and every checkout index, and nothing else', async () => {
    const root = write('search-index.json');
    const a = write('workspaces/a/search-index.json');
    const b = write('workspaces/b/search-index.json');
    const mcp = write('workspaces/a/mcp.json');
    const queued = write('pending-learnings/note.md');

    await dropAllSearchIndexes(dataHome);

    expect([root, a, b].filter((f) => fs.existsSync(f))).toEqual([]);
    expect([mcp, queued].filter((f) => fs.existsSync(f))).toEqual([mcp, queued]);
  });

  it('succeeds when no index was ever built', async () => {
    await expect(dropAllSearchIndexes(dataHome)).resolves.toBeUndefined();
  });
});
