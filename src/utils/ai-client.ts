import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 白名单：允许探测的 CLI 名称，防止意外执行任意命令。 */
const ALLOWED_CLI_CANDIDATES = [
  'claude', 'claude-internal', 'codex', 'codex-internal', 'codebuddy', 'workbuddy', 'openclaw',
] as const;

/** CLI 探测超时（毫秒），防止 execFileSync 挂死。 */
const CLI_DETECT_TIMEOUT_MS = 5_000;

/** 默认 AI 调用超时时间（毫秒）。仓库初始化等大文档生成场景需要较长时间。 */
const DEFAULT_TIMEOUT_MS = 1200_000;

/** 默认并发数量上限。 */
const DEFAULT_CONCURRENCY = 3;

/** CLI 探测结果，包含命令名和绝对路径。 */
interface CliInfo {
  cmd: string;
  absPath: string;
}

/**
 * 按优先级探测可用的 AI CLI，返回命令名与绝对路径。
 *
 * 各 CLI 非交互调用语法不同：
 *   - claude / claude-internal / codebuddy / workbuddy / openclaw：`<cli> -p <prompt>`
 *   - codex / codex-internal：`<cli> exec <prompt>`
 *
 * 依次通过以下方式获取绝对路径，确保覆盖各类 shell 环境：
 *   1. `bash -lc command -v <cmd>` —— login shell，覆盖 ~/.nvm/ 等路径
 *   2. `zsh -lc command -v <cmd>`  —— macOS 默认 shell fallback
 *   3. `which <cmd>` —— 最终 fallback，使用 process.env.PATH 直接查找
 *
 * 探测顺序：`claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw`。
 * 结果缓存，进程生命周期内只探测一次。
 *
 * @returns 含 cmd 与 absPath 的 CliInfo 对象
 * @throws  所有候选均不可用时抛出 Error
 */
function detectClaudeCli(): CliInfo {
  const candidates = ALLOWED_CLI_CANDIDATES;

  for (const cmd of candidates) {
    // 策略 1：bash login shell（shell: false 是 execFileSync 默认行为，此处显式标注）
    try {
      const p = execFileSync('bash', ['-lc', `command -v ${cmd}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        timeout: CLI_DETECT_TIMEOUT_MS,
      }).trim();
      if (p && existsSync(p)) return { cmd, absPath: p };
    } catch {
      // 继续尝试下一策略
    }

    // 策略 2：zsh login shell（macOS 默认 shell / bash 不可用时）
    try {
      const p = execFileSync('zsh', ['-lc', `command -v ${cmd}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        timeout: CLI_DETECT_TIMEOUT_MS,
      }).trim();
      if (p && existsSync(p)) return { cmd, absPath: p };
    } catch {
      // 继续尝试下一策略
    }

    // 策略 3：which 命令（使用 process.env.PATH，覆盖 fish / CI 容器等环境）
    try {
      const p = execFileSync('which', [cmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        timeout: CLI_DETECT_TIMEOUT_MS,
      }).trim();
      if (p && existsSync(p)) return { cmd, absPath: p };
    } catch {
      // 此候选不可用，尝试下一个
    }
  }

  throw new Error(
    'AI CLI 不可用：请安装以下任意一个 CLI 工具：' +
    'claude / claude-internal / codex / codex-internal / codebuddy / workbuddy / openclaw'
  );
}

/**
 * 根据 CLI 类型构建非交互参数数组。
 *
 * 各 CLI 非交互调用语法：
 *   - codex / codex-internal：`exec <prompt>`
 *   - 其他（claude 系、codebuddy 等）：`-p <prompt>`
 *
 * @param cmd    CLI 命令名
 * @param prompt 传递给 CLI 的提示词
 * @returns      参数数组
 */
function buildCliArgs(cmd: string, prompt: string): string[] {
  if (cmd === 'codex' || cmd === 'codex-internal') {
    return ['exec', prompt];
  }
  return ['-p', prompt];
}

/** 缓存探测到的 CLI 信息，避免重复 execFileSync。 */
let _cliInfo: CliInfo | undefined;

/**
 * 通过子进程直接调用 AI CLI（claude/codex 等），返回 stdout 文本。
 *
 * 按 CLI 类型自动选择 -p 或 exec 子命令，直接 spawn 绝对路径，不走 bash -lc，彻底消除 shell 拼接。
 * CLI 探测优先级：`claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw`，
 * 结果缓存，进程内只探测一次。
 *
 * @param prompt   传递给 CLI 的提示词
 * @param opts     可选参数：timeout 超时毫秒数，默认 120000
 * @returns        CLI 输出的 stdout（已 trim）
 * @throws         超时时抛出 `Error('AI call timed out after Xs')`
 * @throws         退出码非 0 时抛出 `Error('AI call failed: <stderr>')`
 * @throws         所有候选 CLI 均不可用时抛出 Error
 */
export async function callClaude(
  prompt: string,
  opts?: { timeout?: number }
): Promise<string> {
  const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    if (_cliInfo === undefined) {
      _cliInfo = detectClaudeCli();
    }
    const child = spawn(_cliInfo.absPath, buildCliArgs(_cliInfo.cmd, prompt), { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    // 超时控制
    const timer = setTimeout(() => {
      child.kill();
      const seconds = Math.round(timeoutMs / 1000);
      reject(new Error(`AI call timed out after ${seconds}s`));
    }, timeoutMs);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
        reject(new Error(`AI call failed: ${stderr}`));
        return;
      }
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      resolve(stdout);
    });
  });
}

/**
 * 并发调用 Claude CLI 处理多个任务，保持输入顺序返回结果。
 *
 * 使用信号量控制并发上限，不引入外部依赖。
 * 采用 Promise.allSettled 语义：某个 task 失败不中断其他 task；
 * 若存在任何失败，最终抛出 AggregateError。
 *
 * @param tasks        任务列表，每项包含 prompt 和解析函数 parse
 * @param concurrency  最大并发数，默认 3
 * @returns            按输入顺序排列的解析结果数组
 * @throws             若有任意 task 失败，抛出 AggregateError
 */
export async function callClaudeParallel<T>(
  tasks: Array<{ prompt: string; parse: (output: string) => T }>,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<T[]> {
  const results = await runWithConcurrency(tasks, concurrency);

  const errors: unknown[] = [];
  const values: T[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      values.push(result.value);
    } else {
      errors.push(result.reason);
      // 占位，保持数组长度与输入一致（后续不使用此位置）
      values.push(undefined as unknown as T);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} AI task(s) failed`);
  }

  return values;
}

/**
 * 使用信号量并发控制运行任务列表，返回 PromiseSettledResult 数组。
 *
 * @param tasks        任务列表
 * @param concurrency  最大并发数
 * @returns            按输入顺序的 PromiseSettledResult 数组
 */
async function runWithConcurrency<T>(
  tasks: Array<{ prompt: string; parse: (output: string) => T }>,
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let running = 0;
  let index = 0;

  // 等待队列：每个元素是一个 resolve 回调，用于唤醒等待中的 slot
  const waitQueue: Array<() => void> = [];

  /**
   * 获取一个并发 slot：若当前 running < concurrency 则立即获得；
   * 否则将自身挂入等待队列，直到有 slot 释放。
   */
  async function acquireSlot(): Promise<void> {
    if (running < concurrency) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve));
    running++;
  }

  /**
   * 释放一个并发 slot，并唤醒队列中第一个等待者。
   */
  function releaseSlot(): void {
    running--;
    const next = waitQueue.shift();
    if (next !== undefined) {
      next();
    }
  }

  /**
   * 执行单个任务，将结果写入 results[taskIndex]。
   */
  async function runTask(taskIndex: number): Promise<void> {
    await acquireSlot();
    try {
      const task = tasks[taskIndex];
      const output = await callClaude(task.prompt);
      const parsed = task.parse(output);
      results[taskIndex] = { status: 'fulfilled', value: parsed };
    } catch (err: unknown) {
      results[taskIndex] = { status: 'rejected', reason: err };
    } finally {
      releaseSlot();
    }
  }

  // 启动所有任务（acquireSlot 内部会阻塞超出并发限制的任务）
  const promises: Promise<void>[] = [];
  while (index < tasks.length) {
    promises.push(runTask(index));
    index++;
  }

  await Promise.all(promises);
  return results;
}
