import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { buildIndex, loadIndex } from '../utils/search-index.js';

describe('buildIndex — learnings namespace isolation', () => {
  let tmpDir: string;
  let learningsDir: string;
  let indexPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-learn-ns-'));
    learningsDir = path.join(tmpDir, 'learnings');
    indexPath = path.join(tmpDir, 'search-index.json');
    // Root-level shared learning
    await fse.ensureDir(learningsDir);
    await fse.writeFile(path.join(learningsDir, 'shared.md'), '---\ntitle: shared root learning\n---\nshared body');
    // Project-private learnings under subdirectories
    await fse.ensureDir(path.join(learningsDir, 'hai-inference'));
    await fse.writeFile(path.join(learningsDir, 'hai-inference', 'deploy.md'), '---\ntitle: hai deploy note\n---\nhai body');
    await fse.ensureDir(path.join(learningsDir, 'billing'));
    await fse.writeFile(path.join(learningsDir, 'billing', 'invoice.md'), '---\ntitle: billing invoice note\n---\nbilling body');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  const titles = async (): Promise<string[]> => {
    const index = await loadIndex(indexPath);
    return (index?.entries ?? []).map((e) => e.title).sort();
  };

  it('indexes only the shared root when no namespaces are active', async () => {
    await buildIndex({ learningsDir, learningsNamespaces: [], indexPath });
    expect(await titles()).toEqual(['shared root learning']);
  });

  it('includes an active project subdir plus the shared root, excluding other projects', async () => {
    await buildIndex({ learningsDir, learningsNamespaces: ['hai-inference'], indexPath });
    expect(await titles()).toEqual(['hai deploy note', 'shared root learning']);
  });

  it('includes multiple active projects', async () => {
    await buildIndex({ learningsDir, learningsNamespaces: ['hai-inference', 'billing'], indexPath });
    expect(await titles()).toEqual(['billing invoice note', 'hai deploy note', 'shared root learning']);
  });

  it('root-only (undefined namespaces) matches legacy flat behavior', async () => {
    await buildIndex({ learningsDir, indexPath });
    expect(await titles()).toEqual(['shared root learning']);
  });
});
