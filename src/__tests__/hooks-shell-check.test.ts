import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

// Mock logger before any imports that use it.
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fs.existsSync to control /bin/sh detection.
const originalExistsSync = (await import('node:fs')).existsSync;
let shellExists = true;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => {
        if (p === '/bin/sh') return shellExists;
        return originalExistsSync(p);
      },
    },
  };
});

// CodeBuddy's shell resolver falls back to the HKLM GitForWindows key, so on a
// developer machine that has Git for Windows installed the "Git Bash absent"
// case is unreachable. Fail the registry probe here and the case behaves the
// same on Windows as it does on ubuntu CI.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: () => {
      throw new Error('Git for Windows registry is not available in tests');
    },
  };
});

import { hasShell, _resetShellCache } from '../builtin-hooks.js';
import { injectHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';

// Isolate getUserHome() so ensureTeamaiWrapper / bundled-shell detection read
// a per-test home directory instead of the real one.
const homeState = vi.hoisted(() => ({ home: '' }));
vi.mock('../utils/home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/home.js')>()),
  getUserHome: () => homeState.home,
}));

describe('hasShell()', () => {
  beforeEach(() => {
    _resetShellCache();
  });

  it('returns true when /bin/sh exists', () => {
    shellExists = true;
    expect(hasShell()).toBe(true);
  });

  it('returns false when /bin/sh does not exist', () => {
    shellExists = false;
    expect(hasShell()).toBe(false);
  });

  it('caches the result across calls', () => {
    shellExists = true;
    expect(hasShell()).toBe(true);
    shellExists = false;
    expect(hasShell()).toBe(true);
  });

  it('resets cache via _resetShellCache', () => {
    shellExists = true;
    expect(hasShell()).toBe(true);
    _resetShellCache();
    shellExists = false;
    expect(hasShell()).toBe(false);
  });
});

describe('injectHooksToAllTools — no-shell skip (posix)', () => {
  let tmp: string;
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Pin POSIX: on win32 codebuddy has cmd.exe and is never gated on /bin/sh
    // (see the win32 describe below).
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    _resetShellCache();
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-shell-'));
    homeState.home = tmp;
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    platformSpy.mockRestore();
    await fse.remove(tmp);
  });

  it('skips codebuddy hook injection and warns when /bin/sh is absent', async () => {
    shellExists = false;
    const codebuddyDir = path.join(tmp, '.codebuddy');
    await fse.ensureDir(codebuddyDir);
    const settingsPath = '.codebuddy/settings.json';

    await injectHooksToAllTools({ codebuddy: { settings: settingsPath } }, tmp);

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping hook injection for codebuddy'),
    );
    const settingsExists = await fse.pathExists(path.join(tmp, settingsPath));
    expect(settingsExists).toBe(false);
  });

  it('injects codebuddy hooks normally when /bin/sh is available', async () => {
    shellExists = true;
    const codebuddyDir = path.join(tmp, '.codebuddy');
    await fse.ensureDir(codebuddyDir);
    const settingsPath = '.codebuddy/settings.json';

    await injectHooksToAllTools({ codebuddy: { settings: settingsPath } }, tmp);

    const settingsExists = await fse.pathExists(path.join(tmp, settingsPath));
    expect(settingsExists).toBe(true);
  });
});

describe('injectHooksToAllTools — workbuddy bundled PortableGit sh (win32)', () => {
  let tmp: string;
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    _resetShellCache();
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'wb-sh-'));
    homeState.home = tmp;
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    platformSpy.mockRestore();
    await fse.remove(tmp);
  });

  it('injects workbuddy hooks via the bundled PortableGit sh without /bin/sh', async () => {
    shellExists = false;
    const shBin = path.join(tmp, '.workbuddy', 'binaries', 'PortableGit', 'versions', '1.2.0', 'usr', 'bin', 'sh.exe');
    await fse.ensureFile(shBin);

    await injectHooksToAllTools({ workbuddy: { settings: '.workbuddy/settings.json' } }, tmp);

    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    expect(await fse.pathExists(path.join(tmp, '.workbuddy', 'settings.json'))).toBe(true);
  });

  it('skips workbuddy when the bundled sh is missing', async () => {
    shellExists = false;
    await fse.ensureDir(path.join(tmp, '.workbuddy'));

    await injectHooksToAllTools({ workbuddy: { settings: '.workbuddy/settings.json' } }, tmp);

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping hook injection for workbuddy'),
    );
    expect(await fse.pathExists(path.join(tmp, '.workbuddy', 'settings.json'))).toBe(false);
  });
});

describe('injectHooksToAllTools — codebuddy runs hooks through Git Bash (win32)', () => {
  let tmp: string;
  let platformSpy: ReturnType<typeof vi.spyOn>;
  // findGitBashWindows() reads these off the real environment; clear them so the
  // only candidate is the one under the mocked home, and the case is the same on
  // a developer's Windows box as on ubuntu CI.
  const winEnvKeys = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  let savedEnv: Record<string, string | undefined>;

  const fakeGitBash = (home: string): string =>
    path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe');

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'cb-sh-'));
    homeState.home = tmp;
    savedEnv = {};
    for (const key of winEnvKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    _resetShellCache();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    platformSpy.mockRestore();
    for (const key of winEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fse.remove(tmp);
  });

  it('injects codebuddy hooks in POSIX syntax, without /bin/sh', async () => {
    shellExists = false;
    await fse.ensureFile(fakeGitBash(tmp));
    await fse.ensureDir(path.join(tmp, '.codebuddy'));

    await injectHooksToAllTools({ codebuddy: { settings: '.codebuddy/settings.json' } }, tmp);

    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    const settings = await fse.readJson(path.join(tmp, '.codebuddy', 'settings.json'));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe(
      'PATH="$HOME/.teamai/bin:$PATH" teamai hook-dispatch session-start --tool codebuddy 2>/dev/null || true',
    );
    // The cmd.exe form 0.26.0 wrote made Git Bash create a file literally named
    // `nul` in the hook's cwd on every invocation.
    expect(command).not.toContain('2>nul');
    expect(command).not.toContain('set "PATH=');
  });

  it('renders the per-matcher variant in POSIX syntax too', async () => {
    shellExists = false;
    await fse.ensureFile(fakeGitBash(tmp));
    await fse.ensureDir(path.join(tmp, '.codebuddy'));

    await injectHooksToAllTools({ codebuddy: { settings: '.codebuddy/settings.json' } }, tmp);

    const settings = await fse.readJson(path.join(tmp, '.codebuddy', 'settings.json'));
    const todoWrite = settings.hooks.PostToolUse.find((g: { matcher: string }) => g.matcher === 'TodoWrite');
    expect(todoWrite.hooks[0].command).toContain('hook-dispatch post-tool-use --tool codebuddy --matcher TodoWrite');
    expect(todoWrite.hooks[0].command).toContain('2>/dev/null || true');
  });

  it('skips codebuddy hook injection and warns when Git Bash is absent', async () => {
    shellExists = false;
    await fse.ensureDir(path.join(tmp, '.codebuddy'));

    await injectHooksToAllTools({ codebuddy: { settings: '.codebuddy/settings.json' } }, tmp);

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping hook injection for codebuddy'),
    );
    expect(await fse.pathExists(path.join(tmp, '.codebuddy', 'settings.json'))).toBe(false);
  });
});
