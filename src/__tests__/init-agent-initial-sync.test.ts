import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', () => ({
  loadTeamConfig: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
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

import { seedEnabledAgentDirs } from '../known-agents.js';
import { pullForScope } from '../pull.js';
import { loadTeamConfig } from '../config.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('init --agent: directory seeding + initial sync (#574/#585)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-init-agent-sync-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'onboarding.md'), '# Onboarding Rule\n');

    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('reproduces the fresh-clone scenario from #574: no manual mkdir, no directories exist before init', async () => {
    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);
  });

  it('seeding then syncing writes real rule files into a freshly-declared --agent tool, with no manual mkdir', async () => {
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
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
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['claude'],
    };

    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);

    // Step 1: this is what init/initHttp now call — seed the declared agent's dir.
    const seeded = await seedEnabledAgentDirs(localConfig, teamConfig);
    expect(seeded).toEqual(['claude']);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills'))).toBe(true);

    // Step 2: this is the "initial sync" half — pullForScope actually writes files
    // now that the dir exists, instead of leaving it empty until a hook fires.
    await pullForScope(localConfig, {});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/onboarding.md'))).toBe(true);
  });

  it('init without --agent (enabledAgents unset) creates nothing — regression guard from #585 acceptance criteria', async () => {
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
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
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      // enabledAgents deliberately omitted — no --agent was passed.
    };

    const seeded = await seedEnabledAgentDirs(localConfig, teamConfig);

    expect(seeded).toEqual([]);
    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);
  });
});
