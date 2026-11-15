import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ASSUMED_OPENCODE_MAJOR, type CallLaunch } from '@teamai/tool-core/launch';
import { stoppedOnUsageLimit, toolStdout, type TokenUsage } from '@teamai/tool-core/stdout';
import { readRegularFile, writeRegularFile } from '@teamai/shared/regular-file';
import { MAX_TIMER_MS } from '@teamai/shared/timer';

/** What a headless run of a tool printed and ended with, and why teamai stopped it, when it did. */
export interface HeadlessRun {
  stdout: string;
  stderr: string;
  code: number;
  /** Its `timeoutMs` passed, or it printed nothing for `idleTimeoutMs`. */
  stopped?: 'timeout' | 'idle';
}

/** One started headless process: its exit code, which rejects when the process could not run, and a stop for it and what it started. */
export interface HeadlessProcess {
  exited: Promise<number>;
  stop(): Promise<void>;
}

/**
 * The port a headless run starts its tool's process through. The process gets `stdin` and closes it; `onOutput` gets
 * each decoded chunk it prints. `{ notStarted }`: nothing was started, with the reason.
 */
export type HeadlessStarter = (launch: { stdin: string; onOutput: (text: string, stream: 'stdout' | 'stderr') => void }) => HeadlessProcess | { notStarted: string };

/**
 * Runs a headless process through `start`, stopping it and whatever it started at `timeoutMs`, once it prints nothing
 * for `idleTimeoutMs`, or when `signal` aborts. A limit longer than a timer can wait (about 24.8 days) is none.
 */
export async function runHeadless({ start, stdin, timeoutMs, idleTimeoutMs, signal }: { start: HeadlessStarter; stdin: string; timeoutMs: number; idleTimeoutMs?: number | undefined; signal?: AbortSignal | undefined }): Promise<HeadlessRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stopped: HeadlessRun['stopped'];
  let idleTimer: NodeJS.Timeout | undefined;
  let stop = async (): Promise<void> => {};

  // Each chunk the tool prints restarts the idle limit, so a tool that streams lives and a silent one is stopped.
  const active = (): void => {
    if (idleTimeoutMs === undefined || idleTimeoutMs > MAX_TIMER_MS) return;

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!signal?.aborted) stopped ??= 'idle'; void stop(); }, idleTimeoutMs);
  };

  const started = start({ stdin, onOutput: (text, stream) => { (stream === 'stdout' ? stdout : stderr).push(text); active(); } });

  if ('notStarted' in started) return { stdout: '', stderr: started.notStarted, code: 1 };
  stop = () => started.stop();
  const timer = timeoutMs > MAX_TIMER_MS ? undefined : setTimeout(() => { stopped ??= 'timeout'; void stop(); }, timeoutMs);

  active();
  const onAbort = (): void => { void stop(); };

  signal?.addEventListener('abort', onAbort, { once: true });

  if (signal?.aborted) onAbort();

  try {
    const code = await started.exited;
    const run: HeadlessRun = { stdout: stdout.join(''), stderr: stderr.join(''), code };

    if (stopped !== undefined) run.stopped = stopped;

    return run;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The tool a call runs: the name its messages use, its launch adapter's id and call profile, and the executable that starts it. */
export interface CallTool {
  readonly name: string;
  readonly family: string;
  readonly call: CallLaunch;
  readonly executable: string;
}

/** What a call reads from the host: OpenCode's major version, from its executable. */
export interface CallLaunchHost {
  opencodeMajor(executable: string): Promise<number>;
}

/** How a call ended: the tool's answer, the tool's own failure, or a stop at one of its limits, at which teamai stopped it. */
export type CallEnd =
  | { kind: 'answered'; text: string; tokens?: TokenUsage; session?: string }
  | { kind: 'failed'; code: 'usage_limited' | 'call_failed'; message: string }
  | { kind: 'stopped'; limit: 'timeout' | 'idle'; message: string };

/**
 * Runs `prompt` once on `tool`'s call profile through `start`, continuing `session` when given: the arguments and stdin
 * the profile names, a scratch directory for its prompt and last-message files, the timeout, an idle limit for a call
 * that prints as it works, and the answer or failure the profile reads back.
 */
export async function callLaunch({ tool, prompt, session, timeoutMs, idleTimeoutMs, signal, host, start }: {
  tool: CallTool;
  prompt: string;
  session?: string | undefined;
  timeoutMs: number;
  /** Stops a call that prints nothing for this long, run in a way that prints as it works. A call that prints only once it ends gets none. */
  idleTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  host: CallLaunchHost;
  /** Starts the process with the call's argv; the rest of the launch is the caller's. */
  start: (args: string[]) => HeadlessStarter;
}): Promise<CallEnd> {
  const { call } = tool;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));

  try {
    const lastMessageFile = path.join(scratch, 'last-message.txt');
    const promptFile = path.join(scratch, 'prompt.md');

    if (call.prompt === 'file') await writeRegularFile(promptFile, prompt);
    const resumed = session !== undefined && call.resume ? call.resume.args(session) : [];
    const streaming = idleTimeoutMs === undefined ? undefined : call.streams;
    const opencodeMajor = tool.family === 'opencode' ? await host.opencodeMajor(tool.executable) : ASSUMED_OPENCODE_MAJOR;
    const args = [...(streaming?.args ?? call.args)({ prompt, promptFile, lastMessageFile, opencodeMajor }), ...resumed];
    const stdin = call.prompt !== 'stdin' ? '' : call.stdinOf ? call.stdinOf(prompt) : prompt;
    const run = await runHeadless({ start: start(args), stdin, timeoutMs, ...(streaming && { idleTimeoutMs }), signal });

    if (run.stopped === 'timeout') return { kind: 'stopped', limit: 'timeout', message: `AI call timed out after ${Math.round(timeoutMs / 1000)}s (tool: ${tool.name})` };

    if (run.stopped === 'idle') {
      return { kind: 'stopped', limit: 'idle', message: `AI call printed nothing for ${(idleTimeoutMs ?? 0) / 1000}s, longer than its idle limit (tool: ${tool.name}). Raise the idle limit if this tool works silently for longer.` };
    }

    const lastMessage = await readRegularFile(lastMessageFile, 'utf8').catch(() => undefined);
    const reading = call.read({ stdout: run.stdout, lastMessage });

    if (run.code !== 0 || !reading.ok) {
      // A streamed call's stdout is its transcript, files it read included, so only a plain one stands for a reason.
      const reason = (reading.ok ? undefined : reading.message) || run.stderr.trim() || (streaming ? '' : run.stdout.trim()) || `exit code ${run.code}`;

      // A typed error decides by its kind (OpenCode 2.x); one without a kind, by its text.
      if (stoppedOnUsageLimit(toolStdout(tool.family, run.stdout), reason)) return { kind: 'failed', code: 'usage_limited', message: `${tool.name} hit its usage limit: ${reason}` };

      return { kind: 'failed', code: 'call_failed', message: `AI call failed (tool: ${tool.name}): ${reason}` };
    }

    const answer: CallEnd = { kind: 'answered', text: reading.text };

    if (reading.tokens) answer.tokens = reading.tokens;

    if (reading.session !== undefined) answer.session = reading.session;

    return answer;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
