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
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

const pullRepoMock = vi.fn().mockResolvedValue('already up to date');
vi.mock('../utils/git.js', () => ({
  pullRepo: (...args: unknown[]) => pullRepoMock(...args),
}));

const cloneRepoMock = vi.fn();
vi.mock('../providers/index.js', () => ({
  detectProvider: vi.fn(() => 'git'),
  getProvider: vi.fn(() => ({
    name: 'git',
    parseRepoInput: (repo: string) => ({ owner: 'x', repo: 'y', httpsUrl: repo }),
    cloneRepo: (...args: unknown[]) => cloneRepoMock(...args),
  })),
}));

import { ensureRepoCache, diffNameSets } from '../utils/external-repo-cache.js';

describe('diffNameSets', () => {
  it('classifies added, removed, and unchanged names', () => {
    const result = diffNameSets(['a', 'b'], ['b', 'c']);
    expect(result.added).toEqual(['c']);
    expect(result.removed).toEqual(['a']);
    expect(result.unchanged).toEqual(['b']);
  });

  it('handles empty previous (everything is added)', () => {
    const result = diffNameSets([], ['a', 'b']);
    expect(result.added.sort()).toEqual(['a', 'b']);
    expect(result.removed).toEqual([]);
  });

  it('handles empty current (everything is removed)', () => {
    const result = diffNameSets(['a', 'b'], []);
    expect(result.removed.sort()).toEqual(['a', 'b']);
    expect(result.added).toEqual([]);
  });
});

describe('ensureRepoCache', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-repo-cache-test-'));
    repoDir = path.join(tmpDir, 'repo');
    pullRepoMock.mockClear();
    cloneRepoMock.mockClear();
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('clones when the repo dir does not exist yet', async () => {
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', null, {
      ttlMs: 1000,
      label: 'test',
    });
    expect(result).toEqual({ pulled: true });
    expect(cloneRepoMock).toHaveBeenCalledTimes(1);
    expect(pullRepoMock).not.toHaveBeenCalled();
  });

  it('returns null when clone fails', async () => {
    cloneRepoMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', null, {
      ttlMs: 1000,
      label: 'test',
    });
    expect(result).toBeNull();
  });

  it('skips pull when within TTL and not forced', async () => {
    await fse.ensureDir(repoDir);
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', new Date().toISOString(), {
      ttlMs: 24 * 60 * 60 * 1000,
      label: 'test',
    });
    expect(result).toEqual({ pulled: false });
    expect(pullRepoMock).not.toHaveBeenCalled();
  });

  it('pulls when the TTL has elapsed', async () => {
    await fse.ensureDir(repoDir);
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', stale, {
      ttlMs: 24 * 60 * 60 * 1000,
      label: 'test',
    });
    expect(result).toEqual({ pulled: true });
    expect(pullRepoMock).toHaveBeenCalledTimes(1);
  });

  it('pulls when forced, regardless of TTL', async () => {
    await fse.ensureDir(repoDir);
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', new Date().toISOString(), {
      force: true,
      ttlMs: 24 * 60 * 60 * 1000,
      label: 'test',
    });
    expect(result).toEqual({ pulled: true });
    expect(pullRepoMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached repo usable when pull fails', async () => {
    await fse.ensureDir(repoDir);
    pullRepoMock.mockRejectedValueOnce(new Error('offline'));
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ensureRepoCache(repoDir, 'git@example.com:a/b.git', stale, {
      ttlMs: 24 * 60 * 60 * 1000,
      label: 'test',
    });
    expect(result).toEqual({ pulled: false });
  });
});
