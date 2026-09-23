import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyNonInteractiveGitEnv } from '../utils/git-env.js';

/**
 * Issue #711: a clone that stops to ask for a credential hangs an unattended
 * run until git's timeout, with nothing on stdout to say why. `GIT_TERMINAL_
 * PROMPT=0` closes only git's own terminal prompt; the askpass chain and Git
 * Credential Manager each open their own, so all three are closed together.
 */
const VARS = ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GCM_INTERACTIVE'] as const;

describe('applyNonInteractiveGitEnv', () => {
  const originalIsTTY = process.stdin.isTTY;
  const saved = new Map<string, string | undefined>(
    [...VARS, 'GIT_SSH_COMMAND', 'CI', 'TEAMAI_NONINTERACTIVE'].map((k) => [k, process.env[k]]),
  );

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  beforeEach(() => {
    for (const k of saved.keys()) delete process.env[k];
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
    expect(process.env.GCM_INTERACTIVE).toBe('never');
  });

  it('applies on a pseudo-terminal under CI, where nobody is watching either', () => {
    setTTY(true);
    process.env.CI = 'true';
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(process.env.GIT_ASKPASS).toBe('echo');
  });

  it('changes nothing for a person at a terminal, who can use their credential helper', () => {
    setTTY(true);
    applyNonInteractiveGitEnv();
    for (const name of VARS) expect(process.env[name]).toBeUndefined();
  });

  it('keeps an explicit value from the caller, variable by variable', () => {
    setTTY(false);
    process.env.GIT_TERMINAL_PROMPT = '1';
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('1');
    // The ones the caller said nothing about are still closed.
    expect(process.env.GIT_ASKPASS).toBe('echo');
    expect(process.env.GCM_INTERACTIVE).toBe('never');
  });

  // #713 review: GIT_SSH_COMMAND overrides core.sshCommand for every later git
  // operation, so a process-wide value would push the launch directory's key or
  // wrapper onto the managed team repo — or suppress the one that repo
  // configured. Prompt suppression must not reach a repository's transport.
  it('never touches GIT_SSH_COMMAND, which would override a repository core.sshCommand', () => {
    setTTY(false);
    applyNonInteractiveGitEnv();
    expect(process.env.GIT_SSH_COMMAND).toBeUndefined();
  });
});
