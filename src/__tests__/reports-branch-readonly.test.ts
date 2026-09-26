import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import type { LocalConfig } from '../types.js';

const mocks = vi.hoisted(() => ({
  repoGit: {
    listRemote: vi.fn(),
    raw: vi.fn(),
    branchLocal: vi.fn(),
    revparse: vi.fn(),
  },
  worktreeGit: {
    raw: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    status: vi.fn(),
    revparse: vi.fn(),
    fetch: vi.fn(),
  },
  isGitRepo: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  createGit: vi.fn((cwd: string) => (
    cwd.endsWith(`${path.sep}reports-wt`) ? mocks.worktreeGit : mocks.repoGit
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
    realpath: vi.fn(async (p: string) => p),
  },
}));

/** The existing reports-wt is a checkout of the business repo: both sides name its git dir. */
function mockCheckoutOfBusinessRepo(): void {
  const answer = async (args: string[]) => (args.includes('--git-common-dir') ? '/workspace/project/.git' : 'true');
  mocks.worktreeGit.revparse.mockImplementation(answer);
  mocks.repoGit.revparse.mockImplementation(answer);
}

vi.mock('../update.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

import { acquireLock, releaseLock } from '../update.js';
import { commitAndPushReports, ensureReportsWorktree, readableReportsWorktree, refreshReportsWorktree, updateReports } from '../utils/reports-branch.js';
import { ForeignCheckoutError } from '../utils/branch-worktree.js';

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

const WT = path.join('/workspace/project/.teamai', 'reports-wt');

describe('ensureReportsWorktree read-only cold start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockResolvedValue(false);
    mocks.repoGit.listRemote.mockResolvedValue('');
    mocks.repoGit.raw.mockResolvedValue('');
    mocks.repoGit.branchLocal.mockResolvedValue({ all: ['main'] });
    mocks.worktreeGit.raw.mockResolvedValue('');
    mocks.worktreeGit.add.mockResolvedValue(undefined);
    mocks.worktreeGit.commit.mockResolvedValue(undefined);
    mocks.worktreeGit.push.mockResolvedValue(undefined);
  });

  it('does not publish a new reports branch when pushIfCreated is false', async () => {
    await expect(
      ensureReportsWorktree(config, { pushIfCreated: false }),
    ).resolves.toBe(WT);

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

  it('reuses an unpublished local reports branch instead of recreating the orphan branch', async () => {
    mocks.repoGit.branchLocal.mockResolvedValue({ all: ['main', 'teamai-reports'] });

    await expect(
      ensureReportsWorktree(config, { pushIfCreated: false }),
    ).resolves.toBe(WT);

    expect(mocks.repoGit.raw).toHaveBeenCalledWith(['worktree', 'add', WT, 'teamai-reports']);
    const orphanAdds = mocks.repoGit.raw.mock.calls.filter(([args]) => (args as string[]).includes('--orphan'));
    expect(orphanAdds).toEqual([]);
    expect(mocks.worktreeGit.commit).not.toHaveBeenCalled();
    expect(mocks.worktreeGit.push).not.toHaveBeenCalled();
  });

  it('lets a writer publish a reused local reports branch', async () => {
    mocks.repoGit.branchLocal.mockResolvedValue({ all: ['main', 'teamai-reports'] });

    await ensureReportsWorktree(config);

    expect(mocks.worktreeGit.push).toHaveBeenCalledWith(['-u', 'origin', 'teamai-reports']);
  });
});

/**
 * `diff --cached --name-only -z -- <files>` lists `staged`, what the publish commits.
 * Any other git call is `rev-list --count origin/<branch>..HEAD`, which the publish
 * checks before reporting success: '0' is "nothing left to deliver".
 */
function stageInWorktree(staged: string[]): void {
  mocks.worktreeGit.raw.mockImplementation(async (args: string[]) =>
    args.includes('diff') ? staged.map((f) => `${f}\0`).join('') : '0');
}

describe('commitAndPushReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.worktreeGit.add.mockResolvedValue(undefined);
    mocks.worktreeGit.commit.mockResolvedValue(undefined);
    mocks.worktreeGit.push.mockResolvedValue(undefined);
    mockCheckoutOfBusinessRepo();
    stageInWorktree(['members/alice.yaml']);
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

  it('pushes an unchanged report retry without making an empty commit', async () => {
    stageInWorktree([]);
    expect(await commitAndPushReports(config, 'retry stats', ['stats/alice.yaml'], { pushIfUnchanged: true })).toBe(true);
    expect(mocks.worktreeGit.commit).not.toHaveBeenCalled();
    expect(mocks.worktreeGit.push).toHaveBeenCalledWith(['origin', 'teamai-reports']);
    expect(releaseLock).toHaveBeenCalled();
  });

  it('preserves the default no-op when no changes are staged', async () => {
    stageInWorktree([]);
    expect(await commitAndPushReports(config, 'unchanged member', ['members/'])).toBe(false);
    expect(mocks.worktreeGit.push).not.toHaveBeenCalled();
  });
});

describe('refreshReportsWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitRepo.mockResolvedValue(true);
    mockCheckoutOfBusinessRepo();
    mocks.worktreeGit.fetch.mockResolvedValue(undefined);
  });

  it('reads the local copy without syncing while a report write holds the lock', async () => {
    vi.mocked(acquireLock).mockResolvedValue(false);

    await refreshReportsWorktree(config, { pushIfCreated: false });

    expect(mocks.worktreeGit.fetch).not.toHaveBeenCalled();
    expect(mocks.worktreeGit.raw).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('leaves a missing checkout to the write that holds the lock', async () => {
    // Every checkout of a self-mode repo shares this path (#808): the holder may
    // be creating it right now.
    vi.mocked(acquireLock).mockResolvedValue(false);
    mocks.isGitRepo.mockResolvedValue(false);

    await refreshReportsWorktree(config, { pushIfCreated: false });

    expect(mocks.isGitRepo).not.toHaveBeenCalled();
    expect(mocks.repoGit.raw).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('keeps the local copy when fetch fails (offline)', async () => {
    vi.mocked(acquireLock).mockResolvedValue(true);
    mocks.worktreeGit.fetch.mockRejectedValue(new Error('offline'));

    await refreshReportsWorktree(config, { pushIfCreated: false });

    expect(mocks.worktreeGit.raw).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

describe('readableReportsWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckoutOfBusinessRepo();
    mocks.worktreeGit.fetch.mockResolvedValue(undefined);
  });

  it('returns the local copy without ensuring it while a write holds the lock', async () => {
    // members, projects members, digest and pull read through here (#808): the
    // holder may be creating the checkout, so a reader must not add or remove it.
    vi.mocked(acquireLock).mockResolvedValue(false);
    mocks.isGitRepo.mockResolvedValue(false);

    await expect(readableReportsWorktree(config)).resolves.toBe(WT);

    expect(mocks.repoGit.raw).not.toHaveBeenCalled();
    expect(mocks.repoGit.listRemote).not.toHaveBeenCalled();
  });

  it("refuses another repository's checkout without ensuring it while a write holds the lock", async () => {
    // After a git<->self switch the checkout at the shared path may be the
    // other install's: reading it would show that repository's roster and votes.
    vi.mocked(acquireLock).mockResolvedValue(false);
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.worktreeGit.revparse.mockImplementation(async (args: string[]) => (
      args.includes('--git-common-dir') ? '/workspace/other-team/.git' : 'true'
    ));

    await expect(readableReportsWorktree(config)).rejects.toBeInstanceOf(ForeignCheckoutError);

    expect(mocks.repoGit.raw).not.toHaveBeenCalled();
    expect(mocks.repoGit.listRemote).not.toHaveBeenCalled();
    expect(mocks.worktreeGit.raw).not.toHaveBeenCalled();
  });

  it('refreshes the checkout, publishing nothing, when the lock is free', async () => {
    vi.mocked(acquireLock).mockResolvedValue(true);
    mocks.isGitRepo.mockResolvedValue(true);
    // A clean checkout, level with origin: the refresh completes.
    mocks.worktreeGit.status.mockResolvedValue({ staged: [], renamed: [], conflicted: [], isClean: () => true });
    mocks.worktreeGit.raw.mockResolvedValue('0');

    await expect(readableReportsWorktree(config)).resolves.toBe(WT);

    expect(mocks.worktreeGit.fetch).toHaveBeenCalled();
    expect(mocks.worktreeGit.push).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

describe('updateReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acquireLock).mockResolvedValue(false);
  });

  it('does not run the write callback when another reports write holds the lock', async () => {
    const write = vi.fn();

    expect(await updateReports(config, write)).toBe(false);

    expect(write).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });
});
