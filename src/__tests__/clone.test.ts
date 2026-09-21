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

/** A `git` that always succeeds with no output: these tests are about how the
 * child is started, not about what it prints. */
function makeSilentProcess(): ChildProcess {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
      // runCommand only settles on 'close' / 'error', so emit it eagerly.
      if (event === 'close') void Promise.resolve().then(() => cb(0));
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
    vi.mocked(spawn).mockImplementation(() => makeSilentProcess());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
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
