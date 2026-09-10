import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

// ─── Mock child_process / cross-spawn ──────────────────────────────────────
// vi.mock 会被 hoist 到文件顶部，factory 中不能引用外部 const/let 变量
// 改用 vi.fn() 内联，通过 vi.mocked(spawn) 在测试中动态设置行为

// callClaude 经 cross-spawn 启动 CLI：Windows 上 CLI 多为 npm 生成的 `.cmd` shim，
// Node 原生 spawn 无权直接执行（EINVAL），必须由 cross-spawn 经 cmd.exe 转义启动。
vi.mock('cross-spawn', () => ({
  default: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  // detectClaudeCli 探测绝对路径：POSIX 走 bash -lc，Windows 走 where。
  // 测试环境中返回伪路径，配合 existsSync mock 让探测成功并选中第一个候选 'claude'。
  // Windows 分支只接受可执行后缀（.exe/.cmd/.bat），因此伪路径需要按平台给出。
  execFileSync: vi.fn(() =>
    process.platform === 'win32' ? 'C:\\npm\\claude.cmd\n' : '/usr/local/bin/claude\n'
  ),
}));

// mock existsSync，使探测到的伪路径被视为存在
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

import spawn from 'cross-spawn';
import { execFileSync } from 'node:child_process';
import {
  callClaude,
  callClaudeParallel,
  pickWindowsCommand,
  resolveCliPath,
} from '../utils/ai-client.js';

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

// ─── pickWindowsCommand ────────────────────────────────────────────────────
// `where` 的输出解析是纯函数，因此在所有平台上都能回归（Windows 上的真实探测
// 由这些用例固定契约，不需要 Windows runner）。

describe('pickWindowsCommand', () => {
  it('npm 的 shim 三件套：跳过无扩展名的 POSIX shim，选中 .cmd', () => {
    // `where claude` 的真实输出顺序：无扩展名的 shim 排在最前
    const output = [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      '',
    ].join('\r\n');

    expect(pickWindowsCommand(output)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('原生安装的 .exe 优先于同名 .cmd（PATHEXT 优先级）', () => {
    const output = [
      'C:\\tools\\claude.cmd',
      'C:\\Program Files\\Claude\\claude.exe',
    ].join('\r\n');

    expect(pickWindowsCommand(output)).toBe('C:\\Program Files\\Claude\\claude.exe');
  });

  it('.bat 与 .exe 并存时选中 .exe', () => {
    const output = ['C:\\tools\\claude.bat', 'C:\\tools\\claude.exe'].join('\n');

    expect(pickWindowsCommand(output)).toBe('C:\\tools\\claude.exe');
  });

  it('忽略前后空白并把扩展名匹配视为大小写不敏感', () => {
    expect(pickWindowsCommand('  C:\\npm\\CLAUDE.CMD  \r\n')).toBe('C:\\npm\\CLAUDE.CMD');
  });

  it('只有无扩展名的 shim 时返回 null（CreateProcess 无法启动它）', () => {
    expect(pickWindowsCommand('C:\\npm\\claude\r\n')).toBeNull();
  });

  it('where 未找到任何匹配时返回 null', () => {
    expect(pickWindowsCommand('')).toBeNull();
    expect(pickWindowsCommand('\r\n \r\n')).toBeNull();
  });
});

// ─── resolveCliPath ────────────────────────────────────────────────────────
// platform 参数可注入，使 Windows 分支在 ubuntu / macos 的 CI 上也有覆盖。

/** execFileSync 是重载函数，vi.mocked 推不出返回值类型，这里取一个够用的视图。 */
const execFileSyncMock = vi.mocked(execFileSync) as unknown as {
  mock: { calls: unknown[][] };
  mockReturnValueOnce: (value: unknown) => void;
  mockImplementationOnce: (impl: () => never) => void;
};

describe('resolveCliPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('win32：走 where，返回 where 输出里可启动的那条路径', () => {
    execFileSyncMock.mockReturnValueOnce('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n');

    expect(resolveCliPath('claude', 'win32')).toBe('C:\\npm\\claude.cmd');
    expect(execFileSyncMock.mock.calls[0][0]).toBe('where');
    expect(execFileSyncMock.mock.calls[0][1]).toEqual(['claude']);
  });

  it('win32：只调用 where，不碰 bash / zsh / which', () => {
    execFileSyncMock.mockReturnValueOnce('C:\\npm\\claude.cmd\r\n');

    resolveCliPath('claude', 'win32');

    expect(execFileSyncMock.mock.calls.map((call) => call[0])).toEqual(['where']);
  });

  it('win32：where 未命中（退出码非 0）时返回 null', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('Command failed: where claude');
    });

    expect(resolveCliPath('claude', 'win32')).toBeNull();
  });

  it('win32：where 只给出无扩展名的 shim 时返回 null，避免 spawn EINVAL', () => {
    execFileSyncMock.mockReturnValueOnce('C:\\npm\\claude\r\n');

    expect(resolveCliPath('claude', 'win32')).toBeNull();
  });

  it('posix：优先使用 bash login shell 的结果', () => {
    execFileSyncMock.mockReturnValueOnce('/usr/local/bin/claude\n');

    expect(resolveCliPath('claude', 'linux')).toBe('/usr/local/bin/claude');
    expect(execFileSyncMock.mock.calls[0][0]).toBe('bash');
  });

  it('posix：bash 抛错时回退到 zsh', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('spawn bash ENOENT');
    });
    execFileSyncMock.mockReturnValueOnce('/opt/homebrew/bin/claude\n');

    expect(resolveCliPath('claude', 'darwin')).toBe('/opt/homebrew/bin/claude');
    expect(execFileSyncMock.mock.calls.map((call) => call[0])).toEqual(['bash', 'zsh']);
  });
});
