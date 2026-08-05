import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Issue #73 keeps project scope isolated by default. These tests also cover the
// explicit safe-resource inheritance path without composing control-plane data.

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
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
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// Stub the cross-team source pull so we can assert which scope it runs against
// without doing any real git work.
vi.mock('../source.js', () => ({
  pullSources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue([]),
}));

vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));

vi.mock('../team-push.js', () => ({
  reportUsageToTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({ knowledge: [], skills: [], learnings: [] })),
}));

import { pull } from '../pull.js';
import {
  loadLocalConfigForScope,
  loadTeamConfig,
  detectProjectConfig,
  loadStateForScope,
  saveStateForScope,
} from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { pullSources } from '../source.js';
import { log } from '../utils/logger.js';
import { reconcileTeamHooksForConfig } from '../hooks.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { reportUsageToTeam } from '../team-push.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const SKIP_MSG = 'project scope detected, skipped user scope';

describe('pull scope isolation (issue #73)', () => {
  let tmpDir: string;
  let homeDir: string;
  let userRepoPath: string;
  let projectRoot: string;
  let projectRepoPath: string;
  let teamConfig: TeamaiConfig;
  let userConfig: LocalConfig;
  let projectConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-scope-iso-'));
    homeDir = path.join(tmpDir, 'home');
    userRepoPath = path.join(tmpDir, 'user-repo');
    projectRoot = path.join(tmpDir, 'proj');
    projectRepoPath = path.join(projectRoot, '.teamai', 'team-repo');

    for (const repo of [userRepoPath, projectRepoPath]) {
      await fse.ensureDir(path.join(repo, 'skills'));
      await fse.ensureDir(path.join(repo, 'rules'));
    }
    await fse.ensureDir(path.join(userRepoPath, 'skills', 'org-safe-review'));
    await fse.writeFile(
      path.join(userRepoPath, 'skills', 'org-safe-review', 'SKILL.md'),
      '---\nname: org-safe-review\ndescription: safe review workflow\n---\n',
    );
    await fse.ensureDir(path.join(userRepoPath, 'env'));
    await fse.writeFile(
      path.join(userRepoPath, 'env', 'env.yaml'),
      'variables:\n  - key: USER_SECRET\n    value: must-not-inherit\n',
    );
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    userConfig = {
      repo: { localPath: userRepoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'userscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    projectConfig = {
      repo: { localPath: projectRepoPath, remote: 'https://git.woa.com/test/proj.git' },
      username: 'projscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
    };

    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockImplementation(async (scope) => ({
      lastPull: scope === 'project' ? '2026-04-01' : null,
      lastPullRev: scope === 'project' ? 'abc1234' : null,
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('project mode: skips user scope entirely and pulls source against project', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await pull({ silent: true });

    // User scope must never be loaded / pulled.
    expect(loadLocalConfigForScope).not.toHaveBeenCalled();
    // The skip notice is printed.
    expect(log.info).toHaveBeenCalledWith(SKIP_MSG);
    // Source pull still runs (decision 1), against the project config.
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({
      scope: 'project',
      projectRoot,
    });
  });

  it('project mode: inherits user resources only when explicitly enabled', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await pull({ silent: true });

    expect(loadLocalConfigForScope).toHaveBeenCalledWith('user');
    expect(loadStateForScope).toHaveBeenCalledWith('user', undefined);
    expect(loadStateForScope).toHaveBeenCalledWith('project', projectRoot);
    expect(log.info).toHaveBeenCalledWith(
      'project scope detected, inheriting user-scope resources and knowledge',
    );
    expect(log.info).not.toHaveBeenCalledWith(SKIP_MSG);
    expect(await fse.pathExists(
      path.join(homeDir, '.claude', 'skills', 'org-safe-review', 'SKILL.md'),
    )).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.teamai', 'env.sh'))).toBe(false);
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        lastPullRev: null,
        lastInheritedPullRev: 'abc1234',
      }),
      'user',
      undefined,
    );
    expect(reconcileTeamHooksForConfig).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'user' }),
      expect.anything(),
    );
    expect(reconcileMcpForConfig).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'user' }),
    );
    expect(reportUsageToTeam).not.toHaveBeenCalledWith(
      userRepoPath,
      expect.anything(),
      expect.anything(),
    );
    // External sources stay bound to the active project scope.
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({ scope: 'project' });
  });

  it('project mode: warns but continues when inherited user scope is unavailable', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(null);

    await pull({ silent: true });

    expect(log.warn).toHaveBeenCalledWith(
      'user-scope inheritance is enabled, but user scope is not initialized',
    );
    expect(loadStateForScope).toHaveBeenCalledWith('project', projectRoot);
  });

  it('user mode: pulls user scope and routes source against user (no skip notice)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await pull({ silent: true });

    expect(loadLocalConfigForScope).toHaveBeenCalledWith('user');
    expect(log.info).not.toHaveBeenCalledWith(SKIP_MSG);
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({ scope: 'user' });
  });
});
