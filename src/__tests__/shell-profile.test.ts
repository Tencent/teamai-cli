import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import {
  detectShellProfile,
  envBlockSourcesPath,
  envBlockReferencesDataHome,
  resolveActiveShellProfile,
  sameFile,
  shellQuoteValue,
} from '../utils/shell-profile.js';

/**
 * `platform` is passed explicitly to every call below rather than relying on
 * `process.platform` (same convention as `resolveCliPath` in cli-path.ts):
 * CI only runs ubuntu/macos, so a test that trusted the host platform would
 * never exercise the win32 branch — which is exactly how #682 went unnoticed.
 */
describe('detectShellProfile', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-shell-profile-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('POSIX (darwin/linux)', () => {
    it('returns .zshrc when SHELL is zsh', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      expect(await detectShellProfile('linux')).toBe(path.join(homeDir, '.zshrc'));
    });

    it('returns .bashrc when SHELL is bash', async () => {
      vi.stubEnv('SHELL', '/bin/bash');
      expect(await detectShellProfile('darwin')).toBe(path.join(homeDir, '.bashrc'));
    });

    it('returns .bashrc when SHELL is unset', async () => {
      vi.stubEnv('SHELL', '');
      expect(await detectShellProfile('linux')).toBe(path.join(homeDir, '.bashrc'));
    });
  });

  describe('Windows (win32)', () => {
    it('returns .zshrc when SHELL is zsh, even on win32 (MSYS2/Cygwin zsh)', async () => {
      // A zsh installed via MSYS2/Cygwin sets SHELL just like it does on
      // POSIX, while native Windows Node still reports platform === win32.
      // SHELL-based detection must win here, or this setup regresses.
      vi.stubEnv('SHELL', '/usr/bin/zsh');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.zshrc'));
    });

    it('falls back to .bashrc when SHELL is unset and none of the login-shell files exist', async () => {
      vi.stubEnv('SHELL', '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bashrc'));
    });

    it('prefers an existing .bash_profile over .bash_login, .profile and .bashrc', async () => {
      await fse.writeFile(path.join(homeDir, '.bash_profile'), '');
      await fse.writeFile(path.join(homeDir, '.bash_login'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bash_profile'));
    });

    it('prefers .bash_login over .profile and .bashrc when .bash_profile is absent', async () => {
      await fse.writeFile(path.join(homeDir, '.bash_login'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.bash_login'));
    });

    it('falls back to .profile when only it exists — the case from #682', async () => {
      // Reported setup: ~/.bashrc present, ~/.bash_profile absent, ~/.profile
      // present. Git Bash starts as a login shell and never reads .bashrc.
      await fse.writeFile(path.join(homeDir, '.bashrc'), '');
      await fse.writeFile(path.join(homeDir, '.profile'), '');
      expect(await detectShellProfile('win32')).toBe(path.join(homeDir, '.profile'));
    });
  });
});

// Regression (#693 review round 7): Git for Windows' own
// /etc/profile.d/bash_profile.sh auto-generates ~/.bash_profile the first
// time a login shell starts with ~/.bashrc present but none of
// ~/.bash_profile, ~/.bash_login or ~/.profile — a plain file containing
// `test -f ~/.bashrc && . ~/.bashrc`, not a symlink. detectShellProfile's
// order then prefers that newly-existing file on the next pull, so the
// resolver must stick to wherever this scope's block already lives instead
// of re-running the order-based fallback every time.
describe('resolveActiveShellProfile', () => {
  let tmpDir: string;
  let homeDir: string;
  let envShPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-active-shell-profile-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '');
    envShPath = path.join(homeDir, '.teamai', 'env.sh');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  function teamaiBlock(): string {
    const posix = envShPath.split(path.sep).join('/');
    return `# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${shellQuoteValue(posix)} ] && source ${shellQuoteValue(posix)}\n# [teamai:env:end]\n`;
  }

  it('sticks to .bashrc even after Git for Windows auto-generates a forwarding .bash_profile', async () => {
    await fse.writeFile(path.join(homeDir, '.bashrc'), teamaiBlock());
    // The exact content Git for Windows' bash_profile.sh generates — a plain
    // forwarding file, never a symlink, and carries no teamai markers.
    await fse.writeFile(
      path.join(homeDir, '.bash_profile'),
      '# generated by Git for Windows\ntest -f ~/.profile && . ~/.profile\ntest -f ~/.bashrc && . ~/.bashrc\n',
    );
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('sticks to a lower-priority candidate over a higher-priority one that exists but carries no block', async () => {
    // Order-based detection would prefer .bash_profile over .profile; the
    // sticky block living in .profile must still win.
    await fse.writeFile(path.join(homeDir, '.bash_profile'), 'unrelated content\n');
    await fse.writeFile(path.join(homeDir, '.profile'), teamaiBlock());
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });

  it('falls back to order-based detection when no candidate owns a block yet (first pull)', async () => {
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.bashrc'));
  });

  it('does not stick to a different scope\'s block; falls back to order-based detection', async () => {
    const otherEnvSh = path.join(homeDir, 'other-project', '.teamai', 'env.sh');
    const otherPosix = otherEnvSh.split(path.sep).join('/');
    await fse.writeFile(
      path.join(homeDir, '.bashrc'),
      `# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${shellQuoteValue(otherPosix)} ] && source ${shellQuoteValue(otherPosix)}\n# [teamai:env:end]\n`,
    );
    await fse.writeFile(path.join(homeDir, '.profile'), '');
    expect(await resolveActiveShellProfile(envShPath, 'win32')).toBe(path.join(homeDir, '.profile'));
  });
});

describe('envBlockSourcesPath', () => {
  it('matches a plain path in the generator\'s single-quoted form', () => {
    const envShPath = '/home/user/.teamai/env.sh';
    const block = `[ -f ${shellQuoteValue(envShPath)} ] && source ${shellQuoteValue(envShPath)}`;
    expect(envBlockSourcesPath(block, envShPath)).toBe(true);
  });

  // Regression (#693 review): shellQuoteValue escapes an embedded apostrophe
  // as `'\''`, so a raw substring check for `/home/O'Brien/...` never matches
  // — the block only ever contains the escaped form.
  it('matches a home path containing an apostrophe (generator escapes it as \'\\\'\')', () => {
    const envShPath = "/home/O'Brien/.teamai/env.sh";
    const block = `[ -f ${shellQuoteValue(envShPath)} ] && source ${shellQuoteValue(envShPath)}`;
    expect(block).toContain(String.raw`O'\''Brien`);
    expect(envBlockSourcesPath(block, envShPath)).toBe(true);
  });

  it('does not match a different path', () => {
    const block = `[ -f ${shellQuoteValue('/home/user/.teamai/env.sh')} ] && source ${shellQuoteValue('/home/user/.teamai/env.sh')}`;
    expect(envBlockSourcesPath(block, '/home/other/.teamai/env.sh')).toBe(false);
  });

  it('does not match an unquoted, unconverted Windows path (#661)', () => {
    const envShPath = 'C:/Users/me/.teamai/env.sh';
    const windowsForm = envShPath.replace(/\//g, '\\');
    const block = `[ -f ${windowsForm} ] && source ${windowsForm}`;
    expect(envBlockSourcesPath(block, envShPath)).toBe(false);
  });
});

// Regression (#693 hardware review by @CarlosWonMore): envBlockSourcesPath
// only recognizes the current writing format. A block from a pre-#661 or
// pre-#682 CLI names the same env.sh under a different, broken spelling —
// still owned by this scope, and uninstall/doctor's "is there a stray
// leftover" check must still find it to clean it up or flag it.
describe('envBlockReferencesDataHome', () => {
  it('matches the current (quoted, forward-slash) form', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const posix = envShPath.split('\\').join('/');
    const block = `[ -f ${shellQuoteValue(posix)} ] && source ${shellQuoteValue(posix)}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('matches a pre-#661 raw, unquoted, unconverted Windows path', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const block = `[ -f ${envShPath} ] && source ${envShPath}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('matches the MSYS/Cygwin drive form (/d/Users/...) a locally-patched build wrote', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const msysForm = '/d/Users/me/.teamai/env.sh';
    const block = `[ -f ${msysForm} ] && source ${msysForm}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(true);
  });

  it('does not match a different scope\'s env.sh', () => {
    const envShPath = 'D:\\Users\\me\\.teamai\\env.sh';
    const otherPosix = 'D:/some-other-project/.teamai/env.sh';
    const block = `[ -f ${shellQuoteValue(otherPosix)} ] && source ${shellQuoteValue(otherPosix)}`;
    expect(envBlockReferencesDataHome(block, envShPath)).toBe(false);
  });
});

// Regression (#693 review round 6): the stray-block scan compares a
// user-supplied `shellProfilePath` override against a `path.join`-built
// candidate. A raw `===` made a valid override a false positive "stray copy
// of itself" whenever the two spellings of the same path did not match
// byte-for-byte — an override with forward slashes, or (Windows only) a
// different case.
describe('sameFile', () => {
  it('matches a forward-slash override against a backslash candidate on win32', () => {
    expect(sameFile('C:/Users/me/.profile', 'C:\\Users\\me\\.profile', 'win32')).toBe(true);
  });

  it('matches regardless of case on win32', () => {
    expect(sameFile('C:\\Users\\Me\\.profile', 'c:\\users\\me\\.profile', 'win32')).toBe(true);
  });

  it('does not match a genuinely different file on win32', () => {
    expect(sameFile('C:\\Users\\me\\.profile', 'C:\\Users\\me\\.bashrc', 'win32')).toBe(false);
  });

  it('is case-sensitive on posix, where a case difference is a different file', () => {
    expect(sameFile('/home/me/.profile', '/home/me/.PROFILE', 'linux')).toBe(false);
  });

  it('matches identical posix paths', () => {
    expect(sameFile('/home/me/.profile', '/home/me/.profile', 'linux')).toBe(true);
  });
});
