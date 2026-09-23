import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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
import { acquireLock } from '../update.js';
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
      hookToolPaths: teamConfig.toolPaths,
      baseDir: homeDir,
    };
    vi.mocked(resolveDoctorContext).mockResolvedValue(ctx);
    vi.mocked(buildChecks).mockResolvedValue([]);
    // clearAllMocks resets calls, not implementations, so a test that makes the
    // lock contended would otherwise leak into the next one.
    vi.mocked(acquireLock).mockResolvedValue(true);
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

  /** The registry's queue check, as buildChecks builds it. */
  function queueCheck(check: Check['check']): Check {
    return {
      name: 'Contributed learnings are published',
      source: 'local',
      reportedByPull: 'pending-learnings',
      check,
      fix: 'Run `teamai pull` to publish them.',
    };
  }

  it('skips a check the pull reported itself on this run', async () => {
    // A queue entry the pull will fail to publish: remote is a bare path that
    // is not a repo, so publishQueuedLearnings comes back with remaining > 0
    // and pullForScope warns, with the push error attached.
    await fse.outputFile(
      path.join(tempDir, 'pending-learnings', 'stuck.md'),
      '---\ntitle: stuck\n---\nbody\n',
    );
    const check = vi.fn().mockResolvedValue(false);
    vi.mocked(buildChecks).mockResolvedValue([queueCheck(check)]);

    await pull({ force: true });

    expect(printedOutput()).toContain('not published');
    // Repeating it would tell the member to run the pull they just ran, in
    // weaker words: the warning carries the push error, the fix cannot.
    expect(check).not.toHaveBeenCalled();
    expect(printedOutput()).not.toContain('Contributed learnings are published');
  });

  it('still reports a flagged check when the pull said nothing about it', async () => {
    // Nothing queued, so pullForScope never warns. A scope that aborts before
    // the publish step lands here too. The flag must not silence the check on
    // a run where the pull has not spoken \u2014 nobody else would.
    const check = vi.fn().mockResolvedValue(false);
    vi.mocked(buildChecks).mockResolvedValue([queueCheck(check)]);

    await pull({ force: true });

    expect(check).toHaveBeenCalled();
    expect(printedOutput()).toContain('Contributed learnings are published');
  });

  it('bounds building the registry, not only running it', async () => {
    // buildChecks is where the I/O is: the delivery checks stat every desired
    // skill for every tool while the registry is built. A build that never
    // settles must still end the pull, and say so rather than go quiet.
    // Real timers, because faking them stalls the pull's own filesystem work.
    // This costs one budget's wall clock, which is why there is only one.
    vi.mocked(buildChecks).mockImplementation(() => new Promise(() => {}));

    await expect(pull({ force: true })).resolves.toBeUndefined();

    expect(printedOutput()).toContain('Post-pull checks did not run');
    // The sync itself still happened.
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'kept-skill'))).toBe(true);
  }, 20_000);

  it('says nothing extra when the registry cannot be built at all', async () => {
    vi.mocked(buildChecks).mockRejectedValue(new Error('registry exploded'));

    await expect(pull({ force: true })).resolves.toBeUndefined();

    expect(printedOutput()).toContain('Post-pull checks did not run');
  });

  it('runs no checks when another process holds a scope lock', async () => {
    // A contended scope is dropped from every stage that reads the shared clone,
    // because the other process may have it on a transient branch. The checks
    // resolve their own context from that same clone, so running them here is
    // how a diagnostic invents a failure about someone else's work in progress.
    vi.mocked(acquireLock).mockResolvedValue(false);
    vi.mocked(buildChecks).mockResolvedValue([
      { name: 'Team repo exists locally', source: 'local', check: async () => false },
    ]);

    await pull({ force: true });

    expect(buildChecks).not.toHaveBeenCalled();
    expect(printedOutput()).not.toContain('Team repo exists locally');
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

  it('does not count an informational failure toward "check(s) failed", but still reports it', async () => {
    // A stray legacy env block is real leftover state worth mentioning, but
    // it is not a sign that anything this pull just delivered is broken —
    // the "N check(s) failed" banner must not fire on its account alone
    // (#693 review round 6).
    vi.mocked(buildChecks).mockResolvedValue([
      { name: 'Team repo exists locally', source: 'local', check: async () => true },
      {
        name: 'No stale env blocks left behind',
        source: 'local',
        informational: true,
        check: async () => false,
        fix: '~/.bashrc still carries a teamai env block for this scope from an earlier install',
      },
    ]);

    await pull({ force: true });

    const output = printedOutput();
    expect(output).not.toContain('check(s) failed');
    expect(output).toContain('No stale env blocks left behind');
    expect(output).toContain('~/.bashrc still carries a teamai env block');
  });

  it('counts a blocking failure but not an informational one alongside it', async () => {
    vi.mocked(buildChecks).mockResolvedValue([
      {
        name: 'teamai hooks in claude settings',
        source: 'local',
        check: async () => false,
        fix: 'Run `teamai hooks inject` to inject/update hooks',
      },
      {
        name: 'No stale env blocks left behind',
        source: 'local',
        informational: true,
        check: async () => false,
        fix: 'stray block',
      },
    ]);

    await pull({ force: true });

    const output = printedOutput();
    expect(output).toContain('Pull finished, but 1 check(s) failed');
    expect(output).toContain('teamai hooks in claude settings');
    expect(output).toContain('No stale env blocks left behind');
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
