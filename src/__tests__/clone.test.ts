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
import { getRepoCacheDir } from '../utils/repo-cache.js';
import { shallowClone, shallowFetch } from '../clone.js';

/** A `git` that always succeeds with no output: these tests are about how the
 * child is started, not about what it prints. */
function makeSilentProcess(result: number | Error = 0): ChildProcess {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
      // runCommand only settles on 'close' / 'error', so emit it eagerly.
      if (event === 'close' && typeof result === 'number') void Promise.resolve().then(() => cb(result));
      if (event === 'error' && result instanceof Error) void Promise.resolve().then(() => cb(result));
    }),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('shallowClone — windowsHide', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-clone-'));
    vi.stubEnv('TEAMAI_CACHE_DIR', tmp);
    // keep the shared debug.log free of test noise
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => makeSilentProcess());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

describe('shallowClone — split UTF-8 output', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-clone-'));
    vi.stubEnv('TEAMAI_CACHE_DIR', tmp);
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A `git` that writes `output` to stdout in two chunks split at `splitAt`. */
  function makeChunkedProcess(output: Buffer, splitAt: number): ChildProcess {
    let onData: ((chunk: Buffer) => void) | undefined;
    return {
      stdout: { on: vi.fn((_event: string, cb: (chunk: Buffer) => void) => { onData = cb; }) },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event !== 'close') return;
        void Promise.resolve().then(() => {
          onData?.(output.subarray(0, splitAt));
          onData?.(output.subarray(splitAt));
          cb(0);
        });
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess;
  }

  it('keeps a branch name whose character straddles two chunks intact', async () => {
    const branch = 'feature/会话';
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const output = args.includes('--abbrev-ref') ? `${branch}\n` : '0123456789abcdef\n';
      const bytes = Buffer.from(output);
      return makeChunkedProcess(bytes, bytes.indexOf(Buffer.from('会')) + 1);
    }) as unknown as typeof spawn);

    const result = await shallowClone('https://example.com/org/repo.git', path.join(tmp, 'repo'), 'git');

    expect(result.branch).toBe(branch);
  });
});

describe('shallowClone — cache cleanup boundaries', () => {
  let tmp: string;
  let cacheDir: string;
  let victimParent: string;
  let important: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-clone-boundary-')));
    vi.stubEnv('TEAMAI_CACHE_DIR', path.join(tmp, 'cache'));
    cacheDir = getRepoCacheDir('git', 'org', 'repo');
    fs.mkdirSync(cacheDir, { recursive: true });
    victimParent = path.join(tmp, 'outside');
    important = path.join(victimParent, 'repo', 'important.txt');
    fs.mkdirSync(path.dirname(important), { recursive: true });
    fs.writeFileSync(important, 'User data\n');
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => makeSilentProcess());
    vi.spyOn(log, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function replaceParentWithLink(): void {
    const parent = path.dirname(cacheDir);
    fs.renameSync(parent, path.join(tmp, 'original-parent'));
    fs.symlinkSync(victimParent, parent, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it('rechecks a parent replaced after the cache path was resolved', async () => {
    replaceParentWithLink();

    await expect(shallowClone('https://example.com/org/repo.git', cacheDir, 'git'))
      .rejects.toThrow('Path traversal detected');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(important, 'utf8')).toBe('User data\n');
  });

  it.each(['git failure', 'spawn error'])('rechecks the path before cleanup after a %s', async (failure) => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      replaceParentWithLink();
      return makeSilentProcess(failure === 'git failure' ? 128 : new Error('Spawn failed'));
    });

    await expect(shallowClone('https://example.com/org/repo.git', cacheDir, 'git'))
      .rejects.toThrow(failure === 'git failure' ? 'git clone failed' : 'Spawn failed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(important, 'utf8')).toBe('User data\n');
  });

  it('rechecks the path after fetching and before a destructive reset', async () => {
    vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
      if (args.includes('fetch')) replaceParentWithLink();
      return makeSilentProcess();
    }) as unknown as typeof spawn);

    await expect(shallowFetch(cacheDir, { provider: 'git' })).rejects.toThrow('Path traversal detected');
    expect(vi.mocked(spawn).mock.calls.some(([, args]) => Array.isArray(args) && args.includes('reset'))).toBe(false);
    expect(fs.readFileSync(important, 'utf8')).toBe('User data\n');
  });
});
