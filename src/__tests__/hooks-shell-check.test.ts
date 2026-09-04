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

import { hasShell, _resetShellCache } from '../builtin-hooks.js';
import { injectHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';

// Isolate getUserHome() so ensureTeamaiWrapper / bundled-shell detection read
// a per-test home directory instead of the real one.
const homeState = vi.hoisted(() => ({ home: '' }));
vi.mock('../utils/home.js', () => ({
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

describe('injectHooksToAllTools — no-shell skip', () => {
  let tmp: string;

  beforeEach(async () => {
    _resetShellCache();
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'hooks-shell-'));
    homeState.home = tmp;
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
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
