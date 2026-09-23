import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
  isDedicatedRepoRoot: vi.fn().mockResolvedValue(true),
}));

const reportsMocks = vi.hoisted(() => ({
  ensureReportsWorktree: vi.fn(),
  refreshReportsWorktree: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/reports-branch.js', () => ({
  ensureReportsWorktree: (...args: unknown[]) => reportsMocks.ensureReportsWorktree(...args),
  refreshReportsWorktree: (...args: unknown[]) => reportsMocks.refreshReportsWorktree(...args),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { projectsMembers } from '../projects-cmd.js';
import { autoDetectInit } from '../config.js';

describe('projectsMembers: inherited member root (#735)', () => {
  let tmpDir: string;
  let cloneDir: string;
  let reportsDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-test-'));
    cloneDir = path.join(tmpDir, 'team-repo');
    reportsDir = path.join(tmpDir, 'reports-wt');
    await fse.ensureDir(path.join(cloneDir, 'members'));
    await fse.ensureDir(path.join(reportsDir, 'members'));
    // The projects manifest is knowledge on the default-branch clone.
    await fse.ensureDir(path.join(cloneDir, 'manifest'));
    await fse.writeFile(
      path.join(cloneDir, 'manifest', 'projects.yaml'),
      YAML.stringify({ version: 1, projects: [{ id: 'checkout', resources: {} }] }),
    );
    reportsMocks.ensureReportsWorktree.mockReset().mockResolvedValue(reportsDir);
    reportsMocks.refreshReportsWorktree.mockReset().mockResolvedValue(undefined);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(autoDetectInit).mockResolvedValue({
      localConfig: {
        repo: { localPath: cloneDir, remote: 'https://git.woa.com/team/repo.git' },
        username: 'alice',
        updatePolicy: 'auto',
        additionalRoles: [],
        scope: 'user',
      },
      teamConfig: {
        team: 'test',
        description: '',
        repo: 'https://git.woa.com/team/repo.git',
        provider: 'tgit' as const,
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: {},
      },
    });
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await fse.remove(tmpDir);
  });

  it('finds project members registered before the reports switch', async () => {
    await fse.writeFile(
      path.join(cloneDir, 'members', 'carol.yaml'),
      YAML.stringify({ username: 'carol', registeredAt: '2025-01-01T00:00:00.000Z', projects: ['checkout'] }),
    );

    await projectsMembers('checkout', {});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Members of project "checkout" (1)');
    expect(allOutput).toContain('carol');
  });

  it('lists the union of inherited and reports-branch members, branch copy winning', async () => {
    await fse.writeFile(
      path.join(cloneDir, 'members', 'carol.yaml'),
      YAML.stringify({ username: 'carol', registeredAt: '2025-01-01T00:00:00.000Z', projects: ['checkout'] }),
    );
    // carol also re-registered on the reports branch but left the project.
    await fse.writeFile(
      path.join(reportsDir, 'members', 'carol.yaml'),
      YAML.stringify({ username: 'carol', registeredAt: '2025-06-01T00:00:00.000Z' }),
    );
    await fse.writeFile(
      path.join(reportsDir, 'members', 'dan.yaml'),
      YAML.stringify({ username: 'dan', registeredAt: '2025-06-02T00:00:00.000Z', projects: ['checkout'] }),
    );

    await projectsMembers('checkout', {});

    const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('Members of project "checkout" (1)');
    expect(allOutput).toContain('dan');
    expect(allOutput).not.toContain('carol');
  });
});
