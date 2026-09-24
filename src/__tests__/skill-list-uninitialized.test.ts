import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDetectInit, findUnreadableProjectConfig, logDim, logError, NotInitializedError } = vi.hoisted(() => ({
  autoDetectInit: vi.fn(),
  findUnreadableProjectConfig: vi.fn(),
  logDim: vi.fn(),
  logError: vi.fn(),
  NotInitializedError: class NotInitializedError extends Error {},
}));
vi.mock('../config.js', async (importOriginal) => ({
  autoDetectInit,
  findUnreadableProjectConfig,
  requireInit: vi.fn(),
  NotInitializedError,
  describeUnreadableConfig: (await importOriginal<typeof import('../config.js')>()).describeUnreadableConfig,
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn(), dim: logDim },
  setStderrOnly: vi.fn(() => false),
}));

import { skillList } from '../skill-cmd.js';

/**
 * `skill get` serves the packaged content on a machine with no team; the
 * human-readable `skill list` must let that machine discover it too, instead of
 * failing on the team listing it prints first.
 */
describe('teamai skill list before init', () => {
  let stdout: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    autoDetectInit.mockReset();
    // No project config under the test's cwd: detection goes on to autoDetectInit.
    findUnreadableProjectConfig.mockReset();
    findUnreadableProjectConfig.mockResolvedValue(null);
    logDim.mockReset();
    logError.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('prints the packaged catalog and says what to run for the rest', async () => {
    autoDetectInit.mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));

    await skillList({});

    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('=== BUILT-IN SKILLS (served by the CLI) ===');
    for (const name of ['core', 'setup', 'share', 'wiki']) {
      expect(stdout).toContain(`teamai skill get ${name}`);
    }
    expect(logDim).toHaveBeenCalledWith(expect.stringContaining('teamai init'));
  });

  it('reports a broken config instead of calling the machine uninitialized', async () => {
    // A config that exists but cannot be used is not "no team": telling the
    // member to run `teamai init` would send them to re-init over a real setup.
    autoDetectInit.mockRejectedValue(new Error('Team config (teamai.yaml) not found. Check your repo path.'));

    await skillList({});

    expect(process.exitCode).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Team config (teamai.yaml) not found'));
    expect(logDim).not.toHaveBeenCalledWith(expect.stringContaining('Not initialized'));
    // The packaged catalog needs no team, so it is still listed.
    expect(stdout).toContain('teamai skill get core');
  });

  it('loads the config once, so a broken one is reported once', async () => {
    autoDetectInit.mockRejectedValue(new Error('The teamai config at /h/.teamai/config.yaml could not be read: it is empty.'));

    await skillList({});

    expect(autoDetectInit).toHaveBeenCalledTimes(1);
  });

  it('does not list the team the user config names while the project config is unreadable', async () => {
    // Detection skips the broken project file and would answer with the user
    // config: another team's repo.
    findUnreadableProjectConfig.mockResolvedValue('/work/proj/.teamai/config.yaml: bad indentation');

    await skillList({});

    expect(autoDetectInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('/work/proj/.teamai/config.yaml: bad indentation'));
    expect(stdout).toContain('teamai skill get core');
  });
});
