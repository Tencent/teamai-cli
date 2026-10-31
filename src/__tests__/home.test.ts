import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getUserHome } from '../utils/home.js';
import { getTeamaiHome, getDataHome, getEnvBackupPath, resolveBaseDir, type LocalConfig } from '../types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function restoreEnv(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv('HOME', originalHome);
  restoreEnv('USERPROFILE', originalUserProfile);
});

describe('getUserHome', () => {
  it('prefers HOME when it is available', () => {
    process.env.HOME = '/home/alice';
    process.env.USERPROFILE = 'C:\\Users\\alice';

    expect(getUserHome()).toBe('/home/alice');
  });

  it('falls back to USERPROFILE when HOME is unavailable', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\alice';

    expect(getUserHome()).toBe('C:\\Users\\alice');
    expect(getTeamaiHome('user')).toBe(path.join('C:\\Users\\alice', '.teamai'));

    const config: LocalConfig = {
      repo: {
        localPath: 'C:\\Users\\alice\\.teamai\\team-repo',
        remote: 'git@example.com:team/repo.git',
      },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };
    expect(resolveBaseDir(config)).toBe('C:\\Users\\alice');
  });

  it('resolves user paths from USERPROFILE when HOME is unavailable (evaluated at call time)', async () => {
    // Path getters read the home dir at CALL time (issue #374 P3), so changing
    // the environment takes effect immediately — no vi.resetModules() dance the
    // old module-load constants needed.
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\alice';

    const { getTeamaiHomeDir, getUserConfigPath, getUserStatePath } = await import('../types.js');

    expect(getTeamaiHomeDir()).toBe(path.join('C:\\Users\\alice', '.teamai'));
    expect(getUserConfigPath()).toBe(
      path.join('C:\\Users\\alice', '.teamai', 'config.yaml'),
    );
    expect(getUserStatePath()).toBe(
      path.join('C:\\Users\\alice', '.teamai', 'state.json'),
    );
  });

  it('falls back to os.homedir when neither environment variable is available', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    expect(getUserHome()).toBe(os.homedir());
  });

  it('throws instead of returning a shared/relative dir when home is unresolvable', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    // os.homedir() is documented to return '' when the home cannot be resolved.
    // Falling back to os.tmpdir() (world-writable) or '' (cwd-relative) would be a
    // credential-exposure / code-execution vector, so getUserHome() must throw.
    const spy = vi.spyOn(os, 'homedir').mockReturnValue('');

    try {
      expect(() => getUserHome()).toThrow(/user home directory/);
    } finally {
      spy.mockRestore();
    }
  });

  it('resolves user-scope resource paths from USERPROFILE when HOME is unavailable', async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\alice';

    const { getApiKeyPath } = await import('../api-key.js');

    expect(getApiKeyPath()).toBe(path.join('C:\\Users\\alice', '.teamai', 'apikey'));
  });
});

describe('getDataHome (machine-data home resolver)', () => {
  // PR-1 introduces getDataHome as the single source of truth for the machine-data
  // home, consumed by every caller that used to call getTeamaiHome(scope, projectRoot)
  // directly. It is behavior-preserving: it must return exactly the legacy path in
  // every mode. This golden test is the regression guard for that contract — a later
  // phase (P1 partition) will deliberately change the project-scope expectation here.
  function makeConfig(overrides: Partial<LocalConfig>): LocalConfig {
    return {
      repo: { localPath: '/tmp/x/.teamai/team-repo', remote: 'git@example.com:t/r.git' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      ...overrides,
    } as LocalConfig;
  }

  it('equals getTeamaiHome(user) for user scope', () => {
    process.env.HOME = '/home/alice';
    const cfg = makeConfig({ scope: 'user' });
    expect(getDataHome(cfg)).toBe(getTeamaiHome('user'));
    expect(getDataHome(cfg)).toBe(path.join('/home/alice', '.teamai'));
  });

  it('equals getTeamaiHome(project, projectRoot) for project scope', () => {
    process.env.HOME = '/home/alice';
    const cfg = makeConfig({ scope: 'project', projectRoot: '/work/proj' });
    expect(getDataHome(cfg)).toBe(getTeamaiHome('project', '/work/proj'));
    expect(getDataHome(cfg)).toBe(path.join('/work/proj', '.teamai'));
  });

  it('follows scope, not repo.kind — self mode keys on its project scope', () => {
    process.env.HOME = '/home/alice';
    const cfg = makeConfig({
      scope: 'project',
      projectRoot: '/work/self-repo',
      repo: { localPath: '/work/self-repo/.teamai', remote: '', kind: 'self' },
    });
    expect(getDataHome(cfg)).toBe(path.join('/work/self-repo', '.teamai'));
  });

  it('co-locates the env backup with the data home (git + self)', () => {
    // Regression guard for the P1-2 partition flip: getEnvBackupPath must route
    // through getDataHome, so env and env.sh never diverge across a redirect.
    // (Reviewer: plaintext env backup must not stay behind in the workspace.)
    process.env.HOME = '/home/alice';
    const git = makeConfig({ scope: 'project', projectRoot: '/work/proj' });
    expect(path.dirname(getEnvBackupPath(git))).toBe(getDataHome(git));
    expect(getEnvBackupPath(git)).toBe(path.join(getDataHome(git), 'env'));

    const self = makeConfig({
      scope: 'project',
      projectRoot: '/work/self-repo',
      repo: { localPath: '/work/self-repo/.teamai', remote: '', kind: 'self' },
    });
    expect(path.dirname(getEnvBackupPath(self))).toBe(getDataHome(self));
    expect(getEnvBackupPath(self)).toBe(path.join(getDataHome(self), 'env.local'));
  });

  it('throws for a project-scope config missing projectRoot (the hazard callers must guard)', () => {
    // LocalConfigSchema permits scope:project without projectRoot, and
    // loadLocalConfig() does not backfill it. getDataHome inherits
    // getTeamaiHome's refusal to silently fall back to the user home. Consumers
    // whose config source can yield such a config (recall.ts, viz.ts) MUST guard
    // before calling getDataHome and fall back to ~/.teamai themselves — this
    // test documents why that guard exists so it is not "simplified" away.
    process.env.HOME = '/home/alice';
    const cfg = makeConfig({ scope: 'project', projectRoot: undefined });
    expect(() => getDataHome(cfg)).toThrow(/projectRoot is missing/);
  });
});

