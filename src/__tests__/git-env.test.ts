import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Issue #711: a clone that stops to ask for a credential hangs an unattended
 * run until git's timeout, with nothing on stdout to say why. `GIT_TERMINAL_
 * PROMPT=0` closes only git's own terminal prompt; the askpass chain, ssh and
 * Git Credential Manager each open their own, so all four are closed together.
 */
const VARS = ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GCM_INTERACTIVE'] as const;

// `core.sshCommand` is read with a real `git config` call; the tests drive that
// read instead of depending on whatever this machine has configured.
const mockSpawnSync = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

const { applyNonInteractiveGitEnv } = await import('../utils/git-env.js');

/** What `git config --get core.sshCommand` returns for this test. */
function gitConfigReturns(value: string | null): void {
  mockSpawnSync.mockReturnValue(
    value === null ? { status: 1, stdout: '' } : { status: 0, stdout: `${value}\n` },
  );
}

describe('applyNonInteractiveGitEnv', () => {
  const originalIsTTY = process.stdin.isTTY;
  const saved = new Map<string, string | undefined>(
    [...VARS, 'CI', 'TEAMAI_NONINTERACTIVE'].map((k) => [k, process.env[k]]),
  );

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  beforeEach(() => {
    for (const k of saved.keys()) delete process.env[k];
    mockSpawnSync.mockReset();
    gitConfigReturns(null);
  });

  afterEach(() => {
    setTTY(originalIsTTY as boolean);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('closes every prompt a git child could open when there is no terminal', () => {
    setTTY(false);
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(process.env.GIT_ASKPASS).toBe('echo');
    expect(process.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(process.env.GCM_INTERACTIVE).toBe('never');
  });

  it('applies on a pseudo-terminal under CI, where nobody is watching either', () => {
    setTTY(true);
    process.env.CI = 'true';
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(process.env.GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
  });

  it('changes nothing for a person at a terminal, who can use their credential helper', () => {
    setTTY(true);
    applyNonInteractiveGitEnv();
    for (const name of VARS) expect(process.env[name]).toBeUndefined();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('keeps an explicit value from the caller, variable by variable', () => {
    setTTY(false);
    process.env.GIT_TERMINAL_PROMPT = '1';
    process.env.GIT_SSH_COMMAND = 'ssh -i /keys/ci';
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('1');
    expect(process.env.GIT_SSH_COMMAND).toBe('ssh -i /keys/ci');
    // Nothing to compose against, so the config read never happens either.
    expect(mockSpawnSync).not.toHaveBeenCalled();
    // The ones the caller said nothing about are still closed.
    expect(process.env.GIT_ASKPASS).toBe('echo');
    expect(process.env.GCM_INTERACTIVE).toBe('never');
  });

  // #713 review: GIT_SSH_COMMAND replaces core.sshCommand instead of extending
  // it, so a setup pointing git at a custom key, binary or wrapper would lose
  // it and fail to authenticate at all. Batch mode is appended to it instead.
  it('appends batch mode to a configured core.sshCommand instead of replacing it', () => {
    setTTY(false);
    gitConfigReturns('ssh -i ~/.ssh/deploy_key -F /etc/ssh/ci_config');
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_SSH_COMMAND).toBe(
      'ssh -i ~/.ssh/deploy_key -F /etc/ssh/ci_config -o BatchMode=yes',
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'git',
      ['config', '--get', 'core.sshCommand'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('leaves a configured command that already decides BatchMode untouched', () => {
    setTTY(false);
    gitConfigReturns('ssh -o BatchMode=no');
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=no');
  });

  it('falls back to plain ssh when the config read fails or finds nothing', () => {
    setTTY(false);
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn git ENOENT');
    });
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });
});
