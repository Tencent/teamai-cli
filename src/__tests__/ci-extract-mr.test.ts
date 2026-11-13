/**
 * The verbs a teamai-ci-extract-mr run's steps call: ci write updates the teamwiki from the merged checkout through a
 * teamai-import-from-repo run, then writes the learning and pushes the team repo; ci comment and ci artifacts say or
 * write the learning the extract step drafted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockPostOrUpdateMrComment = vi.fn();
vi.mock('../ci/mr-comment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci/mr-comment.js')>();
  return { ...actual, postOrUpdateMrComment: (...args: unknown[]) => mockPostOrUpdateMrComment(...args) };
});

const mockPushRepoDirectly = vi.fn();
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    pushRepoDirectly: (...args: unknown[]) => mockPushRepoDirectly(...args),
  };
});

const mockStartImport = vi.fn();
vi.mock('../import-from-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../import-from-repo.js')>();
  return { ...actual, ImportFromRepo: { ...actual.ImportFromRepo, start: (...args: unknown[]) => mockStartImport(...args) } };
});

/** How a teamai-import-from-repo run of one checkout ends: it updated the teamwiki, or found nothing to change. */
function importEnded(updated: boolean) {
  return { run: 'r1', outcome: 'succeeded', outputs: { text: '', exit_code: 0, imported: [{ source: 'checkout', slug: 'github__org__repo', updated, failed: false }] } };
}

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { CiExtractMr } from '../ci/extract-mr.js';

const TODAY = new Date().toISOString().slice(0, 10);

describe('teamai ci write: the teamwiki update goes through teamai import', () => {
  let tmpDir: string;
  let source: string;
  let learnings: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: source, stdio: 'ignore' });

  /** The flags the write step passes for MR `url`, writing into `teamRepo`. */
  const flags = (url: string, teamRepo: string, preview = false) => ({ url, learnings, teamRepo, individual: 'false', preview: String(preview) });

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

    // What the extract step drafted.
    const file = path.join(tmpDir, 'run', 'learning.md');
    await fse.outputFile(file, '---\ntitle: Test Learning\n---\nContent');
    learnings = JSON.stringify([{ url: 'https://github.com/org/repo/pull/7', title: 'Test Learning', file, repo_url: 'https://github.com/org/repo' }]);

    mockPushRepoDirectly.mockReset();
    mockStartImport.mockReset();
    mockStartImport.mockResolvedValue(importEnded(true));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fse.remove(tmpDir);
  });

  it('imports the checkout incrementally under the slug import --from-repo uses, then pushes teamwiki/ with the learning', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/7', teamRepo));

    expect(mockStartImport).toHaveBeenCalledWith({
      mode: 'ci',
      items: [{ kind: 'dir', dir: source, slug: 'github__org__repo', repoUrl: 'https://github.com/org/repo', mrUrls: ['https://github.com/org/repo/pull/7'] }],
      settings: { depth: 1, forceSsh: false, incremental: true, skipEnrich: false },
      target: { wikiRoot: path.join(teamRepo, 'teamwiki') },
      command: 'teamai ci extract-mr',
    });
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(teamRepo, '[teamai] CI extract knowledge from MR', ['teamwiki', `learnings/${TODAY}-Test-Learning.md`]);
    expect(await fse.readFile(path.join(teamRepo, 'learnings', `${TODAY}-Test-Learning.md`), 'utf8')).toBe('---\ntitle: Test Learning\n---\nContent');
    // Nothing is written into the checkout.
    expect(await fse.pathExists(path.join(source, 'teamwiki'))).toBe(false);
  });

  it('pushes no teamwiki/ when the import changed nothing', async () => {
    mockStartImport.mockResolvedValue(importEnded(false));
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/7', teamRepo));

    expect(mockStartImport).toHaveBeenCalled();
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(teamRepo, expect.any(String), [`learnings/${TODAY}-Test-Learning.md`]);
  });

  it('updates the teamwiki for a merge that only deletes a source file', async () => {
    await fse.remove(path.join(source, 'src', 'b.ts'));
    git('add', '-A');
    git('commit', '-q', '-m', 'delete b');
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/8', teamRepo));

    expect(mockStartImport).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ incremental: true }) }));
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

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/9', teamRepo));

    expect(mockStartImport).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ dir: source })] }));
  });

  it('skips the teamwiki update when the team repo is cloned inside the checkout', async () => {
    const teamRepo = path.join(source, 'team-repo');
    await fse.ensureDir(teamRepo);

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/7', teamRepo));

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockPushRepoDirectly).toHaveBeenCalledWith(teamRepo, expect.any(String), [`learnings/${TODAY}-Test-Learning.md`]);
  });

  it('with --preview true imports nothing, writes nothing and pushes nothing', async () => {
    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/7', teamRepo, true));

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockPushRepoDirectly).not.toHaveBeenCalled();
    expect(await fse.pathExists(path.join(teamRepo, 'learnings'))).toBe(false);
  });

  it('refuses learnings that are not what the step passes', async () => {
    await expect(CiExtractMr.write({ ...flags('https://github.com/org/repo/pull/7', tmpDir), learnings: '[]' })).rejects.toThrow('--learnings holds no learning');
  });

  it('configures git user from GitHub /user endpoint using GH_TOKEN when GITHUB_TOKEN is unset', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    delete process.env.GITHUB_TOKEN;
    vi.stubEnv('GH_TOKEN', 'alias-token');

    let requestHeaders: Record<string, string> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      requestHeaders = init?.headers;
      return Promise.resolve(new Response(JSON.stringify({ login: 'bot-user', email: 'bot@example.com' }), { status: 200 }));
    }));

    const teamRepo = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(teamRepo);
    execFileSync('git', ['init', '-q'], { cwd: teamRepo });

    await CiExtractMr.write(flags('https://github.com/org/repo/pull/7', teamRepo));

    expect(requestHeaders?.Authorization).toBe('Bearer alias-token');
    const name = execFileSync('git', ['config', 'user.name'], { cwd: teamRepo, encoding: 'utf8' }).trim();
    const email = execFileSync('git', ['config', 'user.email'], { cwd: teamRepo, encoding: 'utf8' }).trim();
    expect(name).toBe('bot-user');
    expect(email).toBe('bot@example.com');
  });
});

describe('teamai ci comment and ci artifacts', () => {
  let tmpDir: string;
  let learnings: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-ci-comment-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const file = path.join(tmpDir, 'learning.md');
    await fse.outputFile(file, '---\ntitle: Test Learning\n---\nContent');
    learnings = JSON.stringify([{ url: 'https://github.com/org/repo/pull/1', title: 'Test Learning', file, repo_url: '' }]);
    mockPostOrUpdateMrComment.mockReset();
    mockPostOrUpdateMrComment.mockResolvedValue({ created: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fse.remove(tmpDir);
  });

  it('comments the drafted learning under the marker the step passes, and only says it with --preview true', async () => {
    await CiExtractMr.comment({ url: 'https://github.com/org/repo/pull/1', learnings, marker: '<!-- acme -->', individual: 'false', preview: 'true' });

    expect(mockPostOrUpdateMrComment).toHaveBeenCalledWith('https://github.com/org/repo/pull/1', { title: 'Test Learning', content: '---\ntitle: Test Learning\n---\nContent' }, undefined, '<!-- acme -->', true);
  });

  it('writes the drafted learning into the directory as learning.md', async () => {
    const dir = path.join(tmpDir, 'out');

    await CiExtractMr.artifacts({ learnings, dir });

    expect(await fse.readFile(path.join(dir, 'learning.md'), 'utf8')).toBe('---\ntitle: Test Learning\n---\nContent');
  });
});
