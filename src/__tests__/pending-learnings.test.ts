import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../utils/git.js', () => ({
  pushLearningToOrigin: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { pendingLearningsDir, savePendingLearning, flushPendingLearnings } from '../utils/pending-learnings.js';
import { pushLearningToOrigin } from '../utils/git.js';

describe('pendingLearningsDir', () => {
  it('returns a sibling directory named pending-learnings', () => {
    const repoPath = '/home/user/.teamai/team-repo';
    const result = pendingLearningsDir(repoPath);
    expect(result).toBe('/home/user/.teamai/pending-learnings');
  });
});

describe('savePendingLearning', () => {
  let tmpDir: string;
  let repoPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pending-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    fs.mkdirSync(repoPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content to pendingLearningsDir/<filename>', async () => {
    const filename = 'session-2026-01-01-abc123.md';
    const content = '# My learning\nSome notes.';
    await savePendingLearning(repoPath, filename, content);

    const pendingDir = pendingLearningsDir(repoPath);
    const written = fs.readFileSync(path.join(pendingDir, filename), 'utf-8');
    expect(written).toBe(content);
  });
});

describe('flushPendingLearnings', () => {
  let tmpDir: string;
  let repoPath: string;
  let pendingDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-flush-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    fs.mkdirSync(repoPath);
    pendingDir = pendingLearningsDir(repoPath);
    vi.mocked(pushLearningToOrigin).mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 and does not call pushLearningToOrigin when pending dir does not exist', async () => {
    const result = await flushPendingLearnings(repoPath, 'alice');
    expect(result).toBe(0);
    expect(pushLearningToOrigin).not.toHaveBeenCalled();
  });

  it('pushes a pending file and removes it after success', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    const filename = 'notes-2026-01-01-abc123.md';
    const content = '# Notes';
    fs.writeFileSync(path.join(pendingDir, filename), content, 'utf-8');

    vi.mocked(pushLearningToOrigin).mockResolvedValueOnce(true);

    const result = await flushPendingLearnings(repoPath, 'alice');

    expect(result).toBe(1);
    // pending file should be removed
    expect(fs.existsSync(path.join(pendingDir, filename))).toBe(false);
    // file should be written into repoPath/learnings/
    const dest = path.join(repoPath, 'learnings', filename);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  });

  it('returns 0 and keeps pending file when pushLearningToOrigin rejects (offline)', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    const filename = 'notes-2026-01-01-def456.md';
    fs.writeFileSync(path.join(pendingDir, filename), '# Offline notes', 'utf-8');

    vi.mocked(pushLearningToOrigin).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await flushPendingLearnings(repoPath, 'alice');

    expect(result).toBe(0);
    // pending file must NOT be removed
    expect(fs.existsSync(path.join(pendingDir, filename))).toBe(true);
  });

  it('returns 0 and keeps pending file when push is not confirmed on origin (P1 regression)', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    const filename = 'notes-2026-01-01-ghi789.md';
    fs.writeFileSync(path.join(pendingDir, filename), '# Unconfirmed notes', 'utf-8');

    // Push returned false: branch still ahead, learning did not land on origin
    vi.mocked(pushLearningToOrigin).mockResolvedValueOnce(false);

    const result = await flushPendingLearnings(repoPath, 'alice');

    expect(result).toBe(0);
    // pending backup must NOT be removed — would be lost on next reset --hard
    expect(fs.existsSync(path.join(pendingDir, filename))).toBe(true);
  });

  it('stops at first failure and leaves remaining files untouched', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    const file1 = 'first-2026-01-01-aaa111.md';
    const file2 = 'second-2026-01-01-bbb222.md';
    fs.writeFileSync(path.join(pendingDir, file1), '# First', 'utf-8');
    fs.writeFileSync(path.join(pendingDir, file2), '# Second', 'utf-8');

    vi.mocked(pushLearningToOrigin).mockRejectedValueOnce(new Error('Network error'));

    const result = await flushPendingLearnings(repoPath, 'alice');

    expect(result).toBe(0);
    // both files should remain
    const remaining = fs.readdirSync(pendingDir).filter((n) => !n.startsWith('.'));
    expect(remaining.length).toBe(2);
  });

  it('skips entries starting with "."', async () => {
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, '.DS_Store'), 'binary garbage', 'utf-8');

    const result = await flushPendingLearnings(repoPath, 'alice');

    expect(result).toBe(0);
    expect(pushLearningToOrigin).not.toHaveBeenCalled();
  });
});
