/**
 * A workflow's `setup`, run by a driver in a workspace it just created, before the step. Both the local driver and a
 * driver that prepares workspaces for a session reach it through `stageLease`, so setup's key values stay in the teamai
 * process and never reach whatever runs the step.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProcess } from '../tool-launch/process-stop.js';
import { redact } from '../utils/redact.js';
import type { WorkflowFailure } from './types.js';
import { changedPaths, snapshotWorktree } from './worktree-snapshot.js';

export interface SetupRun {
  command: string;
  /** The workspace, after its base config and team assets are in place. */
  dir: string;
  /** The inherited environment without every withheld key, with the values of setup's own keys. */
  env: NodeJS.ProcessEnv;
  /** Setup's own keys, whose values `env` holds and no file setup leaves may hold. */
  keys: readonly string[];
  /** Stops setup's process group: SIGTERM, then SIGKILL after five seconds. */
  signal?: AbortSignal;
  /** The lease's deadline, which stops setup the same way for a caller that has no loop to cancel it. */
  expiresAt?: string;
}

/** The last characters of setup's output a failure quotes. */
const OUTPUT_TAIL = 400;

/** The longest delay `setTimeout` honours. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Runs setup and checks what it left. The step may start when this answers undefined. Otherwise, first match wins:
 * a non-zero exit is `setup_failed`; a change to a tracked or non-ignored path, which the step would commit, is
 * `setup_dirty`; a value of one of setup's keys in a file setup created or changed, ignored files included and `.git`
 * excluded, is `setup_secret`, naming the file and the key, never the value.
 */
export async function runSetup({ expiresAt, signal: caller, ...run }: SetupRun): Promise<WorkflowFailure | undefined> {
  const remaining = expiresAt === undefined ? undefined : Math.max(0, Date.parse(expiresAt) - Date.now());
  // A longer delay fires at once, so a deadline that far away is left to the caller's own deadline handling.
  if (remaining === undefined || remaining > MAX_TIMER_DELAY) return checkedSetup({ ...run, signal: caller });
  const bound = new AbortController();
  const stop = (): void => bound.abort();
  caller?.addEventListener('abort', stop, { once: true });
  if (caller?.aborted) stop();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, remaining);
  try {
    const failure = await checkedSetup({ ...run, signal: bound.signal });
    return timedOut
      ? { code: 'setup_failed', message: `Setup "${run.command}" did not finish before the step's timeout, so the step did not run. Make setup faster or raise the step's timeout, then retry the step.` }
      : failure;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', stop);
  }
}

async function checkedSetup({ command, dir, env, keys, signal }: Omit<SetupRun, 'expiresAt'>): Promise<WorkflowFailure | undefined> {
  const stopped: WorkflowFailure = { code: 'setup_failed', message: `Setup "${command}" was stopped, so the step did not run.` };
  if (signal?.aborted) return stopped;
  const tracked = await snapshotWorktree(dir);
  const stamps = await fileStamps(dir);
  // An abort while the workspace was read is not replayed to the listener `runCommand` adds.
  if (signal?.aborted) return stopped;
  const exit = await runCommand(command, dir, env, signal);
  if (signal?.aborted) return stopped;
  const values = keys.flatMap((key) => {
    const value = env[key];
    return value ? [{ key, value }] : [];
  });
  if (exit.code !== 0) {
    const envSecrets = Object.fromEntries(values.map(({ key, value }) => [key, value]));
    const tail = redact(exit.output.trim().slice(-OUTPUT_TAIL), { envSecrets, patterns: false });
    return { code: 'setup_failed', message: `Setup "${command}" exited with code ${exit.code}, so the step did not run.${tail ? ` It printed: ${tail}` : ''} Fix setup, then retry the step.` };
  }
  const dirty = changedPaths(tracked, await snapshotWorktree(dir));
  if (dirty.length > 0) {
    return { code: 'setup_dirty', message: `Setup "${command}" changed ${dirty.join(', ')}, which the step would commit, so the step did not run. Make setup write only files git ignores, then retry the step.` };
  }
  if (values.length === 0) return undefined;
  for (const [file, stamp] of await fileStamps(dir)) {
    const was = stamps.get(file);
    if (was && was.size === stamp.size && was.mtimeMs === stamp.mtimeMs) continue;
    const content = await fs.readFile(path.join(dir, file)).catch(() => undefined);
    const found = content && values.find(({ value }) => content.includes(value, 0, 'utf8'));
    if (found) {
      return { code: 'setup_secret', message: `Setup "${command}" left the value of ${found.key} in ${file}, where the step could read it, so the step did not run. Make setup remove the files it writes ${found.key} to, then retry the step.` };
    }
  }
  return undefined;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** Every regular file under `dir`, ignored ones included, by relative path. `.git` and symbolic links are not entered. */
async function fileStamps(dir: string): Promise<Map<string, FileStamp>> {
  const stamps = new Map<string, FileStamp>();
  const walk = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const stats = await fs.stat(path.join(dir, child)).catch(() => undefined);
        if (stats) stamps.set(child, { size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  };
  await walk('');
  return stamps;
}

/** Runs `command` in a process group of its own, so an abort stops everything it started. */
async function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<{ code: number; output: string }> {
  const detached = process.platform !== 'win32';
  const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<{ code: number; output: string }>((resolve) => {
    let output = '';
    const keep = (chunk: string): void => { output = (output + chunk).slice(-OUTPUT_TAIL * 2); };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
  const stop = stopProcess(child, exit, detached);
  const onAbort = (): void => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await exit;
    // Settles once the whole group is gone, so nothing setup started still writes to the workspace.
    if (signal?.aborted) await stop();
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
