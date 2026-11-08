import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportsMocks = vi.hoisted(() => {
  class EmptyRepoError extends Error {}
  class DirtyPreviewError extends Error {}
  return { withKnowledgeWorktree: vi.fn(), withDefaultBranchPreview: vi.fn(), EmptyRepoError, DirtyPreviewError };
});
vi.mock('../utils/reports-branch.js', () => reportsMocks);

const gitMocks = vi.hoisted(() => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  pushRepoBranch: vi.fn(),
  checkoutMaster: vi.fn().mockResolvedValue(undefined),
  unusedBranchName: vi.fn().mockResolvedValue('teamai/push/test/20260305-120000'),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  ...gitMocks,
}));

const prMocks = vi.hoisted(() => ({
  createPrWithFallback: vi.fn().mockResolvedValue('https://example.test/team/repo/pull/1'),
  providerOpensPullRequests: vi.fn().mockReturnValue(true),
}));
vi.mock('../push.js', () => prMocks);

const logMocks = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const spin = vi.hoisted(() => ({ succeed: vi.fn(), warn: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ log: logMocks, spinner: vi.fn(() => ({ start: () => spin })) }));

import { pushManifestChange, runManifestEdit } from '../manifest-edit.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

function config(kind: 'self' | undefined, localPath: string): LocalConfig {
  return {
    repo: { kind, localPath, remote: 'https://github.com/team/repo.git' },
    username: 'admin',
    updatePolicy: 'auto',
    additionalRoles: [],
    scope: 'project',
  } as LocalConfig;
}

describe('runManifestEdit', () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    // process.exitCode is global state: leaving it set would leak into the
    // next case and, worse, into vitest's own exit status.
    process.exitCode = 0;
  });

  it('pulls and edits the team repo clone directly outside single-repo mode', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const localConfig = config(undefined, '/team-repo');

    await runManifestEdit(localConfig, 'Projects', fn);

    expect(gitMocks.pullRepo).toHaveBeenCalledWith('/team-repo');
    expect(fn).toHaveBeenCalledWith('/team-repo', localConfig);
    expect(reportsMocks.withKnowledgeWorktree).not.toHaveBeenCalled();
  });

  // The pull can reset a clone with unpushed commits, and the worktree is a
  // write to the member's repo (#900).
  it.each([undefined, 'self'] as const)('previews from origin without pulling or a worktree (kind %s)', async (kind) => {
    const previewConfig = config(kind, '/tmp/preview');
    reportsMocks.withDefaultBranchPreview.mockImplementation(
      async (_config: LocalConfig, body: (preview: LocalConfig) => Promise<void>) => body(previewConfig),
    );
    const fn = vi.fn().mockResolvedValue(undefined);

    await runManifestEdit(config(kind, '/team-repo'), 'Roles', fn, { dryRun: true });

    expect(fn).toHaveBeenCalledWith('/tmp/preview', previewConfig);
    expect(gitMocks.pullRepo).not.toHaveBeenCalled();
    expect(reportsMocks.withKnowledgeWorktree).not.toHaveBeenCalled();
  });

  it('edits inside the knowledge worktree in single-repo mode', async () => {
    const worktreeConfig = config('self', '/worktree/.teamai');
    reportsMocks.withKnowledgeWorktree.mockImplementation(
      async (_config: LocalConfig, body: (wt: LocalConfig) => Promise<void>) => body(worktreeConfig),
    );
    const fn = vi.fn().mockResolvedValue(undefined);

    await runManifestEdit(config('self', '/business/.teamai'), 'Projects', fn);

    expect(fn).toHaveBeenCalledWith('/worktree/.teamai', worktreeConfig);
  });

  it('reports a worktree failure under the given label', async () => {
    reportsMocks.withKnowledgeWorktree.mockRejectedValue(new Error('boom'));

    await runManifestEdit(config('self', '/business/.teamai'), 'Projects', vi.fn());

    expect(logMocks.error).toHaveBeenCalledWith('Projects update failed: boom');
    expect(process.exitCode).toBe(1);
  });

  it('reports an empty repo as is', async () => {
    reportsMocks.withKnowledgeWorktree.mockRejectedValue(new reportsMocks.EmptyRepoError('Repository is empty'));

    await runManifestEdit(config('self', '/business/.teamai'), 'Roles', vi.fn());

    expect(logMocks.error).toHaveBeenCalledWith('Repository is empty');
    expect(process.exitCode).toBe(1);
  });
});

describe('pushManifestChange', () => {
  const localConfig = config('self', '/team-repo');
  const teamConfig = {
    team: 'test',
    description: '',
    repo: 'https://github.com/team/repo.git',
    provider: 'github',
    reviewers: [],
  } as unknown as TeamaiConfig;
  const change = {
    repoPath: '/team-repo',
    teamConfig,
    localConfig,
    commitMsg: '[teamai] Add project "checkout"',
    prDescription: 'Add project "checkout"',
  };

  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    process.exitCode = 0;
  });

  // The manifest is already written locally at this point, so a push that never
  // opened the PR is the one failure a caller must not read as done.
  it('reports a push that never reached a PR', async () => {
    gitMocks.pushRepoBranch.mockRejectedValue(new Error('remote rejected'));

    await pushManifestChange(change);

    expect(logMocks.error).toHaveBeenCalledWith('Push failed: remote rejected');
    expect(process.exitCode).toBe(1);
  });

  it('stays 0 when the branch and the PR go through', async () => {
    gitMocks.pushRepoBranch.mockResolvedValue(true);

    await pushManifestChange(change);

    expect(prMocks.createPrWithFallback).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  // The branch carries the manifest edit, but nothing reviews it: the change is
  // not delivered, and the caller has to see that.
  it('reports a branch that was pushed but never reached a PR', async () => {
    prMocks.createPrWithFallback.mockResolvedValueOnce(null);

    await pushManifestChange(change);

    expect(process.exitCode).toBe(1);
  });

  // A `git` provider refuses createPullRequest for generic hosts, so null there
  // is the configured answer, not a failure.
  it('stays 0 when the provider opens no pull request at all', async () => {
    prMocks.providerOpensPullRequests.mockReturnValueOnce(false);
    prMocks.createPrWithFallback.mockResolvedValueOnce(null);

    await pushManifestChange(change);

    expect(process.exitCode).toBe(0);
  });
});
