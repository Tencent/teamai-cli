import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadLocalConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

vi.mock('../utils/fs.js', () => ({
  expandHome: (p: string) => p.replace('~', '/home/test'),
}));

vi.mock('../types.js', () => ({
  TEAMAI_UPDATE_LOCK_PATH: '/tmp/test-update-lock',
}));

let readlineAnswer = 'n';
vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: (_prompt: string, cb: (answer: string) => void) => {
        cb(readlineAnswer);
      },
      close: vi.fn(),
    }),
  },
}));

// ─── Imports (after mocks) ──────────────────────────────

import { execSync } from 'node:child_process';
import fse from 'fs-extra';
import { loadState, saveState, loadLocalConfig } from '../config.js';
import { log } from '../utils/logger.js';

import {
  getCurrentVersion,
  compareVersions,
  isCacheValid,
  acquireLock,
  releaseLock,
  checkForUpdate,
  doUpdate,
  update,
} from '../update.js';

// ─── Typed mock references ──────────────────────────────

const mockedExecSync = execSync as Mock;
const mockedLoadState = loadState as Mock;
const mockedSaveState = saveState as Mock;
const mockedLoadLocalConfig = loadLocalConfig as Mock;
const mockedFse = fse as unknown as {
  pathExists: Mock;
  readFile: Mock;
  writeFile: Mock;
  remove: Mock;
  ensureDir: Mock;
};
const mockedLog = log as unknown as {
  info: Mock;
  success: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
  dim: Mock;
};

// ─── Test setup ─────────────────────────────────────────

const defaultState = {
  lastPush: null,
  lastPull: null,
  pushedRules: [],
  pushedSkills: [],
  pushedEnvVars: [],
  lastUpdateCheck: null,
  availableUpdate: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  readlineAnswer = 'n';
  mockedLoadState.mockResolvedValue({ ...defaultState });
  mockedSaveState.mockResolvedValue(undefined);
  mockedLoadLocalConfig.mockResolvedValue({
    repo: { localPath: '/tmp/repo', remote: 'https://git.woa.com/team/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
  });
  mockedFse.pathExists.mockResolvedValue(false);
  mockedFse.readFile.mockResolvedValue('');
  mockedFse.writeFile.mockResolvedValue(undefined);
  mockedFse.remove.mockResolvedValue(undefined);
});

// ─── Unit tests: compareVersions ────────────────────────

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.3.13', '0.3.13')).toBe(0);
  });

  it('should return -1 when first is older', () => {
    expect(compareVersions('0.3.13', '0.4.0')).toBe(-1);
    expect(compareVersions('0.3.13', '0.3.14')).toBe(-1);
    expect(compareVersions('0.3.13', '1.0.0')).toBe(-1);
  });

  it('should return 1 when first is newer', () => {
    expect(compareVersions('0.4.0', '0.3.13')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('should handle different length versions', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
  });
});

// ─── Unit tests: isCacheValid ───────────────────────────

describe('isCacheValid', () => {
  it('should return false for null lastCheck', () => {
    expect(isCacheValid(null)).toBe(false);
  });

  it('should return true for recent check', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    expect(isCacheValid(recent)).toBe(true);
  });

  it('should return false for expired check', () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isCacheValid(old)).toBe(false);
  });

  it('should return false for invalid date string', () => {
    expect(isCacheValid('not-a-date')).toBe(false);
  });
});

// ─── Test #1: Cache hit within 24h, skip npm view ───────

describe('checkForUpdate', () => {
  it('should skip npm view when cache is valid', async () => {
    const recentCheck = new Date(Date.now() - 1000).toISOString();
    mockedLoadState.mockResolvedValue({
      ...defaultState,
      lastUpdateCheck: recentCheck,
      availableUpdate: '99.0.0',
    });

    const result = await checkForUpdate();

    expect(result.available).toBe(true);
    expect(result.latest).toBe('99.0.0');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  // ─── Test #2: Cache expired, npm view called ──────────

  it('should call npm view when cache is expired', async () => {
    const oldCheck = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockedLoadState.mockResolvedValue({
      ...defaultState,
      lastUpdateCheck: oldCheck,
      availableUpdate: null,
    });
    mockedExecSync.mockReturnValue('99.0.0\n');

    const result = await checkForUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('npm view'),
      expect.any(Object),
    );
    expect(result.available).toBe(true);
    expect(result.latest).toBe('99.0.0');
  });

  // ─── Test #3: npm view timeout ────────────────────────

  it('should return not available on npm view timeout', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('Command timed out');
    });

    const result = await checkForUpdate({ force: true });

    expect(result.available).toBe(false);
    expect(mockedLog.error).toHaveBeenCalled();
  });

  // ─── Test #4: npm view network error ──────────────────

  it('should return not available on npm view network error', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('ENETUNREACH');
    });

    const result = await checkForUpdate({ force: true });

    expect(result.available).toBe(false);
  });

  // ─── Test #5: Same version, no update ─────────────────

  it('should report no update when version is same', async () => {
    const current = getCurrentVersion();
    mockedExecSync.mockReturnValue(`${current}\n`);

    const result = await checkForUpdate({ force: true });

    expect(result.available).toBe(false);
    expect(result.current).toBe(current);
    expect(result.latest).toBe(current);
  });

  // ─── Test #6: Newer version available ─────────────────

  it('should report update available when newer version exists', async () => {
    mockedExecSync.mockReturnValue('99.0.0\n');

    const result = await checkForUpdate({ force: true });

    expect(result.available).toBe(true);
    expect(result.latest).toBe('99.0.0');
    expect(mockedSaveState).toHaveBeenCalledWith(
      expect.objectContaining({
        availableUpdate: '99.0.0',
      }),
    );
  });
});

// ─── Test #7: Policy=auto, npm install executes ─────────

describe('doUpdate', () => {
  it('should execute npm install when policy is auto and update available', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n') // npm view
      .mockReturnValueOnce('')          // npm install
      .mockReturnValueOnce('');         // teamai hooks inject --silent

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('npm install -g'),
      expect.any(Object),
    );
    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Updated teamai to v99.0.0'),
    );
  });

  // ─── Test #8: Policy=prompt + non-TTY (hook context) ───

  it('should print hint and not install when policy is prompt and stdin is not TTY', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

    mockedLoadLocalConfig.mockResolvedValue({
      repo: { localPath: '/tmp/repo', remote: 'https://...' },
      username: 'testuser',
      updatePolicy: 'prompt',
    });
    mockedExecSync.mockReturnValueOnce('99.0.0\n');

    await doUpdate();

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Run "teamai update" to upgrade'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(1);

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  // ─── Test #9: Policy=prompt + TTY mode, user confirms

  it('should ask user and proceed when policy is prompt and user confirms', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    readlineAnswer = 'y';
    mockedLoadLocalConfig.mockResolvedValue({
      repo: { localPath: '/tmp/repo', remote: 'https://...' },
      username: 'testuser',
      updatePolicy: 'prompt',
    });
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('');

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedLog.success).toHaveBeenCalled();

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  // ─── Test #10: Policy=skip, exit without action ───────

  it('should skip update when policy is skip', async () => {
    mockedLoadLocalConfig.mockResolvedValue({
      repo: { localPath: '/tmp/repo', remote: 'https://...' },
      username: 'testuser',
      updatePolicy: 'skip',
    });
    mockedExecSync.mockReturnValueOnce('99.0.0\n');

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedLog.debug).toHaveBeenCalledWith(
      expect.stringContaining('skip'),
    );
  });

  // ─── Test #11: File lock acquired, proceed ────────────

  it('should proceed with install when lock is acquired', async () => {
    mockedFse.pathExists.mockResolvedValue(false);
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('');

    await doUpdate();

    expect(mockedFse.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('update-lock'),
      expect.any(String),
    );
    expect(mockedLog.success).toHaveBeenCalled();
    expect(mockedFse.remove).toHaveBeenCalledWith(
      expect.stringContaining('update-lock'),
    );
  });

  // ─── Test #12: File lock busy (another process alive) ─

  it('should skip when lock is held by another live process', async () => {
    mockedFse.pathExists.mockResolvedValue(true);
    mockedFse.readFile.mockResolvedValue(String(process.pid));

    mockedExecSync.mockReturnValueOnce('99.0.0\n');

    await doUpdate();

    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Another update is in progress'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  // ─── Test #13: npm install EACCES ─────────────────────

  it('should warn about permission denied on EACCES', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n')
      .mockImplementationOnce(() => {
        const err = new Error('npm ERR! code EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

    await doUpdate();

    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Permission denied'),
    );
    expect(mockedFse.remove).toHaveBeenCalled();
  });

  // ─── Test #14: npm install timeout ────────────────────

  it('should warn about timeout on npm install timeout', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n')
      .mockImplementationOnce(() => {
        throw new Error('ETIMEDOUT');
      });

    await doUpdate();

    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
    );
  });

  // ─── Test: Already up to date ─────────────────────────

  it('should log up to date when no update available', async () => {
    const current = getCurrentVersion();
    mockedExecSync.mockReturnValueOnce(`${current}\n`);

    await doUpdate();

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Already up to date'),
    );
  });
});

// ─── Test #15: state.json corrupted, Zod defaults ───────

describe('checkForUpdate with corrupted state', () => {
  it('should trigger fresh check when state has default values', async () => {
    mockedLoadState.mockResolvedValue({
      ...defaultState,
      lastUpdateCheck: null,
      availableUpdate: null,
    });
    mockedExecSync.mockReturnValue('99.0.0\n');

    const result = await checkForUpdate();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('npm view'),
      expect.any(Object),
    );
    expect(result.available).toBe(true);
  });
});

// ─── Test: update() entry point ─────────────────────────

describe('update', () => {
  it('should only check and print when --check is set', async () => {
    mockedExecSync.mockReturnValueOnce('99.0.0\n');

    await update({ check: true });

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Update available'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('should print up to date when --check and no update', async () => {
    const current = getCurrentVersion();
    mockedExecSync.mockReturnValueOnce(`${current}\n`);

    await update({ check: true });

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Already up to date'),
    );
  });

  it('should run full update flow without --check', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('');

    await update({});

    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedLog.success).toHaveBeenCalled();
  });
});

// ─── Hook refresh after update tests ────────────────────

describe('hook refresh after update', () => {
  it('should spawn "teamai hooks inject --silent" after successful update', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n') // npm view
      .mockReturnValueOnce('')          // npm install
      .mockReturnValueOnce('');         // teamai hooks inject --silent

    await doUpdate();

    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Updated teamai to v99.0.0'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedExecSync).toHaveBeenCalledWith(
      'teamai hooks inject --silent',
      expect.objectContaining({ timeout: 15_000, stdio: 'pipe' }),
    );
    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Refreshed hooks'),
    );
  });

  it('should silently skip hook refresh when spawn fails', async () => {
    mockedExecSync
      .mockReturnValueOnce('99.0.0\n') // npm view
      .mockReturnValueOnce('')          // npm install
      .mockImplementationOnce(() => {   // teamai hooks inject fails
        throw new Error('command not found');
      });

    await doUpdate();

    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Updated teamai to v99.0.0'),
    );
    expect(mockedLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Hook refresh after update skipped'),
    );
  });
});

// ─── Unit tests: acquireLock / releaseLock ──────────────

describe('acquireLock', () => {
  it('should acquire lock when no lockfile exists', async () => {
    mockedFse.pathExists.mockResolvedValue(false);

    const result = await acquireLock('/tmp/test-lock');

    expect(result).toBe(true);
    expect(mockedFse.writeFile).toHaveBeenCalledWith('/tmp/test-lock', String(process.pid));
  });

  it('should remove stale lock from dead process', async () => {
    mockedFse.pathExists.mockResolvedValue(true);
    mockedFse.readFile.mockResolvedValue('99999999');

    const result = await acquireLock('/tmp/test-lock');

    expect(mockedFse.remove).toHaveBeenCalledWith('/tmp/test-lock');
    expect(result).toBe(true);
  });
});

describe('releaseLock', () => {
  it('should remove lockfile', async () => {
    await releaseLock('/tmp/test-lock');
    expect(mockedFse.remove).toHaveBeenCalledWith('/tmp/test-lock');
  });
});
