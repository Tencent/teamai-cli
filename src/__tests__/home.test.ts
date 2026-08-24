import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('falls back to os.tmpdir when even os.homedir is unresolvable', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    // os.homedir() is documented to return '' when the home cannot be resolved.
    const spy = vi.spyOn(os, 'homedir').mockReturnValue('');

    try {
      const home = getUserHome();
      expect(home).toBe(os.tmpdir());
      expect(home).not.toBe('');
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

describe('home directory lookups', () => {
  it('never read process.env.HOME directly outside getUserHome', async () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const rel = path.relative(srcDir, full);
          // utils/home.ts is the single sanctioned reader of the raw env var.
          if (rel === path.join('utils', 'home.ts')) continue;
          const content = await fs.readFile(full, 'utf-8');
          if (content.includes('process.env.HOME')) offenders.push(rel);
        }
      }
    }

    await walk(srcDir);

    // A bare process.env.HOME breaks Windows, where only USERPROFILE is set:
    // `?? ''` silently degrades to a relative path and a non-null assertion crashes.
    expect(offenders).toEqual([]);
  });
});
