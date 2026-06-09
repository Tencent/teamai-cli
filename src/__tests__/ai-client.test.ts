import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

// ─── Mock child_process ────────────────────────────────────────────────────
// vi.mock 会被 hoist 到文件顶部，factory 中不能引用外部 const/let 变量
// 改用 vi.fn() 内联，通过 vi.mocked(spawn) 在测试中动态设置行为

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { callClaude, callClaudeParallel } from '../utils/ai-client.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface MockProcess {
  stdout: EventEmitter & { on: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockProcess(): MockProcess {
  const stdoutListeners: Record<string, (chunk: Buffer) => void> = {};
  const stderrListeners: Record<string, (chunk: Buffer) => void> = {};
  const processListeners: Record<string, (...args: unknown[]) => void> = {};

  const proc: MockProcess = {
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        stdoutListeners[event] = cb;
      }),
    } as unknown as MockProcess['stdout'],
    stderr: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        stderrListeners[event] = cb;
      }),
    } as unknown as MockProcess['stderr'],
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      processListeners[event] = cb;
    }),
    kill: vi.fn(),
  };

  (proc as unknown as Record<string, unknown>)._emit = {
    stdout: (chunk: Buffer) => stdoutListeners['data']?.(chunk),
    stderr: (chunk: Buffer) => stderrListeners['data']?.(chunk),
    close: (code: number | null) => processListeners['close']?.(code),
    error: (err: Error) => processListeners['error']?.(err),
  };

  return proc;
}

// ─── callClaude ────────────────────────────────────────────────────────────

describe('callClaude', () => {
  let proc: MockProcess;
  let emitters: {
    stdout: (chunk: Buffer) => void;
    stderr: (chunk: Buffer) => void;
    close: (code: number | null) => void;
    error: (err: Error) => void;
  };

  beforeEach(() => {
    proc = makeMockProcess();
    emitters = (proc as unknown as Record<string, unknown>)._emit as typeof emitters;
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('正常情况：stdout 输出 hello world，退出码 0，返回 trim 后字符串', async () => {
    const promise = callClaude('test prompt');

    emitters.stdout(Buffer.from('hello world'));
    emitters.close(0);

    const result = await promise;
    expect(result).toBe('hello world');
  });

  it('退出码非 0：stderr 有内容，抛出包含 AI call failed 的 Error', async () => {
    const promise = callClaude('test prompt');

    emitters.stderr(Buffer.from('something went wrong'));
    emitters.close(1);

    await expect(promise).rejects.toThrow('AI call failed');
  });

  it('超时：进程永不退出，在超时后抛出包含 timed out 的 Error', async () => {
    vi.useFakeTimers();

    const promise = callClaude('test prompt', { timeout: 100 });

    // 推进 100ms 触发超时
    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('timed out');
    expect(proc.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ─── callClaudeParallel ────────────────────────────────────────────────────

describe('callClaudeParallel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('正常情况：3 个 task，返回数组顺序与输入一致', async () => {
    const responses = ['result-A', 'result-B', 'result-C'];
    let callIndex = 0;

    // 直接 mock spawn，每次调用顺序返回对应响应
    vi.mocked(spawn).mockImplementation(() => {
      const response = responses[callIndex++];
      const proc = makeMockProcess();
      const emitters = (proc as unknown as Record<string, unknown>)._emit as {
        stdout: (chunk: Buffer) => void;
        close: (code: number | null) => void;
      };
      // 在下一个微任务触发
      Promise.resolve().then(() => {
        emitters.stdout(Buffer.from(response));
        emitters.close(0);
      });
      return proc as unknown as ChildProcess;
    });

    const tasks = [
      { prompt: 'prompt-A', parse: (s: string) => s.toUpperCase() },
      { prompt: 'prompt-B', parse: (s: string) => s.toUpperCase() },
      { prompt: 'prompt-C', parse: (s: string) => s.toUpperCase() },
    ];

    const results = await callClaudeParallel(tasks, 3);

    expect(results).toEqual(['RESULT-A', 'RESULT-B', 'RESULT-C']);
  });

  it('并发限制：5 个 task，concurrency=2，同一时刻最多 2 个并发', async () => {
    let running = 0;
    let maxRunning = 0;

    vi.mocked(spawn).mockImplementation(() => {
      running++;
      if (running > maxRunning) maxRunning = running;

      const proc = makeMockProcess();
      const emitters = (proc as unknown as Record<string, unknown>)._emit as {
        stdout: (chunk: Buffer) => void;
        close: (code: number | null) => void;
      };

      // 立即完成，不阻塞
      Promise.resolve().then(() => {
        running--;
        emitters.stdout(Buffer.from('done'));
        emitters.close(0);
      });

      return proc as unknown as ChildProcess;
    });

    const tasks = Array.from({ length: 5 }, (_, i) => ({
      prompt: `prompt-${i}`,
      parse: (s: string) => s,
    }));

    await callClaudeParallel(tasks, 2);

    // 最大并发不超过 2
    expect(maxRunning).toBeLessThanOrEqual(2);
  });
});
