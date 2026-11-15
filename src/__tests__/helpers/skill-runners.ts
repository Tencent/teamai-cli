import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { signalGroup } from '@teamai/shared/process-group';

// A runner notices a reported or cancelled attempt at its next check, every RUNNER_POLL_MS (10 s), given twice that
// for a check a busy machine slows. A test may not import the skill driver's tick (teamai/workflow-boundaries); a
// longer poll fails teardowns here, never passes them.
export const RUNNER_EXIT_MS = 20_000;
const KILL_MS = 5_000;
const POLL_MS = 100;
// Clocks a test's fake timers cannot freeze, or the wait would never end.
const now = performance.now.bind(performance);

/**
 * The skill driver's runners among `running()`, the detached children a test left, that outlived it, by pid. Each
 * runner is a detached `teamai workflow report <run> --driver skill --attempt <a>` that leads a process group of its
 * own, works in its run's checkout, and ends at its next check once its attempt is reported or stopped. Waits `exitMs`
 * for the runners to end, then stops each one left: its process group, and the groups its step's setup and command
 * lead, which outlive it. `workingIn`: the runners whose working directory is in that directory, whatever started
 * them, since `running()` misses one a process without the tracker preload started, as a confined tool, whose
 * environment drops NODE_OPTIONS. `alsoWorkingIn`: besides `running()`'s runners, those working in any of these
 * directories, whatever started them. Synchronous, so a synchronous removal can call it. On Windows a runner leads no
 * process group, so nothing is checked there.
 */
export function stopLeftSkillRunners(running: () => number[], options: { exitMs?: number; workingIn?: string; alsoWorkingIn?: readonly string[] } = {}): number[] {
  const { exitMs = RUNNER_EXIT_MS, workingIn, alsoWorkingIn = [] } = options;
  const live = () => {
    if (workingIn !== undefined) {
      const runners = skillRunners();
      return runners.length === 0 ? runners : runnersWorkingIn(runners, workingIn);
    }
    const tracked = skillRunners(running());
    if (alsoWorkingIn.length === 0) return tracked;
    const runners = skillRunners();
    const untracked = runners.length === 0 ? [] : alsoWorkingIn.flatMap((dir) => runnersWorkingIn(runners, dir));
    return [...new Set([...tracked, ...untracked])];
  };
  const deadline = now() + exitMs;
  let left = live();
  while (left.length > 0 && now() < deadline) {
    pause(POLL_MS);
    left = live();
  }
  if (left.length === 0) return [];
  // The groups of a runner's step, found through the runner while it lives: once it is stopped they belong to init.
  const table = processTable();
  const parents = new Map(table.map((row) => [row.pid, row.ppid]));
  const steps = new Set(table.filter((row) => left.some((runner) => descends(parents, row.pid, runner))).map((row) => row.pgid));
  for (const pid of left) steps.delete(pid);
  for (const pid of left) signalGroup(pid, 'SIGTERM');
  const killAt = now() + KILL_MS;
  while (left.some(groupRunning) && now() < killAt) pause(POLL_MS);
  const killed = [...left.filter(groupRunning), ...steps];
  for (const pid of killed) signalGroup(pid, 'SIGKILL');
  // A killed process ends a moment later, so the groups are stopped only once none of them runs.
  const goneAt = now() + KILL_MS;
  while (killed.some(groupRunning) && now() < goneAt) pause(POLL_MS);
  return left;
}

/** The message a teardown fails with when `left`, the pids `stopLeftSkillRunners` stopped, is not empty. */
export function leftSkillRunners(left: readonly number[]): string {
  return `Skill runners outlived the test and were stopped: ${left.join(', ')}. Report or cancel every attempt the test offers before it ends.`;
}

export interface ProcessRow { pid: number; ppid: number; pgid: number; zombie: boolean; command: string }

/**
 * Each of `pids` that is a live skill runner, so a pid the system gave to another process since is never signalled;
 * without `pids`, every live skill runner on this machine.
 */
function skillRunners(pids?: readonly number[]): number[] {
  if (process.platform === 'win32' || pids?.length === 0) return [];
  const runners = processTable().filter((row) => !row.zombie && / workflow report \S+ --driver skill --attempt /.test(row.command)).map((row) => row.pid);
  return pids === undefined ? runners : pids.filter((pid) => runners.includes(pid));
}

/** Each of `runners` whose working directory is `dir` or inside it. */
function runnersWorkingIn(runners: readonly number[], dir: string): number[] {
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    return [];
  }
  const cwds = workingDirectories(runners);
  return runners.filter((pid) => {
    const cwd = cwds.get(pid);
    return cwd !== undefined && (cwd === root || cwd.startsWith(`${root}${path.sep}`));
  });
}

function workingDirectories(pids: readonly number[]): Map<number, string> {
  if (process.platform === 'linux') {
    return new Map(pids.flatMap((pid) => {
      try {
        return [[pid, fs.readlinkSync(`/proc/${pid}/cwd`)] as const];
      } catch {
        return [];
      }
    }));
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const field of (spawnSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'], { encoding: 'utf8' }).stdout ?? '').split('\n')) {
    if (field.startsWith('p')) pid = Number(field.slice(1));
    else if (field.startsWith('n')) cwds.set(pid, field.slice(1));
  }
  return cwds;
}

/** Whether `pid` is `ancestor` or one of its descendants, by `parents`, each process's parent. */
export function descends(parents: ReadonlyMap<number, number>, pid: number, ancestor: number): boolean {
  for (let at: number | undefined = pid; at !== undefined && at > 1; at = parents.get(at)) if (at === ancestor) return true;
  return false;
}

/** Every process on this machine, from one `ps` snapshot. */
export function processTable(): ProcessRow[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' }).stdout ?? '';
  return listed.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), zombie: match[4]?.startsWith('Z') ?? false, command: match[5] ?? '' }] : [];
  });
}

/**
 * Whether a process of the group `pgid` still runs. A zombie has ended: it only waits for its parent, or init once its
 * parent is gone, to read its exit, which a signal to its group still reaches.
 */
export function groupRunning(pgid: number): boolean {
  return processTable().some((row) => row.pgid === pgid && !row.zombie);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
