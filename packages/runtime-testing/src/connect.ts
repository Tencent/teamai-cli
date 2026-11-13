import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { RUNTIME_PROTOCOL_ENV } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { signalChild } from '@teamai/shared/process-group';

const LineSchema = z.record(z.string(), z.json());

/** A line a runtime wrote, as JSON. */
export type Line = z.infer<typeof LineSchema>;

export interface Connection {
  child: ChildProcessWithoutNullStreams;
  send(request: Line): void;
  /** The first line the runtime wrote that `match` accepts and no earlier `next` took, waiting up to `ms` for it. */
  next(match: (line: Line) => boolean, ms?: number): Promise<Line>;
  /** Every line the runtime wrote, in order. */
  lines: Line[];
  stderr(): string;
  /** Ends the runtime's stdin, as teamai does when it is done, and waits for it to exit: 5 s, then it is killed. */
  close(): Promise<number | null>;
}

/**
 * Starts the runtime bundled at `executable` with exactly `env`, in `cwd`, as teamai starts one (with
 * `RUNTIME_PROTOCOL_ENV`, unless `env` gives it), and speaks protocol 1 to it as JSON lines.
 */
export function connectRuntime({ executable, env, cwd }: { executable: string; env: Record<string, string>; cwd?: string }): Connection {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [executable], { env: { [RUNTIME_PROTOCOL_ENV]: '1', ...env }, ...(cwd && { cwd }) });
  const lines: Line[] = [];
  const pending: Line[] = [];
  const waiters: Array<() => void> = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });

  // A failed read says so with the runtime's stderr, which a wait that times out names.
  readline.createInterface({ input: child.stdout }).on('error', (error) => { stderr += `\nreading its output failed: ${error.message}`; }).on('line', (text) => {
    const line = LineSchema.parse(JSON.parse(text));
    lines.push(line);
    pending.push(line);

    for (const wake of waiters.splice(0)) wake();
  });

  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => {
    resolve(code);

    for (const wake of waiters.splice(0)) wake();
  }));

  return {
    child,
    lines,
    send: (request) => { child.stdin.write(`${JSON.stringify(request)}\n`); },
    async next(match, ms = 10_000) {
      const deadline = Date.now() + ms;

      for (;;) {
        const index = pending.findIndex(match);
        const [found] = index === -1 ? [] : pending.splice(index, 1);

        if (found) return found;

        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`No matching line from the runtime. Lines: ${JSON.stringify(lines)}\nstderr: ${stderr}`);
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
      }
    },
    stderr: () => stderr,
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => signalChild(child, 'SIGKILL'), 5000);
      const code = await exited;
      clearTimeout(timer);

      return code;
    },
  };
}
