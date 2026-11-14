import { spawn } from 'node:child_process';
import { commandShell } from '../command-shell.js';
import { recordGroup, stopProcess } from '@teamai/shared/process-group';
import { MAX_TIMER_MS } from '@teamai/shared/timer';

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

/** The exit code a shell gives a command it stopped on SIGINT, which a step stopped before its end reports. */
export const STOPPED_EXIT_CODE = 130;

/** The argv a command step runs as: its command in the shell, as the local loop runs one. */
export function shellArgv(command: string): string[] {
  return process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
}

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
  const child = spawn(command, { cwd, ...commandShell(env), windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const timer = remaining === undefined || remaining > MAX_TIMER_MS
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

/** What a command `startGroupedCommand` ran left: its status, its stdout and stderr, and both together as they came. */
export interface GroupedCommandExit {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** A shell command a driver started. */
export interface GroupedCommand {
  /** Settles once the command exited and closed its output. */
  exit: Promise<GroupedCommandExit>;
  /** Stops the command and what it started, then settles once they are gone. A second call changes nothing. */
  stop: (signal?: NodeJS.Signals) => Promise<GroupedCommandExit>;
}

/**
 * Starts shell `command` with its stdin closed. A `detached` command leads a process group of its own; an attached one
 * shares its starter's. Either is recorded in `group` for `stopRecordedGroup`, so a stop reaches everything it started
 * even after its starter died. A command that cannot be spawned exits 127, the shell's status for a command it cannot
 * run, with the error at the end of its stderr.
 */
export function startGroupedCommand(input: { command: string; cwd: string; env: NodeJS.ProcessEnv; detached: boolean; group: string; onStderr?: (chunk: string) => void }): GroupedCommand {
  const { command, cwd, env, detached, group, onStderr } = input;
  const child = spawn(command, { ...commandShell(env), cwd, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  recordGroup(child, group, { isAttached: !detached });

  const exit = new Promise<GroupedCommandExit>((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; output += chunk; onStderr?.(chunk); });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, output }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr, output }));
  });

  return { exit, stop: stopProcess(child, exit, detached) };
}
