/**
 * HOME and the platform home are not the same directory everywhere: a native
 * Windows PowerShell session exposes only USERPROFILE, and Git Bash on Windows
 * sets HOME to a path `os.homedir()` never reports. Everything that resolves
 * `~` has to agree with `getUserHome()`, or credentials, caches and the
 * path-safety allowlist end up in three different places on one machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readNetrcToken, writeNetrcToken } from '../providers/gitcode/gitcode-api.js';
import { getRepoCacheDir } from '../utils/repo-cache.js';
import { getCacheRoot } from '../utils/cache-index.js';
import { defaultAllowedRoots } from '../utils/path-safety.js';

const GITCODE_HOST = 'gitcode.com';

let home: string;
let platformHome: string;
let savedHome: string | undefined;
let savedCacheDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedCacheDir = process.env.TEAMAI_CACHE_DIR;
  delete process.env.TEAMAI_CACHE_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-home-'));
  platformHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-platform-'));
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(platformHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  if (savedCacheDir === undefined) delete process.env.TEAMAI_CACHE_DIR;
  else process.env.TEAMAI_CACHE_DIR = savedCacheDir;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(platformHome, { recursive: true, force: true });
});

describe('user home resolution', () => {
  it('stores the GitCode token in the netrc file git itself reads', () => {
    // A decoy under the platform home: reading the wrong file returns this.
    fs.writeFileSync(
      path.join(platformHome, '.netrc'),
      `machine ${GITCODE_HOST} login oauth2 password FROM-PLATFORM-HOME\n`,
    );

    writeNetrcToken('FROM-HOME');

    expect(readNetrcToken()).toBe('FROM-HOME');
    expect(fs.existsSync(path.join(home, '.netrc'))).toBe(true);
  });

  it('keeps the repo cache under the same home as the rest of ~/.teamai', () => {
    expect(getRepoCacheDir('github', 'acme', 'widget')).toBe(
      path.join(home, '.teamai', 'cache', 'repos', 'github', 'acme', 'widget'),
    );
    expect(getCacheRoot()).toBe(
      path.join(home, '.teamai', 'cache', 'repos'),
    );
  });

  it('allows the home it actually writes to by default', () => {
    expect(defaultAllowedRoots()).toContain(home);
  });
});
