import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// execCommand starts real child processes, so cross-spawn is mocked at the
// module boundary instead of letting a probe run for real.
vi.mock('cross-spawn', () => ({
  default: vi.fn(),
}));

import spawn from 'cross-spawn';
import { execCommand } from '../utils/exec.js';

interface Emitters {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  close: (code: number | null) => void;
  error: (err: Error) => void;
}

function makeMockProcess(): { proc: ChildProcess; emit: Emitters } {
  const stdoutListeners: Record<string, (chunk: Buffer) => void> = {};
  const stderrListeners: Record<string, (chunk: Buffer) => void> = {};
  const processListeners: Record<string, (...args: unknown[]) => void> = {};

  const proc = {
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        stdoutListeners[event] = cb;
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        stderrListeners[event] = cb;
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      processListeners[event] = cb;
    }),
    kill: vi.fn(),
  } as unknown as ChildProcess;

  return {
    proc,
    emit: {
      stdout: (chunk: Buffer) => stdoutListeners['data']?.(chunk),
      stderr: (chunk: Buffer) => stderrListeners['data']?.(chunk),
      close: (code: number | null) => processListeners['close']?.(code),
      error: (err: Error) => processListeners['error']?.(err),
    },
  };
}

describe('execCommand', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves with the child stdout, stderr and exit code', async () => {
    const { proc, emit } = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);

    const promise = execCommand('teamai', ['--version']);
    emit.stdout(Buffer.from('0.24.0\n'));
    emit.close(0);

    await expect(promise).resolves.toEqual({ stdout: '0.24.0\n', stderr: '', code: 0 });
  });

  it('runs the child with stdio piped and no shell', async () => {
    const { proc, emit } = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);

    const promise = execCommand('teamai', ['--version']);
    emit.close(0);
    await promise;

    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as [
      string,
      string[],
      { shell?: boolean; stdio?: unknown },
    ];
    expect(command).toBe('teamai');
    expect(args).toEqual(['--version']);
    expect(options.shell).toBe(false);
  });

  it('starts the child so it cannot open a console window on Windows', async () => {
    const { proc, emit } = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);

    // probeBinary (CLI version detection) and the plugin lifecycle both run
    // through execCommand, and both are reachable from a hook whose host has
    // no console - exactly the case where Windows would give the child its own
    // visible window. CI has no Windows runner, so the option is the guard.
    const promise = execCommand('teamai', ['--version']);
    emit.close(0);
    await promise;

    const [, , options] = vi.mocked(spawn).mock.calls[0] as [
      string,
      string[],
      { windowsHide?: boolean },
    ];
    expect(options.windowsHide).toBe(true);
  });

  // Pipe reads split at byte offsets, so one character can arrive in two chunks.
  const text = '会话标题 café 😀';
  const splitInside = (s: string, char: string): [Buffer, Buffer] => {
    const bytes = Buffer.from(s);
    const at = bytes.indexOf(Buffer.from(char)) + 1;
    return [bytes.subarray(0, at), bytes.subarray(at)];
  };

  it('keeps a multi-byte character that straddles two chunks intact', async () => {
    const { proc, emit } = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);

    const promise = execCommand('opencode', ['session', 'list']);
    for (const chunk of splitInside(text, '标')) emit.stdout(chunk);
    for (const chunk of splitInside(text, '😀')) emit.stderr(chunk);
    emit.close(0);

    await expect(promise).resolves.toEqual({ stdout: text, stderr: text, code: 0 });
  });

  it('streams the split character intact when stream is set', async () => {
    const { proc, emit } = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const promise = execCommand('opencode', ['session', 'list'], { stream: true });
      for (const chunk of splitInside(text, 'é')) emit.stdout(chunk);
      for (const chunk of splitInside(text, '会')) emit.stderr(chunk);
      emit.close(0);
      await promise;

      expect(out.mock.calls.map(([chunk]) => chunk).join('')).toBe(text);
      expect(err.mock.calls.map(([chunk]) => chunk).join('')).toBe(text);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
