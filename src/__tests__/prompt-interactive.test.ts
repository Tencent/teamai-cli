import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isInteractive, askQuestion, askConfirmation, askSelection } from '../utils/prompt.js';

/**
 * `isInteractive` is the single predicate every prompt and every provider login
 * consults before waiting on a person (issue #711). A TTY alone must not count:
 * CI runners and cloud agent sandboxes often hand the CLI a pseudo-terminal
 * with nobody behind it.
 */
describe('isInteractive', () => {
  const originalIsTTY = process.stdin.isTTY;
  const saved = { CI: process.env.CI, TEAMAI_NONINTERACTIVE: process.env.TEAMAI_NONINTERACTIVE };

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.TEAMAI_NONINTERACTIVE;
  });

  afterEach(() => {
    setTTY(originalIsTTY as boolean);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is true on a TTY with neither variable set', () => {
    setTTY(true);
    expect(isInteractive()).toBe(true);
  });

  it('is false without a TTY, whatever the environment says', () => {
    setTTY(false);
    expect(isInteractive()).toBe(false);
  });

  it.each(['true', '1', 'yes'])('is false on a TTY when CI=%s', (v) => {
    setTTY(true);
    process.env.CI = v;
    expect(isInteractive()).toBe(false);
  });

  it('is false on a TTY when TEAMAI_NONINTERACTIVE is set', () => {
    setTTY(true);
    process.env.TEAMAI_NONINTERACTIVE = '1';
    expect(isInteractive()).toBe(false);
  });

  it.each(['', '0', 'false', 'FALSE'])('treats CI=%j as unset', (v) => {
    setTTY(true);
    process.env.CI = v;
    expect(isInteractive()).toBe(true);
  });

  it('makes every prompt take its default instead of waiting, on a TTY under CI', async () => {
    setTTY(true);
    process.env.CI = 'true';
    await expect(askQuestion('Team repo: ', 'org/repo')).resolves.toBe('org/repo');
    await expect(askQuestion('Team repo: ')).rejects.toThrow(/non-interactive/);
    await expect(askConfirmation('Overwrite? [y/N] ')).resolves.toBe(false);
    await expect(askConfirmation('Overwrite? [y/N] ', true)).resolves.toBe(true);
    await expect(askSelection('Pick: ', 3, true)).resolves.toEqual([0, 1, 2]);
    await expect(askSelection('Pick: ', 3)).resolves.toBeNull();
  });
});
