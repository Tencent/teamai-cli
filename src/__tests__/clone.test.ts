import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

// clone.ts runs `git` through node:child_process. Only `spawn` is replaced, so
// anything else in the import graph that destructures from this module still
// initialises as usual.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { shallowClone } from '../clone.js';

/** A `git` process that reports configured pipe chunks before its exit event. */
function makeProcess(
  code = 0,
  stdoutChunks: Buffer[] = [],
  stderrChunks: Buffer[] = [],
): ChildProcess {
  const stdoutListeners: Record<string, (chunk: Buffer) => void> = {};
  const stderrListeners: Record<string, (chunk: Buffer) => void> = {};
  return {
    stdout: { on: vi.fn((event: string, cb: (chunk: Buffer) => void) => { stdoutListeners[event] = cb; }) },
    stderr: { on: vi.fn((event: string, cb: (chunk: Buffer) => void) => { stderrListeners[event] = cb; }) },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      // runCommand only settles on 'close' / 'error', so emit it eagerly.
      if (event === 'close') void Promise.resolve().then(() => {
        stdoutChunks.forEach((chunk) => stdoutListeners.data?.(chunk));
        stderrChunks.forEach((chunk) => stderrListeners.data?.(chunk));
        cb(code);
      });
    }),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('shallowClone — windowsHide', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-clone-'));
    // keep the shared debug.log free of test noise
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => makeProcess());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps split UTF-8 clone errors intact', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => makeProcess(1, [], [
      Buffer.from([0xe4, 0xbd]),
      Buffer.from([0xa0, 0xe5, 0xa5, 0xbd]),
    ]));

    await expect(shallowClone(
      'https://example.com/org/repo.git',
      path.join(tmp, 'repo'),
      'git',
    )).rejects.toThrow('你好');
  });

  it('starts every git child so it cannot open a console window on Windows', async () => {
    const result = await shallowClone(
      'https://example.com/org/repo.git',
      path.join(tmp, 'repo'),
      'git',
    );

    // the clone itself, plus the rev-parse calls that resolve HEAD and branch
    expect(vi.mocked(spawn).mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of vi.mocked(spawn).mock.calls) {
      const [command, , options] = call as [string, string[], { windowsHide?: boolean }];
      expect(command).toBe('git');
      // CI has no Windows runner, so the option is the only available guard.
      expect(options.windowsHide).toBe(true);
    }
    expect(result.cloneMethod).toBe('https-anonymous');
  });
});
