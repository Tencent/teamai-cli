import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// ─── Mocks ─────────────────────────────────────────────

const mockImportFromMR = vi.fn();
vi.mock('../import-mr.js', () => ({
  importFromMR: (...args: unknown[]) => mockImportFromMR(...args),
}));

const mockPostOrUpdateMrComment = vi.fn();
vi.mock('../ci/mr-comment.js', () => ({
  postOrUpdateMrComment: (...args: unknown[]) => mockPostOrUpdateMrComment(...args),
}));

const mockPushRepoDirectly = vi.fn();
vi.mock('../utils/git.js', () => ({
  pushRepoDirectly: (...args: unknown[]) => mockPushRepoDirectly(...args),
}));

const mockAppendPendingReview = vi.fn();
vi.mock('../review-store.js', () => ({
  appendPendingReview: (...args: unknown[]) => mockAppendPendingReview(...args),
}));

const mockApplyCodebaseSuggestions = vi.fn();
vi.mock('../codebase.js', () => ({
  applyCodebaseSuggestions: (...args: unknown[]) => mockApplyCodebaseSuggestions(...args),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { ciExtractMr } from '../ci/extract-mr.js';

// ─── Tests ─────────────────────────────────────────────

describe('ciExtractMr', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-ci-test-'));
    mockImportFromMR.mockReset();
    mockPostOrUpdateMrComment.mockReset();
    mockPushRepoDirectly.mockReset();
    mockAppendPendingReview.mockReset();
    mockApplyCodebaseSuggestions.mockReset();

    mockImportFromMR.mockResolvedValue({
      learning: { title: 'Test Learning', content: '# Test\n\nContent' },
      codebaseSuggestions: [{ section: 'arch', action: 'update', content: 'New info' }],
    });
    mockPostOrUpdateMrComment.mockResolvedValue({ created: true, url: 'https://example.com/comment' });
    mockApplyCodebaseSuggestions.mockResolvedValue('# Updated codebase');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('comment 模式调用 postOrUpdateMrComment', async () => {
    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
    });

    expect(mockImportFromMR).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/org/repo/pull/1',
      all: true,
      dryRun: true,
    }));
    expect(mockPostOrUpdateMrComment).toHaveBeenCalledWith(
      'https://github.com/org/repo/pull/1',
      expect.objectContaining({ title: 'Test Learning' }),
      expect.arrayContaining([expect.objectContaining({ section: 'arch' })]),
      undefined,
      undefined,
    );
  });

  it('write 模式需要 --team-repo 参数', async () => {
    await expect(ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'write',
    })).rejects.toThrow('write 模式需要 --team-repo 参数');
  });

  it('write 模式 direct: 写 learning + 调用 pushRepoDirectly', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(teamRepo, 'docs'));
    await fse.writeFile(path.join(teamRepo, 'docs', 'codebase.md'), '# Codebase');

    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'write',
      teamRepo,
      writeMode: 'direct',
    });

    // learning 文件被写入
    const learnings = await fse.readdir(path.join(teamRepo, 'learnings'));
    expect(learnings.length).toBe(1);
    expect(learnings[0]).toContain('Test-Learning');

    // codebase 被更新
    expect(mockApplyCodebaseSuggestions).toHaveBeenCalled();

    // push 被调用
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(
      teamRepo,
      expect.stringContaining('[teamai]'),
      expect.arrayContaining(['docs/codebase.md']),
    );
  });

  it('write 模式 pending-review: 调用 appendPendingReview', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(teamRepo, 'learnings'));

    await ciExtractMr({
      url: 'https://git.woa.com/team/project/merge_requests/5',
      mode: 'write',
      teamRepo,
      writeMode: 'pending-review',
    });

    expect(mockAppendPendingReview).toHaveBeenCalledWith(
      teamRepo,
      expect.objectContaining({
        kind: 'codebase-section',
        source: expect.stringContaining('ci:extract-mr:'),
      }),
    );
  });

  it('both 模式同时调用 comment 和 write', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(teamRepo, 'docs'));
    await fse.writeFile(path.join(teamRepo, 'docs', 'codebase.md'), '# Codebase');

    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/2',
      mode: 'both',
      teamRepo,
    });

    expect(mockPostOrUpdateMrComment).toHaveBeenCalled();
    expect(mockPushRepoDirectly).toHaveBeenCalled();
  });

  it('output 选项输出 artifacts', async () => {
    const outputDir = path.join(tmpDir, 'output');

    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
      output: outputDir,
    });

    expect(await fse.pathExists(path.join(outputDir, 'learning.md'))).toBe(true);
    expect(await fse.pathExists(path.join(outputDir, 'codebase-suggestions.json'))).toBe(true);
  });

  it('dry-run 不调用 API', async () => {
    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
      dryRun: true,
    });

    expect(mockPostOrUpdateMrComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.anything(),
      undefined,
      true,
    );
  });
});
