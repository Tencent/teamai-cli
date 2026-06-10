import { spawn, execFileSync } from 'node:child_process';

/** 默认 AI 调用超时时间（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 默认并发数量上限。 */
const DEFAULT_CONCURRENCY = 3;

/**
 * 用单引号包裹字符串以在 shell 中安全传递。
 * 内部的单引号用 '\'' 序列转义。
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * 按优先级探测可用的 AI CLI 可执行文件名。
 *
 * 通过 `bash -lc` 以 login shell 方式运行探测命令，确保 ~/.nvm/ 等路径下的 CLI 均可被发现。
 * 探测顺序：`claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw`。
 * 结果缓存，进程生命周期内只探测一次。
 *
 * @returns 可用的 CLI 命令名
 * @throws  所有候选均不可用时抛出 Error
 */
function detectClaudeCli(): string {
  for (const cmd of ['claude', 'claude-internal', 'codex', 'codex-internal', 'codebuddy', 'workbuddy', 'openclaw']) {
    try {
      execFileSync('bash', ['-lc', `${cmd} --version`], { stdio: 'ignore' });
      return cmd;
    } catch {
      // 继续尝试下一个
    }
  }
  throw new Error(
    'AI CLI 不可用：请安装以下任意一个 CLI 工具：' +
    'claude / claude-internal / codex / codex-internal / codebuddy / workbuddy / openclaw'
  );
}

/** 缓存探测到的 CLI 命令名，避免重复 execFileSync。 */
let _claudeCmd: string | undefined;

/**
 * 通过 `bash -lc` 调用 AI CLI（`claude -p` 或其他已探测到的 CLI），返回 stdout 文本。
 *
 * 使用 `bash -lc` 确保 login shell PATH 生效，从而能访问 ~/.nvm/ 等路径下安装的 CLI。
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

    if (_claudeCmd === undefined) {
      _claudeCmd = detectClaudeCli();
    }
    const child = spawn('bash', ['-lc', `${_claudeCmd} -p ${shellEscape(prompt)}`], { stdio: ['ignore', 'pipe', 'pipe'] });

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
