import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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

import { buildIndex, loadIndex } from '../utils/search-index.js';

/**
 * Learnings are read from an ordered list of roots: what a member just wrote,
 * and the corpus the team wrote before it moved off the default branch (#485).
 */
describe('buildIndex over several learnings roots', () => {
  let tmpDir: string;
  let indexPath: string;
  let recent: string;
  let inherited: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-roots-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    recent = path.join(tmpDir, 'learnings-wt', 'learnings');
    inherited = path.join(tmpDir, 'team-repo', 'learnings');
    await fse.ensureDir(recent);
    await fse.ensureDir(inherited);
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('indexes every root, so an inherited corpus stays searchable', async () => {
    await fse.writeFile(path.join(recent, 'new.md'), '---\ntitle: new note\n---\nretry budget');
    await fse.writeFile(path.join(inherited, 'old.md'), '---\ntitle: old note\n---\nretry budget');

    await buildIndex({ learningsDirs: [recent, inherited], indexPath });

    const index = await loadIndex(indexPath);
    expect(index?.entries.map((e) => e.filename).sort()).toEqual(['new.md', 'old.md']);
  });

  it('keeps the first root when the same relative path exists in two of them', async () => {
    await fse.writeFile(path.join(recent, 'same.md'), '---\ntitle: current\n---\ncurrent body');
    await fse.writeFile(path.join(inherited, 'same.md'), '---\ntitle: superseded\n---\nsuperseded body');

    await buildIndex({ learningsDirs: [recent, inherited], indexPath });

    const index = await loadIndex(indexPath);
    const matches = index?.entries.filter((e) => e.filename === 'same.md') ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe(path.join(recent, 'same.md'));
    expect(matches[0]?.title).toBe('current');
  });

  it('applies the same precedence inside a project namespace', async () => {
    await fse.ensureDir(path.join(recent, 'alpha'));
    await fse.ensureDir(path.join(inherited, 'alpha'));
    await fse.writeFile(path.join(recent, 'alpha', 'n.md'), '---\ntitle: current\n---\nbody');
    await fse.writeFile(path.join(inherited, 'alpha', 'n.md'), '---\ntitle: superseded\n---\nbody');

    await buildIndex({
      learningsDirs: [recent, inherited],
      learningsNamespaces: ['alpha'],
      indexPath,
    });

    const index = await loadIndex(indexPath);
    const matches = index?.entries.filter((e) => e.filename === path.join('alpha', 'n.md')) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.title).toBe('current');
  });

  it('still accepts a single directory, the spelling every existing caller uses', async () => {
    await fse.writeFile(path.join(inherited, 'only.md'), '---\ntitle: only\n---\nbody');

    await buildIndex({ learningsDir: inherited, indexPath });

    const index = await loadIndex(indexPath);
    expect(index?.entries.map((e) => e.filename)).toEqual(['only.md']);
  });
});
