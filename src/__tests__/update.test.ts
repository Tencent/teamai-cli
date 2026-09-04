import { describe, it, expect, vi, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

// update.ts uses `promisify(execFile)`. Mock execFile with a promisify.custom
// hook so promisify returns our controllable async mock; each test drives it
// via mockExec.mockResolvedValue({ stdout, stderr }) / mockRejectedValue(err).
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = mockExec;
  return { execFile };
});

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
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
  ensureDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('../types.js', () => ({
  getUpdateLockPath: () => '/tmp/test-update-lock',
}));

vi.mock('../builtin-hooks.js', () => ({
  resolveTeamaiEntryScript: vi.fn(),
}));

let readlineAnswer = 'n';
vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    return Promise.resolve(readlineAnswer || defaultValue || '');
  }),
  askConfirmation: vi.fn(() => {
    return Promise.resolve(
      readlineAnswer.toLowerCase() === 'y' || readlineAnswer.toLowerCase() === 'yes',
    );
  }),
  closePrompt: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────

import fse from 'fs-extra';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, loadLocalConfig, loadTeamConfig } from '../config.js';
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
  resolveNpmCommand,
  prefixFromEntryPath,
} from '../update.js';
import { resolveTeamaiEntryScript } from '../builtin-hooks.js';

// ─── Typed mock references ──────────────────────────────

const mockedExecSync = mockExec as Mock;
const mockedLoadState = loadState as Mock;
const mockedSaveState = saveState as Mock;
const mockedLoadLocalConfig = loadLocalConfig as Mock;
const mockedLoadTeamConfig = loadTeamConfig as Mock;
const mockedFse = fse as unknown as {
  pathExists: Mock;
  readFile: Mock;
  writeFile: Mock;
  remove: Mock;
  ensureDir: Mock;
  rename: Mock;
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
  mockedLoadTeamConfig.mockResolvedValue(null);
  mockedFse.pathExists.mockResolvedValue(false);
  mockedFse.readFile.mockResolvedValue('');
  mockedFse.writeFile.mockResolvedValue(undefined);
  mockedFse.remove.mockResolvedValue(undefined);
  mockedFse.rename.mockResolvedValue(undefined);
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

  it('should treat prerelease as older than same numeric release', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBe(1);
  });

  it('should treat prerelease as older than a higher release', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.4')).toBe(-1);
    expect(compareVersions('1.3.0-alpha.0', '1.3.0')).toBe(-1);
  });

  it('should treat two prereleases with same core as equal (no deep prerelease ordering)', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.2')).toBe(0);
  });

  it('should compare prerelease against lower release correctly', () => {
    expect(compareVersions('2.0.0-rc.1', '1.9.9')).toBe(1);
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
    mockedExecSync.mockResolvedValue({ stdout: '99.0.0\n', stderr: '' });

    const result = await checkForUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['view', 'version']),
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
    mockedExecSync.mockResolvedValue({ stdout: `${current}\n`, stderr: '' });

    const result = await checkForUpdate({ force: true });

    expect(result.available).toBe(false);
    expect(result.current).toBe(current);
    expect(result.latest).toBe(current);
  });

  // ─── Test #6: Newer version available ─────────────────

  it('should report update available when newer version exists', async () => {
    mockedExecSync.mockResolvedValue({ stdout: '99.0.0\n', stderr: '' });

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
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' }) // npm view
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // npm install
      .mockResolvedValueOnce({ stdout: '', stderr: '' });         // teamai hooks inject --silent

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['install', '-g']),
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
    mockedExecSync.mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' });

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
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

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
    mockedExecSync.mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' });

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedLog.debug).toHaveBeenCalledWith(
      expect.stringContaining('skip'),
    );
  });

  // ─── Test: team-level autoUpdate=false with no local override → skip ───

  it('should skip update when team autoUpdate=false and local updatePolicy is undefined', async () => {
    mockedLoadLocalConfig.mockResolvedValue({
      repo: { localPath: '/tmp/repo', remote: 'https://...' },
      username: 'testuser',
      // no updatePolicy — this is the new optional-field world
    });
    mockedLoadTeamConfig.mockResolvedValue({
      team: 'test',
      repo: 'https://...',
      autoUpdate: false,
    });
    mockedExecSync.mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' });  // the version check call

    await doUpdate();

    // Only the version-check exec ran; no npm install
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['install']),
      expect.anything(),
    );
    expect(mockedLog.debug).toHaveBeenCalledWith(
      expect.stringContaining('team policy'),
    );
  });

  // ─── Test: local updatePolicy beats team autoUpdate ───

  it('should install when local updatePolicy=auto overrides team autoUpdate=false', async () => {
    mockedFse.pathExists.mockResolvedValue(false);
    mockedLoadLocalConfig.mockResolvedValue({
      repo: { localPath: '/tmp/repo', remote: 'https://...' },
      username: 'testuser',
      updatePolicy: 'auto',
    });
    mockedLoadTeamConfig.mockResolvedValue({
      team: 'test',
      repo: 'https://...',
      autoUpdate: false,
    });
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })  // version check
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // npm install
      .mockResolvedValueOnce({ stdout: '', stderr: '' });         // hooks inject

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['install', '-g']),
      expect.any(Object),
    );
  });

  // ─── Test #11: File lock acquired, proceed ────────────

  it('should proceed with install when lock is acquired', async () => {
    mockedFse.pathExists.mockResolvedValue(false);
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await doUpdate();

    expect(mockedFse.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('update-lock'),
      expect.any(String),
      { flag: 'wx' },
    );
    expect(mockedLog.success).toHaveBeenCalled();
    expect(mockedFse.remove).toHaveBeenCalledWith(
      expect.stringContaining('update-lock'),
    );
  });

  // ─── Test #12: File lock busy (another process alive) ─

  it('should skip when lock is held by another live process', async () => {
    // Exclusive create fails (EEXIST) and the on-disk owner is a live process,
    // so acquireLock backs off rather than reclaiming.
    const eexist = new Error('EEXIST') as NodeJS.ErrnoException;
    eexist.code = 'EEXIST';
    mockedFse.writeFile.mockRejectedValue(eexist);
    mockedFse.readFile.mockResolvedValue(
      JSON.stringify({ pid: process.pid, owner: 'held', startedAt: 'x' }),
    );

    mockedExecSync.mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' });

    await doUpdate();

    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Another update is in progress'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  // ─── Test #13: npm install EACCES ─────────────────────

  it('should warn about permission denied on EACCES', async () => {
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })
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
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })
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
    mockedExecSync.mockResolvedValueOnce({ stdout: `${current}\n`, stderr: '' });

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
    mockedExecSync.mockResolvedValue({ stdout: '99.0.0\n', stderr: '' });

    const result = await checkForUpdate();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['view', 'version']),
      expect.any(Object),
    );
    expect(result.available).toBe(true);
  });
});

// ─── Test: update() entry point ─────────────────────────

describe('update', () => {
  it('should only check and print when --check is set', async () => {
    mockedExecSync.mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' });

    await update({ check: true });

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Update available'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('should print up to date when --check and no update', async () => {
    const current = getCurrentVersion();
    mockedExecSync.mockResolvedValueOnce({ stdout: `${current}\n`, stderr: '' });

    await update({ check: true });

    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining('Already up to date'),
    );
  });

  it('should run full update flow without --check', async () => {
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await update({});

    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedLog.success).toHaveBeenCalled();
  });
});

// ─── Hook refresh after update tests ────────────────────

describe('hook refresh after update', () => {
  const mockedEntry = resolveTeamaiEntryScript as Mock;

  it('should run the resolved entry with the current Node binary', async () => {
    // A .js entry cannot be spawned directly on Windows (no shebang/PATHEXT
    // resolution) — the running Node must be the executable.
    mockedEntry.mockReturnValue('/teamai/dist/index.js');
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' }) // npm view
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // npm install
      .mockResolvedValueOnce({ stdout: '', stderr: '' });         // hooks inject

    await doUpdate();

    expect(mockedExecSync).toHaveBeenCalledWith(
      process.execPath,
      ['/teamai/dist/index.js', 'hooks', 'inject', '--silent'],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Refreshed hooks'),
    );
  });

  it('should fall back to teamai from PATH when the entry cannot be resolved', async () => {
    mockedEntry.mockReturnValue(null);
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' }) // npm view
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // npm install
      .mockResolvedValueOnce({ stdout: '', stderr: '' });         // teamai hooks inject --silent

    await doUpdate();

    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Updated teamai to v99.0.0'),
    );
    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(mockedExecSync).toHaveBeenCalledWith(
      'teamai',
      ['hooks', 'inject', '--silent'],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(mockedLog.success).toHaveBeenCalledWith(
      expect.stringContaining('Refreshed hooks'),
    );
  });

  it('should silently skip hook refresh when spawn fails', async () => {
    mockedExecSync
      .mockResolvedValueOnce({ stdout: '99.0.0\n', stderr: '' }) // npm view
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // npm install
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
// Behavior-level tests against the fs-extra mock. True filesystem atomicity
// (the `wx` exclusive-create race) and owner semantics are exercised against a
// real temp dir in lock-atomic.test.ts.

function eexist(): NodeJS.ErrnoException {
  const e = new Error('EEXIST') as NodeJS.ErrnoException;
  e.code = 'EEXIST';
  return e;
}

describe('acquireLock', () => {
  it('acquires via an exclusive (wx) create when no lockfile exists', async () => {
    mockedFse.writeFile.mockResolvedValue(undefined);

    const result = await acquireLock('/tmp/test-lock');

    expect(result).toBe(true);
    const [pathArg, payloadArg, optsArg] = mockedFse.writeFile.mock.calls[0];
    expect(pathArg).toBe('/tmp/test-lock');
    expect(optsArg).toEqual({ flag: 'wx' });
    const parsed = JSON.parse(payloadArg as string);
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.owner).toBe('string');
    expect(parsed.owner.length).toBeGreaterThan(0);
  });

  it('reclaims a stale lock via an atomic rename-into-place', async () => {
    // The main lock's exclusive create always finds it present (a stale lock);
    // the sentinel and temp writes succeed. Reclaim completes by renaming the
    // fresh payload over the stale file. (Concurrency/atomicity is proven for
    // real in lock-atomic.test.ts.)
    mockedFse.writeFile.mockImplementation((p: string, _data: string, opts?: { flag?: string }) => {
      if (p === '/tmp/test-lock' && opts?.flag === 'wx') return Promise.reject(eexist());
      return Promise.resolve(undefined);
    });
    mockedFse.readFile.mockResolvedValue('99999999'); // dead pid → stale
    mockedFse.rename.mockResolvedValue(undefined);

    const result = await acquireLock('/tmp/test-lock');

    expect(result).toBe(true);
    expect(mockedFse.rename).toHaveBeenCalled(); // reclaimed by atomic replace
  });

  it('returns false when a live process holds the lock', async () => {
    mockedFse.writeFile.mockRejectedValue(eexist());
    // Our own PID is alive → process.kill(pid, 0) succeeds → not stale.
    mockedFse.readFile.mockResolvedValue(JSON.stringify({ pid: process.pid, owner: 'x' }));

    const result = await acquireLock('/tmp/test-lock');

    expect(result).toBe(false);
    expect(mockedFse.rename).not.toHaveBeenCalled();
  });
});

describe('releaseLock', () => {
  it('removes a lock this process owns', async () => {
    // Acquire so the in-process owner map records our token.
    mockedFse.writeFile.mockResolvedValue(undefined);
    await acquireLock('/tmp/owned-lock');
    const owner = JSON.parse(mockedFse.writeFile.mock.calls[0][1] as string).owner;
    mockedFse.readFile.mockResolvedValue(JSON.stringify({ pid: process.pid, owner }));

    await releaseLock('/tmp/owned-lock');

    expect(mockedFse.remove).toHaveBeenCalledWith('/tmp/owned-lock');
  });

  it('does NOT remove a lock now owned by another process', async () => {
    mockedFse.writeFile.mockResolvedValue(undefined);
    await acquireLock('/tmp/taken-lock');
    // On disk the owner token differs → another process reclaimed it after ours
    // went stale. We must leave it alone.
    mockedFse.readFile.mockResolvedValue(JSON.stringify({ pid: 12345, owner: 'someone-else' }));

    await releaseLock('/tmp/taken-lock');

    expect(mockedFse.remove).not.toHaveBeenCalled();
  });

  it('does NOT delete a lock this process never acquired (no owner token)', async () => {
    // Owner-verified release: with no recorded owner for this path, releaseLock
    // must not touch the file even if one exists on disk.
    mockedFse.readFile.mockResolvedValue(JSON.stringify({ pid: process.pid, owner: 'other' }));

    await releaseLock('/tmp/never-acquired-by-us');

    expect(mockedFse.remove).not.toHaveBeenCalled();
  });
});

// ─── Self-update resolvers (npm CLI + install prefix) ────

/** Temporarily replace process.execPath (read by resolveNpmCommand). */
function stubExecPath(value: string): () => void {
  const original = process.execPath;
  Object.defineProperty(process, 'execPath', { value, configurable: true });
  return () => Object.defineProperty(process, 'execPath', { value: original, configurable: true });
}

describe('resolveNpmCommand', () => {
  let restoreExecPath: () => void;
  let existsSpy: MockInstance<typeof fs.existsSync>;

  beforeEach(() => {
    existsSpy = vi.spyOn(fs, 'existsSync');
  });
  afterEach(() => {
    restoreExecPath();
    existsSpy.mockRestore();
  });

  it('resolves npm-cli.js flat next to node (bundled-runtime layout)', () => {
    restoreExecPath = stubExecPath(path.join('/runtime', 'node'));
    const npmCli = path.join('/runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    existsSpy.mockImplementation((p) => p === npmCli);

    expect(resolveNpmCommand()).toEqual({ cmd: path.join('/runtime', 'node'), args: [npmCli] });
  });

  it('resolves npm one level up from bin (canonical POSIX prefix layout)', () => {
    // Official tarball / Homebrew / nvm: <prefix>/bin/node + <prefix>/lib/node_modules/npm.
    restoreExecPath = stubExecPath(path.join('/usr', 'local', 'bin', 'node'));
    const npmCli = path.join('/usr', 'local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    // Candidate paths contain a literal '..' (path.join does not normalize) —
    // compare resolved forms, like the real filesystem would.
    existsSpy.mockImplementation((p) => path.resolve(String(p)) === path.resolve(npmCli));

    expect(resolveNpmCommand()).toEqual({ cmd: path.join('/usr', 'local', 'bin', 'node'), args: [npmCli] });
  });

  it('falls back to npm from PATH when no co-located npm-cli.js exists', () => {
    restoreExecPath = stubExecPath(path.join('/runtime', 'node'));
    existsSpy.mockReturnValue(false);

    expect(resolveNpmCommand()).toEqual({ cmd: 'npm', args: [] });
  });
});

describe('prefixFromEntryPath', () => {
  let existsSpy: MockInstance<typeof fs.existsSync>;

  beforeEach(() => {
    existsSpy = vi.spyOn(fs, 'existsSync');
  });
  afterEach(() => {
    existsSpy.mockRestore();
  });

  it('strips the POSIX lib/ nesting and hands npm the prefix it expects', () => {
    const entry = path.join('/usr', 'local', 'lib', 'node_modules', 'teamai-cli', 'dist', 'index.js');
    existsSpy.mockReturnValue(true);

    expect(prefixFromEntryPath(entry, true)).toBe(path.join('/usr', 'local'));
    // The sanity check must look under <prefix>/lib/node_modules/<pkg>.
    expect(existsSpy).toHaveBeenCalledWith(
      path.join('/usr', 'local', 'lib', 'node_modules', 'teamai-cli'),
    );
  });

  it('returns the slice before node_modules on Windows layouts', () => {
    const entry = path.join('C:', 'tools', 'node_modules', 'teamai-cli', 'dist', 'index.js');
    existsSpy.mockReturnValue(true);

    expect(prefixFromEntryPath(entry, false)).toBe(path.join('C:', 'tools'));
    expect(existsSpy).toHaveBeenCalledWith(path.join('C:', 'tools', 'node_modules', 'teamai-cli'));
  });

  it('keeps non-lib roots on POSIX (project-local installs)', () => {
    const entry = path.join('/home', 'u', 'proj', 'node_modules', 'teamai-cli', 'dist', 'index.js');
    existsSpy.mockReturnValue(true);

    expect(prefixFromEntryPath(entry, true)).toBe(path.join('/home', 'u', 'proj'));
  });

  it('returns null for paths outside an npm-managed layout', () => {
    existsSpy.mockReturnValue(true);

    expect(prefixFromEntryPath('/home/u/dev/teamai-cli/dist/index.js', true)).toBeNull();
  });

  it('returns null when the package dir is not under the derived prefix', () => {
    const entry = path.join('/usr', 'local', 'lib', 'node_modules', 'teamai-cli', 'dist', 'index.js');
    existsSpy.mockReturnValue(false);

    expect(prefixFromEntryPath(entry, true)).toBeNull();
  });
});
