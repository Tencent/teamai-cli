import { spawn } from 'node:child_process';
import { stopProcess } from '../tool-launch/process-stop.js';

/** How a shell command this process ran ended. */
export type CommandExit =
  | { kind: 'exited'; code: number }
  | { kind: 'signal'; signal: NodeJS.Signals }
  /** `expiresAt` passed, and the process group was stopped. */
  | { kind: 'timeout' }
  /** The shell itself could not be spawned (the child's `error` event). */
  | { kind: 'spawn_failed'; message: string };

/** The last characters of a command's output it keeps. */
const OUTPUT_KEPT = 800;

/** The longest delay `setTimeout` honours. */
export const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Runs `command` through the platform shell in a process group of its own, so a stop reaches everything it started.
 * `signal` and `expiresAt` both stop the group: SIGTERM, then SIGKILL after five seconds. A deadline that already passed
 * never starts the command. `output` is the last characters it printed to stdout and stderr, as they arrived; with
 * `stderr: 'forward'`, its stderr also goes to this process's as it arrives, and `output` holds its stdout alone.
 * `errors` is the last characters it printed to stderr.
 */
export async function runShellCommand({ command, cwd, env, signal, expiresAt, stderr = 'keep' }: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  expiresAt?: string;
  stderr?: 'keep' | 'forward';
}): Promise<{ exit: CommandExit; output: string; errors: string }> {
  const remaining = expiresAt === undefined ? undefined : Math.max(0, Date.parse(expiresAt) - Date.now());
  if (remaining === 0) return { exit: { kind: 'timeout' }, output: '', errors: '' };
  const detached = process.platform !== 'win32';
  const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  const exited = new Promise<CommandExit>((resolve) => {
    const keep = (chunk: string): void => { output = (output + chunk).slice(-OUTPUT_KEPT); };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-OUTPUT_KEPT);
      if (stderr === 'forward') process.stderr.write(chunk);
      else keep(chunk);
    });
    child.on('error', (error) => resolve({ kind: 'spawn_failed', message: error.message }));
    child.on('close', (code, by) => resolve(by === null ? { kind: 'exited', code: code ?? 1 } : { kind: 'signal', signal: by }));
  });
  const stop = stopProcess(child, exited, detached);
  const onAbort = (): void => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let timedOut = false;
  // A longer delay fires at once, so a deadline that far away is left to the caller's own deadline handling.
  const timer = remaining === undefined || remaining > MAX_TIMER_DELAY
    ? undefined
    : setTimeout(() => { timedOut = true; void stop(); }, remaining);
  try {
    const exit = await exited;
    // Settles once the whole group is gone, so nothing the command started still runs.
    if (timedOut || signal?.aborted) await stop();
    return { exit: timedOut ? { kind: 'timeout' } : exit, output, errors };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
