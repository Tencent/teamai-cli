import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  pendingLearningsDir,
  savePendingLearning,
  listPendingLearnings,
  readPendingLearning,
  dropPendingLearning,
} from '../utils/pending-learnings.js';
import { publishQueuedLearnings } from '../utils/learnings-publish.js';
import type { LocalConfig } from '../types.js';

function cloneConfig(localPath: string): LocalConfig {
  return {
    repo: { localPath, remote: 'https://example.com/team.git', kind: 'git' },
    username: 'alice',
    scope: 'user',
    additionalRoles: [],
  };
}

describe('pendingLearningsDir', () => {
  it('sits beside an independent clone, where a clone reset cannot reach it', () => {
    expect(pendingLearningsDir(cloneConfig('/home/user/.teamai/team-repo')))
      .toBe('/home/user/.teamai/pending-learnings');
  });

  it('stays inside .teamai in single-repo mode, so it never shows up in the business repo', () => {
    const result = pendingLearningsDir({
      repo: {
        localPath: '/workspace/product/.teamai',
        remote: 'https://example.com/product.git',
        kind: 'self',
        businessRepoRoot: '/workspace/product',
      },
      username: 'alice',
      scope: 'project',
      projectRoot: '/workspace/product',
      additionalRoles: [],
    });
    expect(result).toBe('/workspace/product/.teamai/pending-learnings');
  });
});

describe('the learnings queue', () => {
  let tmpDir: string;
  let config: LocalConfig;
  let pendingDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pending-test-'));
    const repoPath = path.join(tmpDir, 'team-repo');
    fs.mkdirSync(repoPath);
    config = cloneConfig(repoPath);
    pendingDir = pendingLearningsDir(config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content into the queue', async () => {
    const filename = 'session-2026-01-01-abc123.md';
    await savePendingLearning(config, filename, '# My learning\nSome notes.');

    expect(fs.readFileSync(path.join(pendingDir, filename), 'utf-8')).toBe('# My learning\nSome notes.');
    expect(await readPendingLearning(config, filename)).toBe('# My learning\nSome notes.');
  });

  it('preserves a namespace subdirectory in relPath (PR #426 P1 regression)', async () => {
    const relPath = path.join('alpha-notes', 'session-2026-01-01-abc123.md');
    await savePendingLearning(config, relPath, '# Project-private learning');

    expect(fs.readFileSync(path.join(pendingDir, relPath), 'utf-8')).toBe('# Project-private learning');
    expect(await listPendingLearnings(config)).toEqual([relPath]);
  });

  it('lists nothing when the queue was never created', async () => {
    expect(await listPendingLearnings(config)).toEqual([]);
  });

  it('ignores a hidden entry inside a namespace, whatever the platform separator is', async () => {
    // listFilesRecursive always joins with '/', so a filter that split on the
    // platform separator let these through on Windows.
    fs.mkdirSync(path.join(pendingDir, 'alpha', '.drafts'), { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'alpha', '.drafts', 'wip.md'), '# not ready');
    await savePendingLearning(config, path.join('alpha', 'real.md'), '# real');

    expect(await listPendingLearnings(config)).toEqual([path.join('alpha', 'real.md')]);
  });

  it('ignores hidden entries and anything that is not markdown', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(pendingDir, 'notes.md.swp'), 'junk');
    await savePendingLearning(config, 'real.md', '# real');

    expect(await listPendingLearnings(config)).toEqual(['real.md']);
  });

  it('forgets an entry on request', async () => {
    await savePendingLearning(config, 'gone.md', '# gone');
    await dropPendingLearning(config, 'gone.md');

    expect(await listPendingLearnings(config)).toEqual([]);
  });
});

describe('publishQueuedLearnings, from an independent clone', () => {
  let tmpDir: string;
  let repoPath: string;
  let config: LocalConfig;
  let pendingDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-publish-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    fs.mkdirSync(repoPath);
    config = cloneConfig(repoPath);
    pendingDir = pendingLearningsDir(config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when the queue is empty', async () => {
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report).toEqual({ published: [], remaining: 0 });
  });

  it('keeps the queued copy when the repository cannot be written', async () => {
    // `repoPath` is not a git repository at all, so publishing cannot succeed.
    await savePendingLearning(config, 'notes-2026-01-01-ghi789.md', '# Unpublished notes');

    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual([]);
    expect(report.remaining).toBe(1);
    expect(report.lastError).toBeDefined();
    expect(fs.existsSync(path.join(pendingDir, 'notes-2026-01-01-ghi789.md'))).toBe(true);
  });

  it('leaves every entry queued when publishing fails', async () => {
    await savePendingLearning(config, 'first-2026-01-01-aaa111.md', '# First');
    await savePendingLearning(config, 'second-2026-01-01-bbb222.md', '# Second');

    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual([]);
    expect(report.remaining).toBe(2);
    expect(fs.readdirSync(pendingDir).filter((n) => !n.startsWith('.'))).toHaveLength(2);
  });

  it('leaves the queue alone while a pull or push holds the sync lock', async () => {
    const realHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(tmpDir, 'home', '.teamai'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'home', '.teamai', '.sync-lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'someone-else' }),
    );

    try {
      await savePendingLearning(config, 'held.md', '# held');

      const report = await publishQueuedLearnings(config, 'alice');

      expect(report.published).toEqual([]);
      expect(report.remaining).toBe(1);
      expect(report.lastError).toContain('in progress');
      expect(fs.existsSync(path.join(pendingDir, 'held.md'))).toBe(true);
    } finally {
      process.env.HOME = realHome;
    }
  });

});
