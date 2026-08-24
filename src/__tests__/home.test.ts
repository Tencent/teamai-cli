import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getUserHome } from '../utils/home.js';
import { getTeamaiHome, resolveBaseDir, type LocalConfig } from '../types.js';

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

  it('initializes exported user paths from USERPROFILE when HOME is unavailable', async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\alice';
    vi.resetModules();

    const paths = await import('../types.js');

    expect(paths.TEAMAI_HOME).toBe(path.join('C:\\Users\\alice', '.teamai'));
    expect(paths.TEAMAI_CONFIG_PATH).toBe(
      path.join('C:\\Users\\alice', '.teamai', 'config.yaml'),
    );
    expect(paths.TEAMAI_SOURCES_DIR).toBe(
      path.join('C:\\Users\\alice', '.teamai', 'sources'),
    );
  });

  it('falls back to os.homedir when neither environment variable is available', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    expect(getUserHome()).toBe(os.homedir());
  });
});
