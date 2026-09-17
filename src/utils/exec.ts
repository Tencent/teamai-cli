import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stream?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export const execCommand: CommandExecutor = (
  command,
  args,
  options = {},
) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    if (options.stream) process.stdout.write(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    if (options.stream) process.stderr.write(text);
  });

  const timer = setTimeout(() => {
    child.kill();
    finish(() => reject(new Error(
      `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`,
    )));
  }, timeoutMs);

  child.on('error', (error) => finish(() => reject(error)));
  child.on('close', (code) => finish(() => resolve({
    stdout,
    stderr,
    code: code ?? 1,
  })));
});

export async function probeBinary(
  binary: string,
  args: string[] = ['--version'],
  executor: CommandExecutor = execCommand,
): Promise<string> {
  try {
    const result = await executor(binary, args, { timeoutMs: 5_000 });
    if (result.code !== 0) return '';
    return (result.stdout || result.stderr).trim();
  } catch {
    return '';
  }
}

export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string): string => /^[a-zA-Z0-9_./:@=+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
  return [command, ...args.map(quote)].join(' ');
}

/**
 * Watch a child's output and hand back a reader for its last `maxChars`
 * characters. Detached workers report failure with a single log line, so they
 * keep a bounded tail rather than the whole stream: the reader collapses
 * whitespace (a multi-line error becomes one readable line) and reads whatever
 * has arrived by the time it is called.
 */
export function captureTail(child: ChildProcess, maxChars: number): () => string {
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-maxChars);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return () => output.trim().replace(/\s+/g, ' ').slice(-maxChars);
}
