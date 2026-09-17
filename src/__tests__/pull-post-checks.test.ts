import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    fail: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(),
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [{
      id: 'dev',
      name: 'Dev',
      description: '',
      resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [] },
    }],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({
    knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [],
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

// The registry itself is exercised in doctor.test.ts. Here the subject is the
// wiring: which checks pull runs, and what it prints. runChecks stays real so
// the test proves a provider check is never *invoked*, not merely not printed.
vi.mock('../doctor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../doctor.js')>(),
  resolveDoctorContext: vi.fn(),
  buildChecks: vi.fn(),
}));

import { detectProjectConfig, loadLocalConfigForScope, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check, type DoctorContext } from '../doctor.js';
import { log } from '../utils/logger.js';
import { pull } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/** Every line pull printed, in order, as one string. */
function printedOutput(): string {
  const calls = [
    ...vi.mocked(log.warn).mock.calls,
    ...vi.mocked(log.info).mock.calls,
    ...vi.mocked(log.dim).mock.calls,
    ...vi.mocked(log.success).mock.calls,
  ];
  return calls.map((c) => String(c[0])).join('\n');
}

describe('checks at the end of an interactive pull', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let ctx: DoctorContext;

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-checks-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'kept-skill'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'common', 'kept-skill', 'SKILL.md'),
      '---\nname: kept-skill\ndescription: kept\n---\n',
    );
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'dev',
      additionalRoles: [],
    };
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);

    ctx = {
      localConfig,
      teamConfig,
      toolPaths: teamConfig.toolPaths,
      baseDir: homeDir,
    };
    vi.mocked(resolveDoctorContext).mockResolvedValue(ctx);
    vi.mocked(buildChecks).mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('prints each failing check with its fix', async () => {
    vi.mocked(buildChecks).mockResolvedValue([
      { name: 'Team repo exists locally', source: 'local', check: async () => true },
      {
        name: 'teamai hooks in claude settings',
        source: 'local',
        check: async () => false,
        fix: 'Run `teamai hooks inject` to inject/update hooks',
      },
    ]);

    await pull({ force: true });

    const output = printedOutput();
    expect(output).toContain('teamai hooks in claude settings');
    expect(output).toContain('Run `teamai hooks inject` to inject/update hooks');
    // Passing checks stay out of the way: pull is not a diagnostics report.
    expect(output).not.toContain('Team repo exists locally');
  });

  it('prints nothing when every check passes', async () => {
    vi.mocked(buildChecks).mockResolvedValue([
      { name: 'Team repo exists locally', source: 'local', check: async () => true },
    ]);

    await pull({ force: true });

    expect(printedOutput()).not.toContain('Team repo exists locally');
  });

  it('never probes the provider: those checks are not even run', async () => {
    const providerCheck = vi.fn().mockResolvedValue(false);
    vi.mocked(buildChecks).mockResolvedValue([
      {
        name: 'gh CLI is authenticated',
        source: 'provider',
        check: providerCheck,
        fix: 'Run `gh auth login` to authenticate',
      },
    ]);

    await pull({ force: true });

    expect(providerCheck).not.toHaveBeenCalled();
    expect(printedOutput()).not.toContain('gh CLI is authenticated');
  });

  it('runs no checks on the silent hook path', async () => {
    await pull({ force: true, silent: true });

    expect(resolveDoctorContext).not.toHaveBeenCalled();
    expect(buildChecks).not.toHaveBeenCalled();
  });

  it('runs no checks on a dry run', async () => {
    await pull({ dryRun: true });

    expect(resolveDoctorContext).not.toHaveBeenCalled();
    expect(buildChecks).not.toHaveBeenCalled();
  });

  it('a check that throws does not fail the pull', async () => {
    const failing: Check = {
      name: 'explodes',
      source: 'local',
      check: async () => { throw new Error('boom'); },
    };
    vi.mocked(buildChecks).mockResolvedValue([failing]);

    await expect(pull({ force: true })).resolves.toBeUndefined();
    // The sync itself still happened.
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'kept-skill'))).toBe(true);
  });
});
