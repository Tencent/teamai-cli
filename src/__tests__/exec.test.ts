import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// execCommand starts real child processes, so cross-spawn is mocked at the
// module boundary instead of letting a probe run for real.
vi.mock('cross-spawn', () => ({
  default: vi.fn(),
}));

import spawn from 'cross-spawn';
import { captureTail, execCommand } from '../utils/exec.js';

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

describe('captureTail', () => {
  const text = '会话标题 café 😀';
  const splitInside = (s: string, char: string): [Buffer, Buffer] => {
    const bytes = Buffer.from(s);
    const at = bytes.indexOf(Buffer.from(char)) + 1;
    return [bytes.subarray(0, at), bytes.subarray(at)];
  };

  it('captures output and collapses whitespace within maxChars', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 50);

    emit.stdout(Buffer.from('line 1\n  line 2\t\n'));
    emit.stderr(Buffer.from('line 3\n'));

    expect(readTail()).toBe('line 1 line 2 line 3');
  });

  it('bounds the captured output to the last maxChars', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 10);

    emit.stdout(Buffer.from('prefix text that exceeds the limit'));

    expect(readTail()).toBe('the limit');
  });

  it('preserves multi-byte UTF-8 characters split across stdout chunks', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 100);

    for (const chunk of splitInside(text, '标')) emit.stdout(chunk);

    expect(readTail()).toBe(text);
  });

  it('preserves multi-byte UTF-8 characters split across stderr chunks', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 100);

    for (const chunk of splitInside(text, '😀')) emit.stderr(chunk);

    expect(readTail()).toBe(text);
  });

  it('keeps stdout and stderr decoder state separate so interleaved chunks do not corrupt UTF-8', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 100);

    const [out1, out2] = splitInside('中文测试', '文');
    const [err1, err2] = splitInside('其他错误', '他');

    // Interleave partial byte chunks from both streams
    emit.stdout(out1);
    emit.stderr(err1);
    emit.stdout(out2);
    emit.stderr(err2);

    expect(readTail()).toBe('中其文测试他错误');
    expect(readTail()).not.toContain('\ufffd');
  });

  it('returns identical results when readTail is called multiple times', () => {
    const { proc, emit } = makeMockProcess();
    const readTail = captureTail(proc, 100);

    for (const chunk of splitInside(text, '标')) emit.stdout(chunk);

    const first = readTail();
    const second = readTail();
    expect(first).toBe(text);
    expect(second).toBe(text);
  });
});
