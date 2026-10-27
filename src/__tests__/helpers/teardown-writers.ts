import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import { trackDetachedProcesses } from './detached-processes.js';

// A recursive removal fails with ENOTEMPTY when something keeps writing into
// the directory while it is removed. teamai's own detached work is such a
// writer: hook-dispatch's --bg-only pass and the git hook's pull outlive the
// CLI that started them, and a teardown that never joined them raced their
// last write (#1413). This worker, and every node process the suite starts,
// records each detached child it spawns, so a removal that meets ENOTEMPTY
// waits for those children and tries once more. One that still fails reports
// what reappeared and which processes are still running in or on the
// directory.
const trackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detached-'));
const tracker = trackDetachedProcesses(trackerRoot);
// Where waitForDetachedChildren finds this tracker.
process.env.TEAMAI_TEST_DETACHED_ROOT = trackerRoot;
process.env.NODE_OPTIONS = withTracker(process.env.NODE_OPTIONS);
createRequire(import.meta.url)(tracker.preload);
// A test that hands a child an environment of its own, NODE_OPTIONS included,
// would otherwise start it untracked.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const) {
  const start = childProcess[name];
  const tracked = (...args: unknown[]): unknown => Reflect.apply(start, childProcess, args.map(withTrackedEnv));
  // promisify(execFile) and promisify(exec) resolve to { stdout, stderr } only through their own promisified form.
  const promised: unknown = Reflect.get(start, promisify.custom);
  if (typeof promised === 'function') {
    Object.assign(tracked, { [promisify.custom]: (...args: unknown[]): unknown => Reflect.apply(promised, childProcess, args.map(withTrackedEnv)) });
  }
  Object.assign(childProcess, { [name]: tracked });
}

// Under the hook timeouts, so a writer that never exits fails the removal rather than the hook.
const JOIN_MS = 10_000;
const POLL_MS = 25;
// Clocks a test's fake timers cannot freeze, or the join would never time out.
const now = performance.now.bind(performance);

const rmSync = fs.rmSync;
fs.rmSync = function rmSyncJoiningWriters(target, options) {
  try {
    rmSync(target, options);
    return;
  } catch (error) {
    if (!isNotEmptyError(error)) throw error;
  }
  const deadline = now() + JOIN_MS;
  while (tracker.running().length > 0 && now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  try {
    rmSync(target, options);
  } catch (error) {
    throw withWriters(error, target);
  }
};
const rm = fs.promises.rm;
fs.promises.rm = async function rmJoiningWriters(target, options) {
  try {
    await rm(target, options);
    return;
  } catch (error) {
    if (!isNotEmptyError(error)) throw error;
  }
  await joinWriters();
  try {
    await rm(target, options);
  } catch (error) {
    throw withWriters(error, target);
  }
};
syncBuiltinESMExports();

// Every config loads this setup file first, so this runs after every other
// teardown, each removal of which could still need the tracker. A child still
// running would fail to record its own children once the tracker is gone, so
// the tracker stays while one runs.
afterAll(async () => {
  await joinWriters();
  if (tracker.running().length === 0) fs.rmSync(trackerRoot, { recursive: true, force: true });
});

async function joinWriters(): Promise<void> {
  const deadline = now() + JOIN_MS;
  while (tracker.running().length > 0 && now() < deadline) await sleep(POLL_MS);
}

function withTracker(nodeOptions: string | undefined): string {
  return nodeOptions?.includes(tracker.nodeOptions) ? nodeOptions : [nodeOptions, tracker.nodeOptions].filter(Boolean).join(' ');
}

/** `arg` with the tracker in its env's NODE_OPTIONS, when it is the options of a call that sets an env. */
function withTrackedEnv(arg: unknown): unknown {
  if (typeof arg !== 'object' || arg === null || !('env' in arg) || typeof arg.env !== 'object' || arg.env === null) return arg;
  const nodeOptions = 'NODE_OPTIONS' in arg.env && typeof arg.env.NODE_OPTIONS === 'string' ? arg.env.NODE_OPTIONS : undefined;
  return { ...arg, env: { ...arg.env, NODE_OPTIONS: withTracker(nodeOptions) } };
}

const MAX_LISTED = 10;

function isNotEmptyError(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY';
}

function withWriters(error: unknown, target: fs.PathLike): unknown {
  if (isNotEmptyError(error)) {
    error.message += describeWriters(target instanceof URL ? fileURLToPath(target) : target.toString());
  }
  return error;
}

function describeWriters(dir: string): string {
  return `\nEntries that reappeared during removal:\n${indentedList(reappeared(dir))}`
    + `\nProcesses still running in or on ${dir}:\n${indentedList(processesIn(dir))}`;
}

function indentedList(entries: string[]): string {
  return entries.length > 0 ? entries.map((entry) => `  ${entry}`).join('\n') : '  none found';
}

/** The newest entries under `dir`, with how long ago each was last written. */
function reappeared(dir: string): string[] {
  const now = Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' });
  } catch (error) {
    return [`could not list ${dir}: ${String(error)}`];
  }
  const entries = names.flatMap((name) => {
    try {
      return [{ name, mtime: fs.lstatSync(path.join(dir, name)).mtimeMs }];
    } catch {
      return [];
    }
  });
  entries.sort((a, b) => b.mtime - a.mtime);
  const listed = entries.slice(0, MAX_LISTED).map(({ name, mtime }) => `${name} (written ${Math.max(0, Math.round(now - mtime))}ms ago)`);
  return entries.length > MAX_LISTED ? [...listed, `and ${entries.length - MAX_LISTED} more`] : listed;
}

/**
 * Each process whose working directory is in `dir`, or whose command line or
 * environment names it, as `<pid> <command line>`. The environment is matched,
 * never printed: CI logs must not carry it.
 */
function processesIn(dir: string): string[] {
  let resolved = dir;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    // Gone already: match the spelling the caller passed.
  }
  const isInside = (candidate: string) => [dir, resolved].some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  const names = (text: string) => text.includes(dir) || text.includes(resolved);
  try {
    return runningProcesses()
      .filter(({ pid, cwd, args, env }) => pid !== process.pid && ((cwd !== undefined && isInside(cwd)) || names(args) || names(env)))
      .map(({ pid, args }) => `${pid} ${args}`);
  } catch (error) {
    return [`could not list processes: ${String(error)}`];
  }
}

function runningProcesses(): Array<{ pid: number; cwd: string | undefined; args: string; env: string }> {
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf-8').split('\0').join(' ').trim();
        let cwd: string | undefined;
        let env = '';
        try {
          cwd = fs.readlinkSync(`/proc/${name}/cwd`);
          env = fs.readFileSync(`/proc/${name}/environ`, 'utf-8');
        } catch {
          // Another user's process, or one that just exited.
        }
        return [{ pid: Number(name), cwd, args, env }];
      } catch {
        return [];
      }
    });
  }
  // macOS and the other Unixes: ps for command lines, lsof for working
  // directories. macOS keeps other processes' environments from ps, so a
  // writer that reaches the directory only through its environment (teamai's
  // detached children find ~/.teamai through HOME) is named on Linux alone.
  // lsof exits non-zero when it cannot read some process, with the rest still
  // listed; without lsof, command lines still name a writer passed the path.
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const field of (spawnSync('lsof', ['-d', 'cwd', '-F', 'pn'], { encoding: 'utf-8' }).stdout ?? '').split('\n')) {
    if (field.startsWith('p')) pid = Number(field.slice(1));
    else if (field.startsWith('n')) cwds.set(pid, field.slice(1));
  }
  return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf-8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), cwd: cwds.get(Number(match[1])), args: match[2], env: '' }] : [];
  });
}
