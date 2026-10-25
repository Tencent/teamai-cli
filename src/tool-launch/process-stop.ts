import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The start time of every process, as `ps -o lstart=` prints it, by pid; undefined when ps cannot run. */
export function processStarts(): Map<number, string> | undefined {
  let stdout: string;
  try {
    stdout = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  return new Map(stdout.trim().split('\n').map((line) => {
    const [pid, ...start] = line.trim().split(/\s+/);
    return [Number(pid), start.join(' ')];
  }));
}

/** A detached process group: the pid of the process that leads it, and when that process started. */
export interface ProcessGroup {
  pid: number;
  start: string;
}

const ProcessGroupSchema = z.object({ pid: z.number().int().positive(), start: z.string().min(1) });

/** The file in a directory that records the last process group started for it. */
const GROUP_FILE = 'group.json';

/**
 * Records in `dir` the process group `child` leads, for `stopRecordedGroup` to stop once whatever started it is gone.
 * Synchronous on purpose: a starter killed right after the spawn still leaves the record, which an await would widen.
 */
export function recordGroup(child: ChildProcess, dir: string): void {
  const start = child.pid === undefined ? undefined : processStarts()?.get(child.pid);
  if (child.pid === undefined || start === undefined) return;
  const file = path.join(dir, GROUP_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ pid: child.pid, start }));
    fs.renameSync(temporary, file);
  } catch {
    // The starter still stops its child itself; only a starter killed with it would leave the group running.
  }
}

/** Stops the process group `recordGroup` last recorded in `dir`, when one is, and removes the record. */
export async function stopRecordedGroup(dir: string): Promise<void> {
  const file = path.join(dir, GROUP_FILE);
  let recorded: ProcessGroup;
  try {
    recorded = ProcessGroupSchema.parse(JSON.parse(await fs.promises.readFile(file, 'utf8')));
  } catch {
    return;
  }
  await stopGroup(recorded);
  await fs.promises.rm(file, { force: true });
}

/** Whether a signal reached any process of group `pid`. */
function signalGroup(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-pid, name);
  } catch {
    return false;
  }
}

/**
 * Stops `group`, a detached process group no child handle of this process reaches, with a five-second grace period
 * before SIGKILL. A group that is gone, or whose pid now leads another process, is left alone: while any process of a
 * group lives, POSIX reuses no pid equal to its id, so a group whose leader is gone is still the one recorded. Whether
 * it signalled the group. POSIX only: Windows has no process groups to reach.
 */
export async function stopGroup(group: ProcessGroup): Promise<boolean> {
  if (process.platform === 'win32' || !signalGroup(group.pid, 0)) return false;
  const starts = processStarts();
  const leader = starts?.get(group.pid);
  // Without current identities, a pid reused since cannot be told apart, so the group is left alone.
  if (!starts || (leader !== undefined && leader !== group.start)) return false;
  signalGroup(group.pid, 'SIGTERM');
  // Counted rather than timed, so a faked clock cannot stretch the grace period.
  for (let probe = 0; signalGroup(group.pid, 0); probe += 1) {
    if (probe === 100) {
      signalGroup(group.pid, 'SIGKILL');
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** What a command `startGroupedCommand` ran left: its status, its stdout and stderr, and both together as they came. */
export interface CommandExit {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** A shell command a driver started. */
export interface GroupedCommand {
  /** Settles once the command exited and closed its output. */
  exit: Promise<CommandExit>;
  /** Stops the command and what it started, then settles once they are gone. A second call changes nothing. */
  stop: (signal?: NodeJS.Signals) => Promise<CommandExit>;
}

/**
 * Starts shell `command` with its stdin closed. A `detached` command leads a process group of its own, recorded in
 * `group` for `stopRecordedGroup`, so a stop reaches everything it started even after its starter died. A command that
 * cannot be spawned exits 127, the shell's status for a command it cannot run, with the error at the end of its stderr.
 */
export function startGroupedCommand(input: { command: string; cwd: string; env: NodeJS.ProcessEnv; detached: boolean; group: string }): GroupedCommand {
  const { command, cwd, env, detached, group } = input;
  const child = spawn(command, { shell: true, cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (detached) recordGroup(child, group);
  const exit = new Promise<CommandExit>((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; output += chunk; });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, output }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr, output }));
  });
  return { exit, stop: stopProcess(child, exit, detached) };
}

/** Stops a detached process group or an attached process tree, with a five-second grace period before SIGKILL. */
export function stopProcess<T>(child: ChildProcess, exit: Promise<T>, detached: boolean): (signal?: NodeJS.Signals) => Promise<T> {
  let stopping: Promise<T> | undefined;
  const descendants: { pid: number; start: string }[] = [];
  /** Whether the signal reached any process in the group or tree. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try {
      if (detached && child.pid !== undefined) return process.kill(-child.pid, name);
      let targets = descendants;
      if ((name === 0 || name === 'SIGKILL') && descendants.length > 0) {
        // Without current identities, stop only the shell.
        const starts = processStarts() ?? new Map<number, string>();
        // lstart has one-second resolution and the check is not atomic with kill, so this narrows the window but does not close it.
        targets = descendants.filter(({ pid, start }) => starts.get(pid) === start);
      }
      let reached = false;
      for (const { pid } of targets) {
        try { reached = process.kill(pid, name) || reached; } catch { /* Already exited. */ }
      }
      return child.kill(name) || reached;
    } catch {
      return false;
    }
  };
  const stop = async (initial: NodeJS.Signals): Promise<T> => {
    if (process.platform === 'win32' && child.pid !== undefined) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      return exit;
    }
    if (!detached && child.pid !== undefined) {
      let stdout = '';
      try {
        stdout = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
      } catch {
        // ps may be unavailable in minimal environments; fall back to stopping only the shell.
      }
      const children = new Map<number, typeof descendants>();
      for (const line of stdout.trim().split('\n')) {
        const [pid, parent, ...start] = line.trim().split(/\s+/);
        if (!pid || !parent || start.length === 0) continue;
        const siblings = children.get(Number(parent)) ?? [];
        siblings.push({ pid: Number(pid), start: start.join(' ') });
        children.set(Number(parent), siblings);
      }
      // A process that daemonizes away from this snapshot's tree is not reached.
      const pending = [...children.get(child.pid) ?? []];
      while (pending.length > 0) {
        const descendant = pending.pop()!;
        descendants.push(descendant);
        pending.push(...children.get(descendant.pid) ?? []);
      }
      descendants.reverse();
    }
    signal(initial);
    let timer: NodeJS.Timeout | undefined;
    let escalated = false;
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => { escalated = true; signal('SIGKILL'); resolve(); }, 5000);
    });
    const result = await exit;
    // A process with its own output can ignore SIGTERM and outlive the shell. Keep SIGKILL while any captured
    // descendant or process in the detached group remains.
    // Descendants may still be exiting when the shell closes. Recheck instead
    // of waiting the whole grace period after that first successful probe.
    while (!escalated && signal(0)) {
      await Promise.race([killed, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }
    clearTimeout(timer);
    return result;
  };
  return (initial = 'SIGTERM') => (stopping ??= stop(initial));
}
