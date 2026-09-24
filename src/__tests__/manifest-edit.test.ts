import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportsMocks = vi.hoisted(() => {
  class EmptyRepoError extends Error {}
  return { withKnowledgeWorktree: vi.fn(), EmptyRepoError };
});
vi.mock('../utils/reports-branch.js', () => reportsMocks);

const logMocks = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ log: logMocks, spinner: vi.fn() }));

import { runManifestEdit } from '../manifest-edit.js';
import type { LocalConfig } from '../types.js';

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

  it('edits the team repo clone directly outside single-repo mode', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const localConfig = config(undefined, '/team-repo');

    await runManifestEdit(localConfig, 'Projects', fn);

    expect(fn).toHaveBeenCalledWith('/team-repo', localConfig);
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
  });

  it('reports an empty repo as is', async () => {
    reportsMocks.withKnowledgeWorktree.mockRejectedValue(new reportsMocks.EmptyRepoError('Repository is empty'));

    await runManifestEdit(config('self', '/business/.teamai'), 'Roles', vi.fn());

    expect(logMocks.error).toHaveBeenCalledWith('Repository is empty');
  });
});
