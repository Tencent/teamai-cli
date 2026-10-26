import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    pushRepoDirectly: (...args: unknown[]) => mockPushRepoDirectly(...args),
  };
});

const mockAppendPendingReview = vi.fn();
vi.mock('../review-store.js', () => ({
  appendPendingReview: (...args: unknown[]) => mockAppendPendingReview(...args),
}));

const mockImportLocalCheckout = vi.fn();
vi.mock('../import-codebase.js', () => ({
  importLocalCheckout: (...args: unknown[]) => mockImportLocalCheckout(...args),
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
      repoUrl: 'https://github.com/org/repo.git',
    });
    mockPostOrUpdateMrComment.mockResolvedValue({ created: true, url: 'https://example.com/comment' });
    mockApplyCodebaseSuggestions.mockResolvedValue('# Updated codebase');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('comment mode calls postOrUpdateMrComment', async () => {
    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
    });

    expect(mockImportFromMR).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/org/repo/pull/1',
      all: true,
      dryRun: true,
    }));
    // codebase suggestions are no longer posted as a comment (the graph change comment replaced it)
    expect(mockPostOrUpdateMrComment).toHaveBeenCalledWith(
      'https://github.com/org/repo/pull/1',
      expect.objectContaining({ title: 'Test Learning' }),
      undefined,
      undefined,
      undefined,
    );
  });

  it('hands its --comment-marker to the extraction so its own comments stay out of the review threads (#1187)', async () => {
    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
      commentMarker: '<!-- learning-bot -->',
    });

    expect(mockImportFromMR).toHaveBeenCalledWith(expect.objectContaining({
      commentMarker: '<!-- learning-bot -->',
    }));
  });

  it('write mode requires --team-repo', async () => {
    await expect(ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'write',
    })).rejects.toThrow('write mode requires --team-repo');
  });

  it('write mode direct: writes the learning and calls pushRepoDirectly', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(teamRepo, 'docs'));
    await fse.writeFile(path.join(teamRepo, 'docs', 'codebase.md'), '# Codebase');

    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'write',
      teamRepo,
      writeMode: 'direct',
    });

    // the learning file is written
    const learnings = await fse.readdir(path.join(teamRepo, 'learnings'));
    expect(learnings.length).toBe(1);
    expect(learnings[0]).toContain('Test-Learning');

    // the graph engine replaced codebase direct mode, so applyCodebaseSuggestions is no longer called
    // mockApplyCodebaseSuggestions must not be called

    // push is called (with the learning only, not docs/codebase.md)
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(
      teamRepo,
      expect.stringContaining('[teamai]'),
      expect.not.arrayContaining(['docs/codebase.md']),
    );
  });

  it('write mode pending-review: writes the learning without calling appendPendingReview (codebase suggestions were removed)', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(teamRepo, 'learnings'));

    await ciExtractMr({
      url: 'https://git.woa.com/team/project/merge_requests/5',
      mode: 'write',
      teamRepo,
      writeMode: 'pending-review',
    });

    // the codebase suggestion path was removed, so appendPendingReview is no longer called
    expect(mockAppendPendingReview).not.toHaveBeenCalled();
    // the learning is still written
    const learnings = await fse.readdir(path.join(teamRepo, 'learnings'));
    expect(learnings.length).toBe(1);
  });

  it('both mode runs comment and write', async () => {
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

  it('the output option writes artifacts', async () => {
    const outputDir = path.join(tmpDir, 'output');

    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
      output: outputDir,
    });

    expect(await fse.pathExists(path.join(outputDir, 'learning.md'))).toBe(true);
    // the codebase suggestion path was removed, so codebase-suggestions.json is no longer written
    expect(await fse.pathExists(path.join(outputDir, 'codebase-suggestions.json'))).toBe(false);
  });

  it('dry-run calls no API', async () => {
    await ciExtractMr({
      url: 'https://github.com/org/repo/pull/1',
      mode: 'comment',
      dryRun: true,
    });

    expect(mockPostOrUpdateMrComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      undefined,
      undefined,
      true,
    );
  });
});

describe('ciExtractMr write: the teamwiki update goes through teamai import', () => {
  let tmpDir: string;
  let source: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: source, stdio: 'ignore' });

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-ci-import-'));
    // The merged checkout CI runs in: its last commit changed a source file.
    source = path.join(tmpDir, 'checkout');
    await fse.outputFile(path.join(source, 'src', 'a.ts'), 'export const a = 1;\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    await fse.outputFile(path.join(source, 'src', 'b.ts'), 'export function b() { return 2; }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'merge');
    vi.spyOn(process, 'cwd').mockReturnValue(source);

    mockImportFromMR.mockReset();
    mockPushRepoDirectly.mockReset();
    mockImportLocalCheckout.mockReset();
    mockImportFromMR.mockResolvedValue({ learning: undefined, repoUrl: 'https://github.com/org/repo' });
    mockImportLocalCheckout.mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  it('imports the checkout incrementally under the slug import --from-repo uses, then pushes teamwiki/', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await ciExtractMr({ url: 'https://github.com/org/repo/pull/7', mode: 'write', teamRepo });

    expect(mockImportLocalCheckout).toHaveBeenCalledWith({
      sourceDir: source,
      slug: 'github__org__repo',
      wikiRoot: path.join(teamRepo, 'teamwiki'),
      incremental: true,
      repoUrl: 'https://github.com/org/repo',
      sourceMrUrl: 'https://github.com/org/repo/pull/7',
    });
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(teamRepo, expect.any(String), ['teamwiki']);
    // Nothing is written into the checkout.
    expect(await fse.pathExists(path.join(source, 'teamwiki'))).toBe(false);
  });

  it('pushes no teamwiki/ when the import changed nothing', async () => {
    mockImportLocalCheckout.mockResolvedValue(false);
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await ciExtractMr({ url: 'https://github.com/org/repo/pull/7', mode: 'write', teamRepo });

    expect(mockImportLocalCheckout).toHaveBeenCalled();
    expect(mockPushRepoDirectly).not.toHaveBeenCalled();
  });

  it('updates the teamwiki for a merge that only deletes a source file', async () => {
    await fse.remove(path.join(source, 'src', 'b.ts'));
    git('add', '-A');
    git('commit', '-q', '-m', 'delete b');
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await ciExtractMr({ url: 'https://github.com/org/repo/pull/8', mode: 'write', teamRepo });

    expect(mockImportLocalCheckout).toHaveBeenCalledWith(expect.objectContaining({ incremental: true }));
  });

  it('finds changed files through the repository default branch when it is not master', async () => {
    const first = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: source, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', first], { cwd: source, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: source, stdio: 'ignore' });

    // HEAD's own diff and `git show` contain no source file; only the
    // origin/<default>...HEAD comparison reaches back to the source change.
    await fse.outputFile(path.join(source, 'README.md'), 'docs only\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs only');

    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await ciExtractMr({ url: 'https://github.com/org/repo/pull/9', mode: 'write', teamRepo });

    expect(mockImportLocalCheckout).toHaveBeenCalledWith(expect.objectContaining({ sourceDir: source }));
  });

  it('skips the teamwiki update when the team repo is cloned inside the checkout', async () => {
    const teamRepo = path.join(source, 'team-repo');
    await fse.ensureDir(teamRepo);

    await ciExtractMr({ url: 'https://github.com/org/repo/pull/7', mode: 'write', teamRepo: './team-repo' });

    expect(mockImportLocalCheckout).not.toHaveBeenCalled();
    expect(mockPushRepoDirectly).not.toHaveBeenCalled();
  });
});
