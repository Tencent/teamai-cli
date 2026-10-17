/**
 * Git Bash on Windows exports `HOME` as a POSIX path (`/c/Users/alice`). Node's
 * `path` is native there, so joining that string onto `.teamai/...` targets a
 * drive-root path (`\c\Users\alice`) instead of `C:\Users\alice` — credentials,
 * the repo cache and the path-safety allowlist would all land somewhere the user
 * never looks. `normalizeHomePath` converts exactly that shape and nothing else.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expandHome, normalizeHomePath } from '../utils/home.js';

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['win32', 'linux'] as const)('expandHome on %s', (platform) => {
  it('expands home paths before and after native path joining', () => {
    setPlatform(platform);
    const nativePath = platform === 'win32' ? path.win32 : path.posix;
    const join = nativePath.join;
    vi.spyOn(path, 'join').mockImplementation(join);
    const home = platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice';
    vi.stubEnv('HOME', home);

    expect(expandHome('~')).toBe(home);
    expect(expandHome('~/.teamai/team-repo')).toBe(nativePath.join(home, '.teamai', 'team-repo'));
    expect(expandHome(nativePath.join('~/.teamai/team-repo', 'manifest', 'roles.yaml'))).toBe(
      nativePath.join(home, '.teamai', 'team-repo', 'manifest', 'roles.yaml'),
    );
  });

  it('only treats backslashes as separators on Windows', () => {
    setPlatform(platform);
    const nativePath = platform === 'win32' ? path.win32 : path.posix;
    const join = nativePath.join;
    vi.spyOn(path, 'join').mockImplementation(join);
    const home = platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice';
    vi.stubEnv('HOME', home);

    const input = '~\\.teamai\\team-repo';
    expect(expandHome(input)).toBe(platform === 'win32'
      ? nativePath.join(home, '.teamai', 'team-repo')
      : input);
    for (const unchanged of ['~alice/repo', 'relative/repo', home]) {
      expect(expandHome(unchanged)).toBe(unchanged);
    }
  });
});

describe('normalizeHomePath', () => {
  it('converts a Git Bash drive path to native form', () => {
    setPlatform('win32');
    expect(normalizeHomePath('/c/Users/alice')).toBe('C:\\Users\\alice');
    expect(normalizeHomePath('/d/work/home')).toBe('D:\\work\\home');
    expect(normalizeHomePath('/c')).toBe('C:\\');
  });

  it('converts a /cygdrive/ path', () => {
    setPlatform('win32');
    expect(normalizeHomePath('/cygdrive/c/Users/alice')).toBe(
      'C:\\Users\\alice',
    );
  });

  it('leaves an already-native Windows home alone', () => {
    setPlatform('win32');
    expect(normalizeHomePath('C:\\Users\\alice')).toBe('C:\\Users\\alice');
    expect(normalizeHomePath('C:/Users/alice')).toBe('C:/Users/alice');
  });

  it('does not mistake a POSIX home for a drive path', () => {
    setPlatform('win32');
    // Only a single-letter root is an MSYS drive; /home and /usr are not.
    expect(normalizeHomePath('/home/alice')).toBe('/home/alice');
    expect(normalizeHomePath('/usr/share')).toBe('/usr/share');
    expect(normalizeHomePath('/cygdrive')).toBe('/cygdrive');
  });

  it('never rewrites anything on POSIX platforms', () => {
    setPlatform('linux');
    expect(normalizeHomePath('/c/Users/alice')).toBe('/c/Users/alice');
    setPlatform('darwin');
    expect(normalizeHomePath('/c/Users/alice')).toBe('/c/Users/alice');
  });
});
