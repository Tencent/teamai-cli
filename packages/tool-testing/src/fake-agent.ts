import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSameProcess, ProcessIdentitySchema, signalGroup, signalPid, type ProcessIdentity } from '@teamai/shared/process-group';
import { readRegularFileSync, writeRegularFileSync } from '@teamai/shared/regular-file';

/** What the prompt or the options ask a fake agent to do beyond answering. */
export const FAKE_AGENT_MARKERS = {
  /** Prints its first line, then goes silent until killed. */
  hang: '[[fake:hang]]',
  /** Waits `slowMs` before each line it prints. */
  slow: '[[fake:slow]]',
  /** Prints the recorded failure and exits non-zero. */
  fail: '[[fake:fail]]',
  /** Also writes a subagent transcript where the tool keeps them, for a tool that has subagents. */
  subagent: '[[fake:subagent]]',
  /** Commits a file holding the prompt in its cwd before it answers. */
  commit: '[[fake:commit]]',
} as const;

export type FakeAgentBehaviour = keyof typeof FAKE_AGENT_MARKERS;

/**
 * How a tool family's fake prints what its real CLI recorded: kept in the family's `./testing` entry, beside its
 * fixtures. `script` is JavaScript the fake runs once it read the prompt, with these in scope: `args`, `prompt`,
 * `reply` (the reply text, or undefined for the recorded one), `data` (this recording's `data`), `does(behaviour)`,
 * `await say(line)` (prints a line, slowly when asked), `hang()` (goes silent until killed), `fs`, `path` and
 * `randomUUID`. It prints the tool's output and exits.
 */
export interface FakeAgentRecording {
  readonly executable: string;
  /** What `<executable> --version` prints. */
  readonly version: string;
  readonly data: Readonly<Record<string, string>>;
  readonly script: string;
}

export interface FakeAgentOptions {
  /** The directory the executable goes in, which the test puts on PATH. Keep it short: macOS caps a path at 1024 bytes. */
  readonly bin: string;
  /** The reply text, where the recorded answer was. Default: the recorded answer. */
  readonly answer?: string;
  /** The first entry whose `when` the prompt contains gives the reply instead of `answer`. */
  readonly answers?: ReadonlyArray<{ readonly when: string; readonly answer: string }>;
  /** Behaviours on every call, as though each prompt held their markers. */
  readonly always?: readonly FakeAgentBehaviour[];
  /** How long `slow` waits before each line. Default 600 ms. */
  readonly slowMs?: number;
  /**
   * JavaScript the fake runs once it read the prompt, before it answers, with `prompt`, `args`, `fs`, `path` and a
   * mutable `reply` in scope. It may exit on its own, print, or change `reply`.
   */
  readonly before?: string;
}

const Call = z.object({ args: z.array(z.string()), prompt: z.string(), cwd: z.string() });

export type FakeAgentCall = z.infer<typeof Call>;

export interface FakeAgent {
  /** The executable, `<bin>/<recording.executable>`. */
  readonly executable: string;
  /** Every call so far, in order: its arguments, the prompt it read on stdin, and its cwd. */
  calls(): FakeAgentCall[];
  /**
   * The processes of this fake still alive, which it then kills: an `afterEach` expects none, whoever started them. A
   * pid the system gave to another process since that fake ended is left alone, as teamai leaves a pid it did not start.
   */
  stopLeft(): Promise<number[]>;
}

/**
 * A stand-in for the tool `recording` belongs to, in `bin`: it prints what the real CLI printed in the family's
 * recorded call, with only the reply and the session id swapped, and keeps its session where the real one does.
 * Prompt markers (`FAKE_AGENT_MARKERS`) make it hang, go slow, fail, start a subagent or commit. POSIX only.
 */
export function fakeAgent(recording: FakeAgentRecording, options: FakeAgentOptions): FakeAgent {
  const executable = path.join(options.bin, recording.executable);
  const log = path.join(options.bin, `${recording.executable}.calls.jsonl`);
  const pids = path.join(options.bin, `${recording.executable}.pids`);

  const settings = {
    log,
    pids,
    version: recording.version,
    data: recording.data,
    markers: FAKE_AGENT_MARKERS,
    answer: options.answer,
    answers: options.answers ?? [],
    always: options.always ?? [],
    slowMs: options.slowMs ?? 600,
  };

  const source = ENGINE.replace('/* before */', () => options.before ?? '').replace('/* answer */', () => recording.script);

  fs.mkdirSync(options.bin, { recursive: true });
  writeRegularFileSync(executable, `#!${process.execPath}\nconst settings = ${JSON.stringify(settings)};\n${source}`, { mode: 0o755 });

  return {
    executable,
    stopLeft: async () => {
      const listed = fs.existsSync(pids) ? readRegularFileSync(pids, 'utf8').split('\n').flatMap(recordedFake) : [];

      return killSame(listed, (pid) => signalPid(pid, 'SIGKILL'));
    },
    calls: () => (fs.existsSync(log) ? readRegularFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => Call.parse(JSON.parse(line))) : []),
  };
}

/**
 * One line of a pids file: the pid a fake ran as and the time it read once it ran, which tells it from a later process
 * given that pid. A line a fake was still writing, or any other, names no fake.
 */
function recordedFake(line: string): ProcessIdentity[] {
  try {
    const recorded = ProcessIdentitySchema.safeParse(JSON.parse(line));

    return recorded.success && recorded.data.spawnedAt !== undefined ? [recorded.data] : [];
  } catch {
    return [];
  }
}

/**
 * The processes of `recorded` still running as recorded, each of which `kill` then gets: a pid now another process's,
 * or one this machine cannot tell, gets nothing. A pid below 2 is never one: `isSameProcess` takes it as live.
 */
async function killSame(recorded: readonly ProcessIdentity[], kill: (pid: number) => void): Promise<number[]> {
  const verdicts = await Promise.all(recorded.map(async (fake) => ({ pid: fake.pid, isSame: fake.pid > 1 && await isSameProcess(fake) === 'same' })));
  const alive = verdicts.flatMap(({ pid, isSame }) => (isSame ? [pid] : []));

  for (const pid of alive) kill(pid);

  return alive;
}

const ENGINE = String.raw`
const fs = require('node:fs');
fs.appendFileSync(settings.pids, JSON.stringify({ pid: process.pid, spawnedAt: Date.now() }) + '\n');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const data = settings.data;
if (args.includes('--version')) { process.stdout.write(settings.version + '\n'); process.exit(0); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hang = () => { setInterval(() => {}, 1 << 30); };
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  fs.appendFileSync(settings.log, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\n');
  const does = (behaviour) => settings.always.includes(behaviour) || prompt.includes(settings.markers[behaviour]);
  const say = async (line) => { if (does('slow')) await sleep(settings.slowMs); process.stdout.write(line + '\n'); };
  const picked = settings.answers.find((entry) => prompt.includes(entry.when));
  let reply = picked ? picked.answer : settings.answer;
  /* before */
  if (does('commit')) {
    fs.writeFileSync('agent.txt', prompt + '\n');
    execFileSync('git', ['add', 'agent.txt']);
    execFileSync('git', ['commit', '-qm', 'agent commit']);
  }
  /* answer */
});
`;

const started: ProcessIdentity[] = [];

/**
 * Runs a fake as a tool launch does, with `prompt` on stdin, in its own process group, and gives what it printed and
 * its exit code (null when `stopAfterOutputMs` stopped it). `stopAfterOutputMs` counts from its first output, since a
 * machine under load can take longer than that to start it.
 */
export function runFakeAgent(executable: string, args: readonly string[], prompt: string, { cwd, env = {}, stopAfterOutputMs }: { cwd: string; env?: Readonly<Record<string, string>>; stopAfterOutputMs?: number }): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, detached: true });
    const pid = child.pid;
    let stdout = '';

    if (pid !== undefined) started.push({ pid, spawnedAt: Date.now() });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout === '' && stopAfterOutputMs !== undefined && pid !== undefined) setTimeout(() => signalGroup(pid, 'SIGTERM'), stopAfterOutputMs);
      stdout += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(prompt);
  });
}

/**
 * The fakes `runFakeAgent` started that are still alive, whose groups it then kills: an `afterEach` expects none. A pid
 * the system gave to another process since that fake ended is left alone.
 */
export function leftFakeAgents(): Promise<number[]> {
  return killSame(started.splice(0), (pid) => signalGroup(pid, 'SIGKILL'));
}
