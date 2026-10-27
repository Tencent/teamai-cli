import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalConfig } from '../types.js';
import { LEARNINGS_WORKTREE_DIRNAME, REPORTS_WORKTREE_DIRNAME } from '../types.js';
import { CheckoutLockedError, CheckoutUnavailableError, resolveMaintenancePaths } from '../maintenance/paths.js';
import { learningsBranch } from '../utils/learnings-branch.js';
import { refreshReportsWorktree } from '../utils/reports-branch.js';

vi.mock('../utils/reports-branch.js', () => ({
  refreshReportsWorktree: vi.fn(),
}));
vi.mock('../update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../update.js')>()),
  withFileLock: vi.fn(async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({ held: true as const, value: await body() })),
}));

function makeConfig(kind: 'git' | 'self'): LocalConfig {
  const projectRoot = '/workspace/project';
  const localPath = kind === 'self'
    ? path.join(projectRoot, '.teamai')
    : '/home/alice/.teamai/team-repo';
  return {
    repo: {
      localPath,
      remote: 'https://example.com/team.git',
      kind,
      ...(kind === 'self' ? { businessRepoRoot: projectRoot } : {}),
    },
    username: 'alice',
    scope: kind === 'self' ? 'project' : 'user',
    ...(kind === 'self' ? { projectRoot } : {}),
    additionalRoles: [],
  };
}

describe('resolveMaintenancePaths', () => {
  beforeEach(() => {
    vi.mocked(refreshReportsWorktree).mockReset().mockResolvedValue({ status: 'done' });
    vi.spyOn(learningsBranch, 'refresh').mockReset().mockResolvedValue({ status: 'done' });
  });

  it('reads self-mode votes from the reports worktree', async () => {
    const config = makeConfig('self');

    await expect(resolveMaintenancePaths(config)).resolves.toEqual({
      repoPath: '/workspace/project/.teamai',
      votesDir: path.join(
        '/workspace/project/.teamai',
        REPORTS_WORKTREE_DIRNAME,
        'votes',
      ),
      learningsWriteDir: path.join('/workspace/project/.teamai', LEARNINGS_WORKTREE_DIRNAME, 'learnings'),
      learningsReadDirs: expect.arrayContaining(['/workspace/project/.teamai/learnings']),
    });
    expect(refreshReportsWorktree).toHaveBeenCalledOnce();
    expect(refreshReportsWorktree).toHaveBeenCalledWith(config, { pushIfCreated: false });
  });

  it('reads git-kind votes from the sibling reports worktree', async () => {
    const config = makeConfig('git');

    await expect(resolveMaintenancePaths(config)).resolves.toEqual({
      repoPath: '/home/alice/.teamai/team-repo',
      votesDir: path.join('/home/alice/.teamai', REPORTS_WORKTREE_DIRNAME, 'votes'),
      learningsWriteDir: path.join('/home/alice/.teamai', LEARNINGS_WORKTREE_DIRNAME, 'learnings'),
      learningsReadDirs: expect.arrayContaining(['/home/alice/.teamai/team-repo/learnings']),
    });
    expect(refreshReportsWorktree).toHaveBeenCalledOnce();
    expect(refreshReportsWorktree).toHaveBeenCalledWith(config, { pushIfCreated: false });
  });

  it('stops before reading votes or touching learnings while the reports lock is taken', async () => {
    const config = makeConfig('self');
    const lockPath = '/workspace/project/.teamai/.reports-lock';
    vi.mocked(refreshReportsWorktree).mockResolvedValue({ status: 'busy', lockPath });

    const resolving = resolveMaintenancePaths(config);
    await expect(resolving).rejects.toBeInstanceOf(CheckoutLockedError);
    await expect(resolving).rejects.toThrow(`The reports checkout is locked: another teamai command may be updating it, or its lock at ${lockPath} could not be created.`);
    expect(learningsBranch.refresh).not.toHaveBeenCalled();
  });

  it('stops before reading votes or touching learnings when the reports checkout cannot be set up', async () => {
    const config = makeConfig('self');
    vi.mocked(refreshReportsWorktree).mockResolvedValue({ status: 'failed', reason: "fatal: 'teamai-reports' is already used by worktree at '/elsewhere'" });

    const resolving = resolveMaintenancePaths(config);
    await expect(resolving).rejects.toBeInstanceOf(CheckoutUnavailableError);
    await expect(resolving).rejects.toThrow("The reports checkout could not be set up: fatal: 'teamai-reports' is already used by worktree at '/elsewhere'. Nothing was changed.");
    expect(learningsBranch.refresh).not.toHaveBeenCalled();
  });
});
