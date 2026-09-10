import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalConfig } from '../types.js';

const mocks = vi.hoisted(() => ({
  repoGit: {
    listRemote: vi.fn(),
    raw: vi.fn(),
  },
  worktreeGit: {
    raw: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    status: vi.fn(),
  },
  isGitRepo: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  createGit: vi.fn((cwd: string) => (
    cwd.endsWith('/reports-wt') ? mocks.worktreeGit : mocks.repoGit
  )),
  isGitRepo: mocks.isGitRepo,
  getDefaultBranch: vi.fn(),
  hasCommits: vi.fn(),
  isDedicatedRepoRoot: vi.fn().mockResolvedValue(true),
  commitSkippingHooks: (git: { commit: (...args: unknown[]) => unknown }, message: string) =>
    git.commit(message, { '--no-verify': null }),
}));

vi.mock('../utils/fs.js', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn().mockResolvedValue(false),
  writeFile: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue(['.git']),
    remove: vi.fn(),
  },
}));

vi.mock('../update.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

import { acquireLock, releaseLock } from '../update.js';
import { commitAndPushReports, ensureReportsWorktree } from '../utils/reports-branch.js';

const config: LocalConfig = {
  repo: {
    localPath: '/workspace/project/.teamai',
    remote: 'https://example.com/team.git',
    kind: 'self',
    businessRepoRoot: '/workspace/project',
  },
  username: 'alice',
  scope: 'project',
  projectRoot: '/workspace/project',
  additionalRoles: [],
};

describe('ensureReportsWorktree read-only cold start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockResolvedValue(false);
    mocks.repoGit.listRemote.mockResolvedValue('');
    mocks.repoGit.raw.mockResolvedValue('');
    mocks.worktreeGit.raw.mockResolvedValue('');
    mocks.worktreeGit.add.mockResolvedValue(undefined);
    mocks.worktreeGit.commit.mockResolvedValue(undefined);
    mocks.worktreeGit.push.mockResolvedValue(undefined);
  });

  it('does not publish a new reports branch when pushIfCreated is false', async () => {
    await expect(
      ensureReportsWorktree(config, { pushIfCreated: false }),
    ).resolves.toBe('/workspace/project/.teamai/reports-wt');

    expect(mocks.worktreeGit.push).not.toHaveBeenCalled();
  });

  it('preserves the writer default of publishing a new reports branch', async () => {
    await ensureReportsWorktree(config);

    expect(mocks.worktreeGit.push).toHaveBeenCalledWith([
      '-u',
      'origin',
      'teamai-reports',
    ]);
  });

  it('skips git hooks when initializing the reports orphan branch', async () => {
    await ensureReportsWorktree(config, { pushIfCreated: false });

    expect(mocks.worktreeGit.commit).toHaveBeenCalledWith(
      '[teamai] Initialize reports branch',
      { '--no-verify': null },
    );
  });
});

describe('commitAndPushReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.worktreeGit.add.mockResolvedValue(undefined);
    mocks.worktreeGit.commit.mockResolvedValue(undefined);
    mocks.worktreeGit.push.mockResolvedValue(undefined);
    mocks.worktreeGit.status.mockResolvedValue({ staged: ['members/alice.yaml'] });
    vi.mocked(acquireLock).mockResolvedValue(true);
    vi.mocked(releaseLock).mockResolvedValue(undefined);
  });

  it('skips git hooks on the isolated reports worktree commit', async () => {
    const pushed = await commitAndPushReports(config, '[teamai] Register member: alice', ['members/']);

    expect(pushed).toBe(true);
    expect(mocks.worktreeGit.commit).toHaveBeenCalledWith(
      '[teamai] Register member: alice',
      { '--no-verify': null },
    );
  });
});
