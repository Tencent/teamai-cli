import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────
// The resolver shells out (`where` on Windows, `bash -lc` / `which` elsewhere)
// and then checks that the result exists. Both are mocked so the cases behave
// identically on every runner — CI only runs ubuntu / macos, which is exactly
// how this class of defect stays invisible.

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Both wrappers launch through cross-spawn: a resolved `.cmd` shim (npm's only
// Windows entry point for cnb) cannot be spawned directly. gh normally ships as
// a native `gh.exe`, but `pickWindowsCommand` accepts `.cmd` as well, so the
// launcher has to be able to run what the resolver may return.
vi.mock('cross-spawn', () => ({
  default: Object.assign(vi.fn(), { sync: vi.fn() }),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import crossSpawn from 'cross-spawn';
import { pickWindowsCommand, resolveCliPath } from '../utils/cli-path.js';
import { ghExec, isGhInstalled } from '../providers/github/gh-cli.js';
import { cnbExec, isCnbInstalled } from '../providers/cnb/cnb-cli.js';

const mockedExecFileSync = execFileSync as Mock;
const mockedExistsSync = existsSync as Mock;
const mockedCrossSpawnSync = crossSpawn.sync as unknown as Mock;

const GH_EXE = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const CNB_SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\cnb.cmd';

/**
 * Every CLI wrapper must launch the path `resolveCliPath` returns instead of the
 * bare command name. On Windows `which <cmd>` prints an MSYS path
 * (`/c/Program Files/GitHub CLI/gh`) which Node turns into
 * `C:\c\Program Files\...` — spawn answers ENOENT, and a bare name is no better
 * for npm-installed tools, whose only launchable entry is a `.cmd` shim.
 */
describe('resolveCliPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it('uses `where` on Windows and returns a launchable path', () => {
    mockedExecFileSync.mockReturnValue(`${GH_EXE}\r\n`);
    expect(resolveCliPath('gh', 'win32')).toBe(GH_EXE);
    expect(mockedExecFileSync).toHaveBeenCalledWith('where', ['gh'], expect.anything());
  });

  it('rejects the MSYS path `which` prints on Windows', () => {
    // The exact string the old `execSync('which gh')` handed to spawnSync.
    expect(pickWindowsCommand('/c/Program Files/GitHub CLI/gh')).toBeNull();
  });

  it('prefers a real executable over the extension-less shim listed first', () => {
    const out = 'C:\\npm\\gh\r\nC:\\npm\\gh.cmd\r\nC:\\npm\\gh.ps1\r\n';
    expect(pickWindowsCommand(out)).toBe('C:\\npm\\gh.cmd');
  });

  it('falls through bash → zsh on POSIX', () => {
    mockedExecFileSync
      .mockImplementationOnce(() => { throw new Error('no bash'); })
      .mockImplementationOnce(() => '/opt/homebrew/bin/gh\n');
    expect(resolveCliPath('gh', 'darwin')).toBe('/opt/homebrew/bin/gh');
  });

  it('returns null when the tool is absent', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(resolveCliPath('gh', 'win32')).toBeNull();
    expect(resolveCliPath('gh', 'linux')).toBeNull();
  });

  it('returns null when the resolved path does not exist', () => {
    mockedExecFileSync.mockReturnValue('/usr/local/bin/gh\n');
    mockedExistsSync.mockReturnValue(false);
    expect(resolveCliPath('gh', 'linux')).toBeNull();
  });
});

describe('gh-cli launches the resolved executable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCrossSpawnSync.mockReturnValue({ status: 0, stdout: 'gh version 2.0.0\n', stderr: '' });
  });

  it('starts the resolved path through cross-spawn', () => {
    mockedExecFileSync.mockReturnValue(`${GH_EXE}\r\n`);
    const r = ghExec(['--version']);
    expect(mockedCrossSpawnSync).toHaveBeenCalledWith(GH_EXE, ['--version'], expect.anything());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('gh version 2.0.0');
  });

  it('forwards inheritStdio through cross-spawn', () => {
    mockedExecFileSync.mockReturnValue(`${GH_EXE}\r\n`);
    ghExec(['auth', 'status'], { inheritStdio: true });
    expect(mockedCrossSpawnSync).toHaveBeenCalledWith(
      GH_EXE, ['auth', 'status'], expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('reports gh as installed exactly when the resolver finds it', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('missing'); });
    expect(isGhInstalled()).toBe(false);

    mockedExecFileSync.mockReturnValue(`${GH_EXE}\r\n`);
    expect(isGhInstalled()).toBe(true);
  });
});

describe('cnb-cli launches the resolved executable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCrossSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('starts the resolved .cmd shim through cross-spawn', () => {
    mockedExecFileSync.mockReturnValue(`${CNB_SHIM}\r\n`);
    cnbExec(['status']);
    expect(mockedCrossSpawnSync).toHaveBeenCalledWith(CNB_SHIM, ['status'], expect.anything());
  });

  it('forwards inheritStdio through cross-spawn', () => {
    mockedExecFileSync.mockReturnValue(`${CNB_SHIM}\r\n`);
    cnbExec(['login'], { inheritStdio: true });
    expect(mockedCrossSpawnSync).toHaveBeenCalledWith(
      CNB_SHIM, ['login'], expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('returns 127 with an explicit message rather than a bare status 1', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('missing'); });
    const r = cnbExec(['status']);
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/not found on PATH/);
    expect(mockedCrossSpawnSync).not.toHaveBeenCalled();
  });

  it('isCnbInstalled follows the resolver', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('missing'); });
    expect(isCnbInstalled()).toBe(false);

    mockedExecFileSync.mockReturnValue(`${CNB_SHIM}\r\n`);
    expect(isCnbInstalled()).toBe(true);
  });
});
