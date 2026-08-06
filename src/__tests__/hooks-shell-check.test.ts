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
      expect.stringContaining('Skipping hook injection for CodeBuddy/WorkBuddy'),
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
