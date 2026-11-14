// ─── Process groups ─────────────────────────────────────
//
//  How teamai and the runtimes stop what they started: a detached process group, or an attached command with its
//  descendants, through a child handle while its starter lives, or through the record it left once its starter died.
//  It also owns process identity, how a recorded pid is told from a later process given it, which the locks judge
//  their holders by as well, and every signal teamai sends: `signalPid` and `signalGroup`, which send nothing to a pid
//  below 2, and `signalChild`, which sends nothing to a child that never spawned (`teamai/signal-owner` keeps every other
//  module off `process.kill`, and production source off a child's own kill).
//

import { execFile, type ChildProcess } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readRegularFile } from '@teamai/shared/regular-file';

/** How long a ps read may take before it reads as telling nothing: a loaded machine answers in well under a second. */
const PS_TIMEOUT_MS = 5_000;

/**
 * The channel each process read is told on (`tellProcessRead`). The agent wait budget counts the reads Linux answers from
 * `/proc` as the ps macOS runs for them, so a wait only macOS has shows on a Linux runner too.
 */
export const PROCESS_READ_CHANNEL = 'teamai:process-read';

/** A process read: the ps argv it ran or, read from `/proc`, stands for, and whether it ran ps. */
export interface ProcessRead { readonly ps: readonly string[]; readonly spawned: boolean }

const processReads = diagnostics.channel(PROCESS_READ_CHANNEL);

/** Tells a process read on `PROCESS_READ_CHANNEL`: every read of `/proc`, where macOS runs ps, is told, once per ps it stands for. */
export function tellProcessRead(read: ProcessRead): void {
  processReads.publish(read);
}

/**
 * The one way this module reads processes: from `/proc` on Linux when `fromProc` tells, else through ps with `args`, in
 * the C locale, whose `lstart` reads the same on every machine and parses as a date. ps runs off the event loop, for at
 * most `PS_TIMEOUT_MS` or until `signal` aborts. Undefined when neither tells. Each read is told on
 * `PROCESS_READ_CHANNEL`.
 */
async function readProcesses<T>({ args, fromPs, fromProc, signal }: {
  args: readonly string[];
  fromPs: (stdout: string) => T | undefined;
  fromProc?: () => Promise<T | undefined>;
  signal?: AbortSignal;
}): Promise<T | undefined> {
  if (fromProc !== undefined && process.platform === 'linux') {
    const read = await fromProc();

    if (read !== undefined) {
      tellProcessRead({ ps: args, spawned: false });

      return read;
    }
  }

  if (signal?.aborted === true) return undefined;
  tellProcessRead({ ps: args, spawned: true });

  return new Promise((resolve) => {
    execFile('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: PS_TIMEOUT_MS, ...(signal !== undefined && { signal }) }, (error, stdout) => {
      resolve(error ? undefined : fromPs(stdout));
    });
  });
}

/**
 * When a running process started. On Linux, in clock ticks since the machine booted, read from `/proc`, which a
 * container whose BusyBox `ps` prints no start time still has; elsewhere as `ps -o lstart=` prints it, to the second.
 * `at` is that time in milliseconds since the epoch.
 */
const ProcessStartSchema = z.union([z.object({ ticks: z.number(), at: z.number() }), z.object({ lstart: z.string(), at: z.number() })]);

type ProcessStart = z.infer<typeof ProcessStartSchema>;

/** Whether `a` and `b` are the start of one process, read at two times. */
function isSameStart(a: ProcessStart, b: ProcessStart): boolean {
  return 'ticks' in a ? 'ticks' in b && a.ticks === b.ticks : 'lstart' in b && a.lstart === b.lstart;
}

/** A running process: its parent, its process group, and when it started. */
interface RunningProcess { ppid: number; pgid: number; start: ProcessStart }

/** Every running process by pid, from `/proc` on Linux and from ps elsewhere; undefined when neither can tell. */
function runningProcesses(): Promise<Map<number, RunningProcess> | undefined> {
  return readProcesses({ args: PROCESSES_ARGS, fromPs: processesOf, fromProc: procProcesses });
}

/**
 * The fields of `/proc/<pid>/stat` this module reads: the parent (field 4), the process group (field 5) and the start
 * in ticks (field 22).
 */
function statFields(stat: string): { ppid: number; pgid: number; foreground: number; ticks: number } | undefined {
  // The command name, field 2, is in parentheses and may hold spaces or parentheses itself: fields count after its last `)`.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const foreground = Number(fields[5]);
  const ticks = Number(fields[19]);

  return [ppid, pgid, foreground, ticks].every(Number.isInteger) ? { ppid, pgid, foreground, ticks } : undefined;
}

/** The clock ticks per second `/proc` counts in (USER_HZ), 100 on every architecture Linux exposes to Node. */
const USER_HZ = 100;

/** When the machine booted, in milliseconds since the epoch, as `/proc/stat` tells it (to the second). */
function bootTime(stat: string): number | undefined {
  const boot = Number(/^btime (\d+)$/m.exec(stat)?.[1]);

  return Number.isInteger(boot) ? boot * 1000 : undefined;
}

/** The start of a process that started `ticks` after a boot at `boot`. */
function tickStart(ticks: number, boot: number): ProcessStart {
  return { ticks, at: boot + (ticks * 1000) / USER_HZ };
}

/** Every running process, read from `/proc`; undefined when `/proc` cannot be read. */
async function procProcesses(): Promise<Map<number, RunningProcess> | undefined> {
  let boot: number | undefined;
  let names: string[];

  try {
    boot = bootTime(await readRegularFile('/proc/stat', 'utf8'));
    names = await fs.promises.readdir('/proc');
  } catch {
    return undefined;
  }

  if (boot === undefined) return undefined;
  const running = new Map<number, RunningProcess>();

  const stats = await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    try {
      return { pid: Number(name), fields: statFields(await readRegularFile(`/proc/${name}/stat`, 'utf8')) };
    } catch {
      // The process exited while the folder was read.
      return undefined;
    }
  }));

  for (const stat of stats) {
    if (stat?.fields !== undefined) running.set(stat.pid, { ppid: stat.fields.ppid, pgid: stat.fields.pgid, start: tickStart(stat.fields.ticks, boot) });
  }

  return running;
}

const PROCESSES_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,lstart='];

function processesOf(stdout: string): Map<number, RunningProcess> {
  const running = new Map<number, RunningProcess>();

  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid, pgid, ...start] = line.trim().split(/\s+/);
    const lstart = start.join(' ');

    if (pid && ppid && pgid && lstart) running.set(Number(pid), { ppid: Number(ppid), pgid: Number(pgid), start: { lstart, at: Date.parse(lstart) } });
  }

  return running;
}

/**
 * What a record says of when process `pid` started: its identity on Linux, else ps's start, read off the event loop.
 * Undefined when no process has the pid or neither can tell.
 */
async function recordedStartOf(pid: number): Promise<{ startTicks: number; pidNamespace?: string } | { start: string } | undefined> {
  return readProcesses<{ startTicks: number; pidNamespace?: string } | { start: string }>({
    args: PROCESSES_ARGS,
    fromProc: async () => {
      const { startTicks, pidNamespace } = await identityOf(pid);

      return startTicks === undefined ? undefined : { startTicks, ...(pidNamespace !== undefined && { pidNamespace }) };
    },
    fromPs: (stdout) => {
      const start = processesOf(stdout).get(pid)?.start;

      return start !== undefined && 'lstart' in start ? { start: start.lstart } : undefined;
    },
  });
}

// ─── Process identity ───────────────────────────────────

/**
 * What a record keeps to tell the process its pid named from a later one given that pid, as a container hands pids out
 * again. On Linux `startTicks` is when it started, in clock ticks since boot, and `pidNamespace` the pid namespace its
 * pid belongs to. Elsewhere a stop's record keeps `start`, when it started as ps prints it, and a lock keeps
 * `startedAt`, a time it was running, written as an ISO date. A stop's record written before the start was read keeps
 * `spawnedAt`, the time in milliseconds its starter spawned it, and keeps it beside `startTicks` for a teamai that
 * reads no `startTicks`. Every record of a process derives its fields from this one.
 */
export const ProcessIdentitySchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.number().int().nonnegative().optional(),
  pidNamespace: z.string().min(1).optional(),
  start: z.string().min(1).optional(),
  spawnedAt: z.number().int().nonnegative().optional(),
  // Written as an ISO date, read as milliseconds; NaN when it names no time.
  startedAt: z.string().transform((at) => Date.parse(at)).optional(),
});

export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

/**
 * Whether the process with a recorded pid now is the one recorded. `other`: none has the pid, or a later one does.
 * `foreign`: another pid namespace recorded it, so its pid says nothing here. `unknown`: nothing here tells. Each caller
 * keeps its own policy for `foreign` and `unknown`.
 */
export type ProcessVerdict = 'same' | 'other' | 'foreign' | 'unknown';

/** How long before its starter read the clock a spawned process may have started: the spawn, which load slows. */
const SPAWN_LEEWAY_MS = 10_000;

/** How far a lock's time may trail its holder's start, as a clock step makes it, while still naming that holder. */
const CLOCK_STEP_MS = 5_000;

/**
 * Whether a pid recorded in pid namespace `recorded` names another process in `own`, this process's: a container and
 * its host sharing a home each read the other's pids as their own. A record that names no namespace is judged by its
 * start alone, which tells one process from another wherever it was read.
 */
function isOtherPidNamespace(recorded: string | undefined, own: string | undefined): boolean {
  return recorded !== undefined && recorded !== own;
}

let ownNamespace: Promise<string | undefined> | undefined;

/** This process's pid namespace, read once: a process never changes its own. */
function namespaceHere(): Promise<string | undefined> {
  return ownNamespace ??= ownPidNamespace();
}

/** Whether `recorded` keeps a start, or a time, that the start of a live process can be compared with. */
function keepsStart(recorded: ProcessIdentity): boolean {
  return recorded.startTicks !== undefined || recorded.start !== undefined || recorded.spawnedAt !== undefined || !Number.isNaN(recorded.startedAt ?? Number.NaN);
}

/** Whether `live`, the start of the process with the recorded pid now, if any, is the start `recorded` names. */
function verdictOf(recorded: ProcessIdentity, live: ProcessStart | undefined, namespace: string | undefined): ProcessVerdict {
  if (isOtherPidNamespace(recorded.pidNamespace, namespace)) return 'foreign';

  if (live === undefined) return 'unknown';

  if (recorded.startTicks !== undefined && 'ticks' in live) return live.ticks === recorded.startTicks ? 'same' : 'other';

  // A record an earlier teamai wrote where ps tells the start, read here from `/proc`: both count whole seconds from boot.
  if (recorded.start !== undefined) {
    return ('lstart' in live ? live.lstart === recorded.start : Math.floor(live.at / 1000) * 1000 === Date.parse(recorded.start)) ? 'same' : 'other';
  }

  // ps prints the start to the second, `/proc` counts from a boot time to the second, and the starter read the clock
  // once the spawn returned.
  if (recorded.spawnedAt !== undefined) return live.at <= recorded.spawnedAt && recorded.spawnedAt - live.at < SPAWN_LEEWAY_MS ? 'same' : 'other';

  const written = recorded.startedAt ?? Number.NaN;

  if (Number.isNaN(written)) return 'unknown';

  // ps prints the start to the second, rounded down, and on Linux it is counted from a boot time that moves with the
  // clock, so a start only seconds past the time may be the holder's under a clock that stepped since.
  return live.at > written + CLOCK_STEP_MS ? 'other' : 'same';
}

/**
 * Whether the process with `recorded`'s pid now is the one `recorded` names: by its start ticks on Linux, else by the
 * start or time the record keeps. A pid another user's process has (EPERM) is live, and so is a pid below 2. A ps read
 * `signal` cuts short, as a wait with a budget does, tells nothing: `unknown`.
 */
export async function isSameProcess(recorded: ProcessIdentity, { signal }: { signal?: AbortSignal } = {}): Promise<ProcessVerdict> {
  const namespace = await namespaceHere();

  // Its pid names another process here, or none, so neither says anything of the recorded one.
  if (isOtherPidNamespace(recorded.pidNamespace, namespace)) return 'foreign';

  // `denied`: a process has the pid, another user's. `refused`: a pid no probe may be sent to, below 2, which a teamai
  // running as pid 1 in a container records, so it is taken as live, as `mayBeRunning` takes it.
  const probe = signalPid(recorded.pid, 0);

  if (probe === 'gone') return 'other';

  if (probe === 'refused') return 'same';

  if (!keepsStart(recorded)) return 'unknown';

  return verdictOf(recorded, await liveStartOf(recorded.pid, signal), namespace);
}

/** On Linux, what tells process `pid` from a later one given its pid: when it started, and its pid namespace. Elsewhere only its pid: no ps runs for it. */
export async function identityOf(pid: number): Promise<ProcessIdentity> {
  const [startTicks, pidNamespace] = await Promise.all([processStartTicks(pid), namespaceHere()]);

  return { pid, ...(startTicks !== undefined && { startTicks }), ...(pidNamespace !== undefined && { pidNamespace }) };
}

/**
 * What a record names: a detached process group, or with `tree`, an attached command, which shares its starter's group
 * and is reached as the process and its descendants. It tells that process by `startTicks`, `start` or `spawnedAt`.
 * `starterGroup`, kept only beside `tree`, is the group the command shares with its starter when the starter led it, as
 * a terminal's job does: once that leader is gone, what is left in the group is what the starter left, children the
 * command's shell left included, which no tree from the command's pid reaches once the shell is gone. `left`, kept
 * beside `tree` by a stop that could not confirm its end, is what that stop found the command had started, which a
 * later stop ends though the command itself is gone by then.
 */
const RecordedSchema = ProcessIdentitySchema.omit({ startedAt: true })
  .and(z.union([
    z.object({
      tree: z.literal(true),
      starterGroup: z.number().int().positive().optional(),
      left: z.array(z.object({ pid: z.number().int().positive(), start: ProcessStartSchema })).optional(),
    }),
    z.object({ tree: z.undefined().optional() }),
  ]))
  .refine(keepsStart);

type Recorded = z.infer<typeof RecordedSchema>;

/** The file a teamai before #1523 wrote in a directory: the last process group started there. */
const LEGACY_GROUP_FILE = 'group.json';

/** The prefix of the files that record a process group started in a directory, one file per group. */
const GROUP_PREFIX = 'group-';

/** The name of the file that records one process group, by its pid. */
const GROUP_FILE = /^group-\d+\.json$/;

/** The ps reads still to finish for records in a directory, by its resolved path, which a stop there waits for first. */
const pendingStarts = new Map<string, Promise<void>>();

/**
 * Records in `dir` the process group `child` leads, or with `isAttached`, `child` itself, which shares its starter's
 * group, for `stopRecordedGroup` to stop once whatever started it is gone. The first record is written before this
 * returns: a starter killed right after the spawn still leaves it, which an await would widen.
 *
 * One file per group: a setup and the command of one attempt each start a group in the same directory, and the second
 * must not displace the first, or a stop of the attempt leaves the first running (#1523).
 */
export function recordGroup(child: ChildProcess, dir: string, { isAttached = false }: { isAttached?: boolean } = {}): void {
  if (child.pid === undefined) return;
  const { pid } = child;
  const file = path.join(dir, `${GROUP_PREFIX}${pid}.json`);

  // Recorded before its start is read, which through ps takes long enough for the command to start working and its
  // starter to be killed: until then the spawn time stands for the start. A teamai that reads only `start` stops nothing
  // from it, as when nothing was recorded. ps then runs off the event loop, so a step's command and its output are not
  // held while it does.
  const spawnedAt = Date.now();
  writeGroup(file, JSON.stringify({ pid, spawnedAt, ...(isAttached && { tree: true }) }));
  const recordsDir = path.resolve(dir);

  // The start is read at once; it is written after the records begun before it in `dir`, so `group.json` stays the latest.
  const settled: Promise<void> = Promise.all([recordedStartOf(pid), isAttached && leadsOwnGroup(), pendingStarts.get(recordsDir)]).then(([start, isStarterLeader]) => {
    if (pendingStarts.get(recordsDir) === settled) pendingStarts.delete(recordsDir);

    // Once this process reaped the child, its pid may name another process. A stop in another process may have removed
    // the record meanwhile: it is not written again.
    if (start === undefined || child.exitCode !== null || child.signalCode !== null || !fs.existsSync(file)) return;
    // A teamai that reads no `tree` signals a group led by this pid, which an attached command never leads: it stops nothing.
    // One that reads no `startTicks` still stops by `spawnedAt`.
    const body = JSON.stringify({ pid, ...('startTicks' in start && { spawnedAt }), ...start, ...(isAttached && { tree: true }), ...(isStarterLeader && { starterGroup: process.pid }) });
    writeGroup(file, body);
    // A teamai before #1523 reads only `group.json`, so the latest group is written there as well: a release that
    // predates the per-group files then stops one group rather than none. It reads the same group twice here, which
    // stops nothing twice.
    writeGroup(path.join(dir, LEGACY_GROUP_FILE), body);
  });

  pendingStarts.set(recordsDir, settled);
}

let isOwnGroupLeader: Promise<boolean> | undefined;

/**
 * Whether this process leads its process group, as a terminal's job does: read once, since a shell sets a job's group
 * before the job runs. False when it cannot be read.
 */
function leadsOwnGroup(): Promise<boolean> {
  return isOwnGroupLeader ??= (async () => (await ownGroups())?.pgid === process.pid)();
}

/** This process's group, and its terminal's foreground group, which is 0 or less when it has no controlling terminal. */
export interface OwnGroups { pgid: number; foreground: number }

/**
 * The groups of this process: on Linux from `/proc` (fields 5 and 8 of its stat), which a container whose ps takes no
 * -p (BusyBox), or that has no ps, still has; elsewhere from ps. Undefined on Windows and when neither can tell.
 */
export async function ownGroups(): Promise<OwnGroups | undefined> {
  if (process.platform === 'win32') return undefined;

  return readProcesses({
    args: ['-o', 'pgid=,tpgid=', '-p', String(process.pid)],
    fromProc: async () => {
      try {
        const fields = statFields(await readRegularFile('/proc/self/stat', 'utf8'));

        return fields && groupsOf(fields.pgid, fields.foreground);
      } catch {
        // No /proc: ps may tell.
        return undefined;
      }
    },
    fromPs: (stdout) => {
      const [pgid, foreground] = stdout.trim().split(/\s+/);

      return groupsOf(Number(pgid), Number(foreground));
    },
  });
}

function groupsOf(pgid: number, foreground: number): OwnGroups | undefined {
  return Number.isInteger(pgid) && pgid > 0 && Number.isInteger(foreground) ? { pgid, foreground } : undefined;
}

/** Writes the record of one process group, so a reader never sees half of it. */
function writeGroup(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, file);
  } catch {
    // The starter still stops its child itself; only a starter killed with it would leave the group running.
  }
}

/**
 * How a stop of a recorded group or command ended: it stopped it, found it ended, or could not tell whether it still
 * runs. Windows has none to reach.
 */
type StopEnd = 'stopped' | 'gone' | 'unconfirmed' | 'unreachable';

/**
 * Stops every process group, and every attached command with its descendants, recorded in `dir`, and removes the
 * records. A setup and the command of one attempt each start one there, and a stop of the attempt has to reach both.
 * Returns the pid of each it could not confirm ended, whose record stays for a later stop: one another pid namespace
 * started, and one running here that it cannot tell from a later process given its pid. On Windows, where it stops
 * nothing, none: no stop there would ever confirm one.
 */
export async function stopRecordedGroup(dir: string): Promise<number[]> {
  // A record this process is still completing is finished first, so the stop removes it rather than racing its write.
  await pendingStarts.get(path.resolve(dir));
  const namespace = await namespaceHere();
  const left = new Set<number>();

  for (const file of await recordedGroups(dir)) {
    const recorded = await readGroup(file);

    if (recorded !== undefined) {
      // A pid recorded in another pid namespace names another process here: the record is left for a stop there.
      const ended = isOtherPidNamespace(recorded.pidNamespace, namespace) ? { end: 'unconfirmed' as const } : recorded.tree ? await stopTree(recorded) : { end: await endGroup(recorded) };

      if (ended.end === 'unconfirmed') {
        // What it found running is kept, so a later stop still reaches it once the command's shell is gone.
        if ('found' in ended && ended.found.length > 0) writeGroup(file, JSON.stringify({ ...recorded, left: ended.found }));
        left.add(recorded.pid);
        continue;
      }
    }

    await fs.promises.rm(file, { force: true });
  }

  return [...left];
}

/** The files in `dir` that record a process group: one per group, and the one a teamai before #1523 wrote. */
async function recordedGroups(dir: string): Promise<string[]> {
  let names: string[];

  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => GROUP_FILE.test(name) || name === LEGACY_GROUP_FILE)
    .map((name) => path.join(dir, name));
}

/** What the file `file` records, undefined when it records nothing readable. */
async function readGroup(file: string): Promise<Recorded | undefined> {
  try {
    return RecordedSchema.parse(JSON.parse(await readRegularFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Whether `pid` may go to `kill`, which every signal here checks first: an integer above 1, as `kill` reads 0 as this
 * process's own group and -1 as every process it may signal, and 1 is init.
 */
function isSignallable(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

/**
 * What a signal sent through this module came to. `sent`: a process had the pid, or a group the id, and the signal went
 * to it (signal 0 only probes). `gone`: none has it. `denied`: one has it, another user's. `refused`: no signal went,
 * because the pid is not an integer above 1 (0 is the caller's own group, -1 every process it may signal, 1 init), or
 * a group was asked for on Windows, which has none.
 */
export type SignalOutcome = 'sent' | 'gone' | 'denied' | 'refused';

/** The one call of `kill` in teamai: every signal, to a process or to a group, goes through it. */
function sendSignal(pid: number, name: NodeJS.Signals | 0, { isGroup }: { isGroup: boolean }): SignalOutcome {
  if (!isSignallable(pid) || (isGroup && process.platform === 'win32')) return 'refused';

  try {
    process.kill(isGroup ? -pid : pid, name);

    return 'sent';
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;

    if (code === 'ESRCH') return 'gone';

    if (code === 'EPERM') return 'denied';
    throw error;
  }
}

/** Sends `name` to process `pid`, or with signal 0 tells whether it runs. Sends nothing to a pid below 2. */
export function signalPid(pid: number, name: NodeJS.Signals | 0): SignalOutcome {
  return sendSignal(pid, name, { isGroup: false });
}

/**
 * Sends `name` to `child` through its handle, which names the process it started even once its pid is reused. Sends
 * nothing to a child that never spawned: Node's kill of a handle whose spawn failed signals pid 0 until the error is
 * delivered, the caller's whole process group.
 */
export function signalChild(child: Pick<ChildProcess, 'pid' | 'kill'>, name: Parameters<ChildProcess['kill']>[0] = 'SIGTERM'): SignalOutcome {
  if (child.pid === undefined || !isSignallable(child.pid)) return 'refused';

  return child.kill(name) ? 'sent' : 'gone';
}

/**
 * Whether `pid` may name a process that runs: one another user runs counts, and so does a pid no probe may be sent to
 * (below 2, or not an integer), so a lock or a record that names it is never taken for one whose process is gone.
 */
export function mayBeRunning(pid: number): boolean {
  return signalPid(pid, 0) !== 'gone';
}

/** Sends `name` to every process of group `pgid`, or with signal 0 tells whether any runs. Sends nothing to a group below 2. */
export function signalGroup(pgid: number, name: NodeJS.Signals | 0): SignalOutcome {
  return sendSignal(pgid, name, { isGroup: true });
}

/**
 * Stops `group`, a detached process group no child handle of this process reaches, with a five-second grace period
 * before SIGKILL. A group that is gone, or whose pid now leads another process, is left alone: while any process of a
 * group lives, POSIX reuses no pid equal to its id, so a group whose leader is gone is still the one recorded. Whether
 * it signalled the group. POSIX only: Windows has no process groups to reach.
 */
export async function stopGroup(group: Recorded): Promise<boolean> {
  return await endGroup(group) === 'stopped';
}

async function endGroup(group: Recorded): Promise<StopEnd> {
  if (process.platform === 'win32') return 'unreachable';

  if (signalGroup(group.pid, 0) !== 'sent') return 'gone';
  const running = await runningProcesses();

  // Without current identities, a pid reused since cannot be told apart, so the group is left alone.
  if (!running) return 'unconfirmed';
  const leader = running.get(group.pid);
  const verdict = leader === undefined ? 'same' : verdictOf(group, leader.start, await namespaceHere());

  if (verdict === 'other') return 'gone';

  if (verdict !== 'same') return 'unconfirmed';
  signalGroup(group.pid, 'SIGTERM');

  // Counted rather than timed, so a faked clock cannot stretch the grace period.
  for (let probe = 0; signalGroup(group.pid, 0) === 'sent'; probe += 1) {
    if (probe === 100) {
      signalGroup(group.pid, 'SIGKILL');
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  return 'stopped';
}

/**
 * Stops what the attached command `recorded` left in group `pgid`, the one it shared with the starter that led it, once
 * that leader is gone: each process of the group that started when the command did or later. While any process of a
 * group lives, POSIX reuses no pid equal to its id, so a group whose id no process has is still the starter's. A process
 * with the id is the leader still running, or one leading a later group of the same id: either way the group is left
 * alone, and so is the group of this process. What ran in the group before the command, such as a server an earlier
 * step left or a pipe the starter wrote to, is left running. Whether it is done with the group: false when a process
 * read it needed failed, so the record stays for a later stop.
 */
async function stopLeftStarterGroup(recorded: Recorded, pgid: number): Promise<boolean> {
  if (signalGroup(pgid, 0) !== 'sent') return true;

  // `denied`: a process has the id, another user's.
  if (signalPid(pgid, 0) !== 'gone') return true;

  const own = (await ownGroups())?.pgid;

  // A group this process cannot tell from its own is left alone too, and a later stop looks again.
  if (own === undefined) return false;

  if (own === pgid) return true;
  const running = await runningProcesses();

  if (running === undefined) return false;

  return endProcesses([...running].flatMap(([pid, { pgid: group, start }]) => (group === pgid && pid !== process.pid && startedSince(start, recorded) ? [{ pid, start }] : [])));
}

/**
 * Whether a process that started at `live` started when the command `recorded` names did or later. False when the
 * record keeps no start to compare with.
 */
function startedSince(live: ProcessStart, recorded: Recorded): boolean {
  if (recorded.startTicks !== undefined && 'ticks' in live) return live.ticks >= recorded.startTicks;

  // ps prints a start to the second, so both are compared in whole seconds.
  if (recorded.start !== undefined) return Math.floor(live.at / 1000) * 1000 >= Date.parse(recorded.start);

  return false;
}

/** A process found running, and when it started, which tells it from a later process given its pid. */
interface FoundProcess { pid: number; start: ProcessStart }

/** Whether `found` is still running in `now`: its pid names a process that started when it did. */
function isStillRunning(now: Map<number, RunningProcess>, found: FoundProcess): boolean {
  const running = now.get(found.pid);

  return running !== undefined && isSameStart(running.start, found.start);
}

/**
 * Each descendant of process `pid`, deepest first, with when it started, as they run now; none when that cannot be
 * read. A process that daemonized away from the tree is not among them.
 */
export async function descendantsOf(pid: number): Promise<FoundProcess[]> {
  return descendantsIn(await runningProcesses() ?? new Map<number, RunningProcess>(), pid);
}

/** Each descendant of process `pid` in `running`, deepest first, with when it started. */
function descendantsIn(running: Map<number, RunningProcess>, pid: number): FoundProcess[] {
  const children = new Map<number, FoundProcess[]>();

  for (const [child, { ppid, start }] of running) {
    const siblings = children.get(ppid) ?? [];
    siblings.push({ pid: child, start });
    children.set(ppid, siblings);
  }

  const found: FoundProcess[] = [];
  const pending = [...children.get(pid) ?? []];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    found.push(next);
    pending.push(...children.get(next.pid) ?? []);
  }

  return found.toReversed();
}

/**
 * Stops `recorded`, an attached command no child handle of this process reaches, and each process it started, with a
 * five-second grace period before SIGKILL. A command whose pid now names a process started at another time is left
 * alone, as `stopGroup` leaves a group. Then the group it shared with the starter that led it, once that leader is
 * gone, which reaches what the command's shell left after it died. POSIX only.
 */
async function stopTree(recorded: Recorded & { tree: true }): Promise<{ end: StopEnd; found: FoundProcess[] }> {
  if (process.platform === 'win32') return { end: 'unreachable', found: [] };
  const ended = await stopRecordedTree(recorded);

  if (recorded.starterGroup !== undefined && !await stopLeftStarterGroup(recorded, recorded.starterGroup)) {
    return { end: 'unconfirmed', found: ended.end === 'unconfirmed' ? ended.found : [] };
  }

  return ended;
}

/**
 * Stops the attached command `recorded` names, the processes it started that still descend from it, and those an
 * earlier stop found it had started. With what it found running, for the record a later stop reads.
 */
async function stopRecordedTree(recorded: Recorded & { tree: true }): Promise<{ end: StopEnd; found: FoundProcess[] }> {
  const earlier = recorded.left ?? [];
  const running = await runningProcesses();

  if (running === undefined) return { end: 'unconfirmed', found: earlier };
  const rootStart = running.get(recorded.pid)?.start;
  const verdict = rootStart === undefined ? 'other' : verdictOf(recorded, rootStart, await namespaceHere());

  if (verdict === 'unknown' || verdict === 'foreign') return { end: 'unconfirmed', found: earlier };
  // What it started comes from the table that found it: a second read that failed would read as nothing started.
  const descendants = rootStart === undefined || verdict === 'other' ? [] : [...descendantsIn(running, recorded.pid), { pid: recorded.pid, start: rootStart }];
  const found = [...earlier.filter((kept) => isStillRunning(running, kept) && !descendants.some(({ pid }) => pid === kept.pid)), ...descendants];

  if (found.length === 0) return { end: 'gone', found };

  return { end: await endProcesses(found) ? 'stopped' : 'unconfirmed', found };
}

/**
 * Stops each process of `found` that still runs as found, with a five-second grace period before SIGKILL. Whether it
 * saw them end, or killed them: false once the process table cannot be read, as with a ps past its timeout, since a pid
 * reused since cannot be told apart and none is signalled blind.
 */
async function endProcesses(found: FoundProcess[]): Promise<boolean> {
  const signal = (name: NodeJS.Signals | 0): Promise<boolean | undefined> => signalStillRunning(found, name);

  if (await signal('SIGTERM') === undefined) return false;

  // Counted rather than timed, so a faked clock cannot stretch the grace period.
  for (let probe = 0; ; probe += 1) {
    const isRunning = await signal(0);

    if (isRunning !== true) return isRunning === false;

    if (probe === 100) return await signal('SIGKILL') !== undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Sends `name` to each process of `found`, as `descendantsOf` found them, that still runs as found: its pid names a
 * process that started when it did, so a process given a pid since it was found gets nothing. Whether the signal
 * reached any; undefined when the process table cannot be read, and then none is signalled blind.
 */
export async function signalStillRunning(found: readonly FoundProcess[], name: NodeJS.Signals | 0): Promise<boolean | undefined> {
  const now = await runningProcesses();

  return now === undefined ? undefined : found.filter((listed) => isStillRunning(now, listed)).reduce((reached, { pid }) => signalPid(pid, name) === 'sent' || reached, false);
}

/** Stops a detached process group or an attached process tree, with a five-second grace period before SIGKILL. */
export function stopProcess<T>(child: ChildProcess, exit: Promise<T>, detached: boolean): (signal?: NodeJS.Signals) => Promise<T> {
  let stopping: Promise<T> | undefined;
  let descendants: FoundProcess[] = [];

  /** Whether the signal reached any process in the group or tree of `pid`, the child's. */
  const signal = async (pid: number, name: NodeJS.Signals | 0): Promise<boolean> => {
    try {
      if (detached) return signalGroup(pid, name) === 'sent';
      let targets = descendants;

      if ((name === 0 || name === 'SIGKILL') && descendants.length > 0) {
        // Without current identities, stop only the shell.
        const now = await runningProcesses() ?? new Map<number, RunningProcess>();
        // ps's lstart has one-second resolution and the check is not atomic with kill, so this narrows the window but does not close it.
        targets = descendants.filter((found) => isStillRunning(now, found));
      }

      const reached = targets.reduce((any, found) => signalPid(found.pid, name) === 'sent' || any, false);

      return signalChild(child, name) === 'sent' || reached;
    } catch {
      return false;
    }
  };

  const stop = async (initial: NodeJS.Signals): Promise<T> => {
    const { pid } = child;

    // A child whose spawn failed has no pid, and Node's kill of its handle signals pid 0: this process's whole group.
    if (pid === undefined) return exit;

    if (process.platform === 'win32') {
      // Windows opens a console for a child of a process without one, such as a hook's teamai.
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});

      return exit;
    }

    if (!detached) descendants = await descendantsOf(pid);

    await signal(pid, initial);
    let timer: NodeJS.Timeout | undefined;
    let escalated = false;

    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => { escalated = true; void signal(pid, 'SIGKILL').then(() => { resolve(); }); }, 5000);
    });

    const result = await exit;

    // A process with its own output can ignore SIGTERM and outlive the shell. Keep SIGKILL while any captured
    // descendant or process in the detached group remains.
    // Descendants may still be exiting when the shell closes. Recheck instead
    // of waiting the whole grace period after that first successful probe.
    // `escalated` flips inside the setTimeout closure registered above, which the linter can't see.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (!escalated && await signal(pid, 0)) {
      await Promise.race([killed, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }

    clearTimeout(timer);

    // A SIGKILL begun once the grace period ran out ends before the stop does.
    if (escalated) await killed;

    return result;
  };

  return (initial = 'SIGTERM') => (stopping ??= stop(initial));
}

/**
 * When the process `pid` started, in clock ticks since the machine booted (field 22 of `/proc/<pid>/stat`): a value no
 * change of the wall clock moves. Only Linux has it; undefined elsewhere, or when no process has the pid.
 */
async function processStartTicks(pid: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;

  try {
    return statFields(await readRegularFile(`/proc/${pid}/stat`, 'utf8'))?.ticks;
  } catch {
    return undefined;
  }
}

/**
 * The pid namespace of this process, as `/proc/self/ns/pid` links it (`pid:[4026531836]`): a pid names a process only
 * inside it, so a container and its host each read the other's pids as their own. Only Linux has it.
 */
async function ownPidNamespace(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;

  try {
    return await fs.promises.readlink('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/**
 * When the process `pid` started: on Linux from `/proc`, which a container without a full `ps` still has, elsewhere as
 * `ps -o lstart=` prints it, to the second. Undefined when no process has the pid or neither can tell.
 */
async function liveStartOf(pid: number, signal?: AbortSignal): Promise<ProcessStart | undefined> {
  const ticks = await processStartTicks(pid);

  const start = await readProcesses<ProcessStart>({
    args: ['-o', 'lstart=', '-p', String(pid)],
    ...(signal !== undefined && { signal }),
    fromProc: async () => {
      if (ticks === undefined) return undefined;

      try {
        const boot = bootTime(await readRegularFile('/proc/stat', 'utf8'));

        return boot === undefined ? undefined : tickStart(ticks, boot);
      } catch {
        // No /proc/stat: the ticks still tell, and ps may tell the time.
        return undefined;
      }
    },
    fromPs: (stdout) => {
      const lstart = stdout.trim();
      const at = Date.parse(lstart);

      if (ticks !== undefined) return { ticks, at };

      return lstart === '' ? undefined : { lstart, at };
    },
  });

  return start ?? (ticks === undefined ? undefined : { ticks, at: Number.NaN });
}
