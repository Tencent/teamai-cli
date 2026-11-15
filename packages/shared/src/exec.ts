import spawn from 'cross-spawn';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isBareCommandName, pickWindowsCommand } from './cli-path.js';
import { WIN_EXEC_EXTENSIONS } from './lookpath.js';
import { pathDirs } from './lookpath.js';
import { signalChild } from './process-group.js';

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
    windowsHide: true,
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

  // Pipe reads split at byte offsets, so a multi-byte character can straddle
  // two chunks; one decoder per stream carries the partial bytes across.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = stdoutDecoder.write(chunk);
    stdout += text;

    if (options.stream) process.stdout.write(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    stderr += text;

    if (options.stream) process.stderr.write(text);
  });

  const timer = setTimeout(() => {
    signalChild(child);
    finish(() => reject(new Error(
      `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`,
    )));
  }, timeoutMs);

  child.on('error', (error) => finish(() => reject(error)));
  child.on('close', (code) => finish(() => {
    const stdoutRest = stdoutDecoder.end();
    const stderrRest = stderrDecoder.end();

    if (options.stream) {
      process.stdout.write(stdoutRest);
      process.stderr.write(stderrRest);
    }

    resolve({
      stdout: stdout + stdoutRest,
      stderr: stderr + stderrRest,
      code: code ?? 1,
    });
  }));
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
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const append = (text: string) => {
    if (text) output = (output + text).slice(-maxChars);
  };

  child.stdout?.on('data', (chunk: Buffer) => append(stdoutDecoder.write(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => append(stderrDecoder.write(chunk)));

  return () => {
    append(stdoutDecoder.end());
    append(stderrDecoder.end());

    return output.trim().replace(/\s+/g, ' ').slice(-maxChars);
  };
}

/**
 * Detach one pipe stream without closing it: drop the listeners, keep it
 * draining, and unref the handle. Closing the read end instead would SIGPIPE
 * a child that keeps writing; detaching lets this process exit without
 * waiting on - or killing - that child.
 */
export function detachPipe(stream: Readable): void {
  stream.removeAllListeners('data');
  stream.resume();

  // A child's pipe is a socket; a stream that is not (a test double) has no handle to unref.
  if (stream instanceof Socket) stream.unref();
}

/**
 * Stop owning a child this process must neither wait on nor kill: unref the
 * child and detach any pipe streams it still shares with us, so the event
 * loop is free to exit and the child runs on as an orphan.
 */
export function detachChild(child: ChildProcess): void {
  child.unref();

  if (child.stdout) detachPipe(child.stdout);

  if (child.stderr) detachPipe(child.stderr);
}

/** The longest command line cmd.exe accepts. */
const CMD_MAX_COMMAND_LINE = 8191;

/** cmd.exe metacharacters, escaped with `^`: the set cross-spawn escapes. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

const escapeCmdMeta = (text: string): string => text.replace(CMD_META, '^$1');

/** One argument as cross-spawn writes it for a batch file: quoted for the program it starts, then `^`-escaped twice. */
function escapeBatchArgument(arg: string): string {
  const quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');

  return escapeCmdMeta(escapeCmdMeta(`"${quoted}"`));
}

/** How to start a batch file under cmd.exe, or why cmd.exe cannot carry its arguments. */
export type BatchLaunch =
  | { readonly ok: true; readonly command: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * How Windows starts the batch file `executable` (an npm `.cmd` shim, say) with `args`, or undefined when it is not a
 * batch file. Every argument is escaped for cmd.exe twice, because the shim's `%*` line is parsed again; cross-spawn
 * does that only for shims under node_modules/.bin, not for the global ones npm installs. cmd.exe ends a command line
 * at a newline and cuts one over 8191 characters, so such arguments are refused rather than silently shortened.
 */
export function batchLaunchOf(executable: string, args: readonly string[], comspec: string): BatchLaunch | undefined {
  if (!/\.(cmd|bat)$/i.test(executable)) return undefined;

  const file = executable.replaceAll('/', '\\');
  const name = file.split('\\').at(-1) ?? file;

  if (args.some((arg) => /[\r\n]/.test(arg))) {
    return { ok: false, message: `${name} is a batch file, which runs under cmd.exe, and cmd.exe cannot pass an argument containing a newline. Pass that text on stdin, or run the tool's .exe instead of its npm shim.` };
  }

  const line = [escapeCmdMeta(file), ...args.map(escapeBatchArgument)].join(' ');

  if (line.length > CMD_MAX_COMMAND_LINE) {
    return { ok: false, message: `The command line for ${name} is too long for cmd.exe: ${line.length} characters once escaped, over its ${CMD_MAX_COMMAND_LINE}-character limit. Pass long text on stdin, or run the tool's .exe instead of its npm shim.` };
  }

  // Delayed expansion off: a member who turned it on in the registry would otherwise see `!` change.
  return { ok: true, command: comspec, args: ['/d', '/v:off', '/s', '/c', `"${line}"`] };
}

/**
 * `executable` as the child's PATH finds it when it is a bare name, such as the `claude` a member types, else as given.
 * Only a launchable file counts: npm puts an extensionless sh shim beside `claude.cmd`, and cmd.exe cannot start it.
 */
function onChildPath(executable: string, env: NodeJS.ProcessEnv | undefined): string {
  if (!isBareCommandName(executable)) return executable;
  const pathEnv = env?.PATH ?? env?.Path ?? process.env.PATH;

  const found = pathDirs(pathEnv === undefined ? {} : { pathEnv })
    .flatMap((dir) => WIN_EXEC_EXTENSIONS.map((ext) => path.join(dir, executable + ext)))
    .filter((file) => existsSync(file));

  return pickWindowsCommand(found.join('\n')) ?? executable;
}

/** How `executable` starts here: under cmd.exe when it is a Windows batch file, or why cmd.exe cannot carry `args`. */
function windowsBatchOf(executable: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): BatchLaunch | undefined {
  const comspec = process.env.ComSpec ?? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`;

  return process.platform === 'win32' ? batchLaunchOf(onChildPath(executable, env), args, comspec) : undefined;
}

/**
 * Starts `executable` with `args`: on Windows, a batch file (an npm `.cmd` shim) under the system cmd.exe with its
 * arguments escaped as `batchLaunchOf` escapes them, anything else through cross-spawn. cmd.exe is found from this
 * process's environment by its absolute path, since the child's may hold no ComSpec and a bare name is looked up in the
 * cwd first. A bare `executable` is looked up on the child's PATH, so a shim the member names by its name is found.
 * Throws, as a failed spawn does, when cmd.exe cannot carry the arguments.
 */
export function spawnCommand(executable: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const batch = windowsBatchOf(executable, args, options.env);

  if (batch?.ok === false) throw new Error(batch.message);

  return batch ? nodeSpawn(batch.command, [...batch.args], { ...options, windowsVerbatimArguments: true }) : spawn(executable, [...args], options);
}

/**
 * Runs `executable` with `args` to its end, launched as `spawnCommand` launches it. When cmd.exe cannot carry the
 * arguments, it answers as a spawn that failed: no status, and the reason as `error` and `stderr`.
 */
export function spawnCommandSync(executable: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  const batch = windowsBatchOf(executable, args, options.env);

  if (batch?.ok === false) return { pid: 0, output: [], stdout: '', stderr: batch.message, status: null, signal: null, error: new Error(batch.message) };

  return batch ? nodeSpawnSync(batch.command, [...batch.args], { ...options, windowsVerbatimArguments: true }) : spawn.sync(executable, [...args], options);
}

/** The processes a module that may not start one itself, such as a tool family's session reader, runs through. */
export interface Processes {
  readonly exec: CommandExecutor;
  readonly spawn: typeof spawnCommand;
  readonly spawnSync: typeof spawnCommandSync;
  readonly probe: typeof probeBinary;
  readonly signalChild: typeof signalChild;
}

/** This process's own: what the host gives a module that runs through `Processes`. */
export const HOST_PROCESSES: Processes = { exec: execCommand, spawn: spawnCommand, spawnSync: spawnCommandSync, probe: probeBinary, signalChild };
