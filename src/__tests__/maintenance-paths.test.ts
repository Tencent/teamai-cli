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

const PROJECT_ROOT = path.resolve('/workspace/project');
const USER_HOME = path.resolve('/home/alice');

function makeConfig(kind: 'git' | 'self'): LocalConfig {
  // The roots are resolved rather than written as POSIX literals, so the expectations below hold on a Windows runner,
  // where `path.resolve('/workspace/project')` carries the drive of the current directory.
  const projectRoot = PROJECT_ROOT;
  const localPath = kind === 'self'
    ? path.join(projectRoot, '.teamai')
    : path.join(USER_HOME, '.teamai', 'team-repo');
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
      repoPath: path.join(PROJECT_ROOT, '.teamai'),
      votesDir: path.join(
        PROJECT_ROOT,
        '.teamai',
        REPORTS_WORKTREE_DIRNAME,
        'votes',
      ),
      learningsWriteDir: path.join(PROJECT_ROOT, '.teamai', LEARNINGS_WORKTREE_DIRNAME, 'learnings'),
      learningsReadDirs: expect.arrayContaining([path.join(PROJECT_ROOT, '.teamai', 'learnings')]),
    });
    expect(refreshReportsWorktree).toHaveBeenCalledOnce();
    expect(refreshReportsWorktree).toHaveBeenCalledWith(config, { pushIfCreated: false });
  });

  it('reads git-kind votes from the sibling reports worktree', async () => {
    const config = makeConfig('git');

    await expect(resolveMaintenancePaths(config)).resolves.toEqual({
      repoPath: path.join(USER_HOME, '.teamai', 'team-repo'),
      votesDir: path.join(USER_HOME, '.teamai', REPORTS_WORKTREE_DIRNAME, 'votes'),
      learningsWriteDir: path.join(USER_HOME, '.teamai', LEARNINGS_WORKTREE_DIRNAME, 'learnings'),
      learningsReadDirs: expect.arrayContaining([path.join(USER_HOME, '.teamai', 'team-repo', 'learnings')]),
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
