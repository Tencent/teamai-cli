import { spawn } from 'node:child_process';

/** 默认 AI 调用超时时间（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 默认并发数量上限。 */
const DEFAULT_CONCURRENCY = 3;

/**
 * 通过 `claude -p` 子进程调用 Claude CLI，返回 stdout 文本。
 *
 * @param prompt   传递给 claude 的提示词
 * @param opts     可选参数：timeout 超时毫秒数，默认 60000
 * @returns        claude 输出的 stdout（已 trim）
 * @throws         超时时抛出 `Error('AI call timed out after Xs')`
 * @throws         退出码非 0 时抛出 `Error('AI call failed: <stderr>')`
 */
export async function callClaude(
  prompt: string,
  opts?: { timeout?: number }
): Promise<string> {
  const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });

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
