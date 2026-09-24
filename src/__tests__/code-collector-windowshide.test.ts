import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';

// code-collector.ts reaches git through node:child_process and only ever
// promisifies `execFile`, so replacing that one export is enough for the rest
// of the import graph to initialise as usual.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'node:child_process';
import {
  gitCommit,
  gitDiffNameStatus,
  isWorkingTreeClean,
} from '../wiki-engine/code-knowledge/code-collector.js';

/** Answer every git call with fixed output: these tests are about how the child
 * is started, not about what git prints. */
function answerEveryCall(stdout = ''): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      (
        callback as (error: null, result: { stdout: string; stderr: string }) => void
      )(null, { stdout, stderr: '' });
    }
    return undefined as never;
  }) as never);
}

describe('code-collector git helpers — windowsHide', () => {
  // A parent with no console of its own — a GUI or hook host — makes Windows
  // give each git child a console of its own, which flashes a visible window
  // on every scan. A repo-wide audit of a real CLI run caught these three; CI
  // has no Windows runner, so the option is the only guard available.
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    answerEveryCall();
  });

  it('starts every git child so it cannot open a console window on Windows', async () => {
    await gitCommit('/repo');
    await isWorkingTreeClean('/repo');
    await gitDiffNameStatus('/repo', 'old-sha', 'new-sha');

    // rev-parse HEAD, status --porcelain, diff --name-status
    expect(vi.mocked(execFile).mock.calls.length).toBe(3);
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe('git');
      // `promisify` appends its callback last, so the options object is third
      // when it is passed at all — and a bare 2-argument call leaves the
      // callback in this slot, which `typeof` distinguishes.
      expect(typeof call[2]).toBe('object');
      expect((call[2] as ExecFileOptions).windowsHide).toBe(true);
    }
  });
});
