import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies
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

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI resources',
        resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'] },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
    const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
      manifest.roles.find((role: { id: string }) => role.id === id),
    );
    const dedupe = (values: string[]) => [...new Set(values)];
    return {
      knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
      skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
      learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
    };
  }),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope, saveStateForScope } from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('pull skip-sync when repo HEAD unchanged', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-skip-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
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

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('should skip sync when HEAD rev matches lastPullRev', async () => {
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced at abc1234, skipping'),
    );
    // State should NOT be re-saved (no sync happened)
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('should do full sync when HEAD rev differs from lastPullRev', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('def5678');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should have saved state with new rev
    expect(saveStateForScope).toHaveBeenCalled();
    const savedState = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(savedState.lastPullRev).toBe('def5678');
  });

  it('should do full sync when lastPullRev is null (first pull)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: null,
      lastPullRev: null,
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should proceed with sync (not skip)
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('should do full sync when --force is set even if rev matches', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# rule');

    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({ force: true });

    // Should proceed with full sync despite matching rev
    expect(saveStateForScope).toHaveBeenCalled();
  });

  it('should not skip sync in dryRun mode even if rev matches', async () => {
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({ dryRun: true });

    // dryRun should show what would happen, not skip
    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
  });

  it('should proceed with full sync when getHeadRev fails', async () => {
    vi.mocked(getHeadRev).mockRejectedValue(new Error('not a git repo'));
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // Should fall through to full sync
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Rev check failed'),
    );
  });
});
