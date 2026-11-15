import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import diagnostics from 'node:diagnostics_channel';
import { descendantsOf, identityOf, isSameProcess, mayBeRunning, ownGroups, PROCESS_READ_CHANNEL, recordGroup, signalChild, signalGroup, signalPid, signalStillRunning, stopGroup, stopProcess, stopRecordedGroup } from './process-group.js';

/** Whether this platform tells start times through ps rather than `/proc`, so a fake ps on PATH is what is read. */
const READS_PS = process.platform !== 'win32' && process.platform !== 'linux';

// execFile passes through to Node's, so a test can see what the module would start without starting it.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

/**
 * A child handle with pid `pid` that no process backs and no native handle holds. `new ChildProcess()` holds one that
 * never spawned, whose real kill, once a test's spy is restored, signals pid 0: the whole process group of the test run.
 */
function unspawnedChild(pid: number): ChildProcess {
  const child: ChildProcess = Object.create(ChildProcess.prototype);
  Object.defineProperty(child, 'pid', { value: pid });
  return child;
}

// kill(0) and kill(-0) signal the caller's own group, kill(-1) every process it may signal, and kill(1) init.
it.each([0, -0, 1, -1, -4242, Number.NaN, 2.5, Number.MAX_SAFE_INTEGER + 1])('sends no signal to pid %s, nor to a group of that id', (pid) => {
  // Spied, so a regression reaches no process: these targets would signal the whole test run, or every process of its user.
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

  expect(signalPid(pid, 'SIGTERM')).toBe('refused');
  expect(signalPid(pid, 0)).toBe('refused');
  expect(signalGroup(pid, 'SIGKILL')).toBe('refused');
  expect(processKill).not.toHaveBeenCalled();
});

it('tells a pid another user\'s process has from one no process has', () => {
  vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); })
    .mockImplementationOnce(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });

  expect(signalPid(4242, 0)).toBe('denied');
  expect(signalPid(4242, 0)).toBe('gone');
});

it('takes for gone only a pid no process has, never one another user runs or one no probe may be sent to', () => {
  vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); })
    .mockImplementationOnce(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });

  expect([mayBeRunning(4242), mayBeRunning(4242)]).toEqual([true, false]);
  // teamai may run as pid 1 in a container, and a corrupt record's pid cannot be read: neither is taken for gone.
  expect([0, 1, Number.NaN, -4242, 2.5].map(mayBeRunning)).toEqual([true, true, true, true, true]);
});

it.skipIf(process.platform === 'win32')('signals the group it is given and no process outside it, then tells the group is gone', async () => {
  // The bystander shares this test run's group, which a signal to pid 0 would reach.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const group = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const ended = new Promise<NodeJS.Signals | null>((resolve) => { group.once('close', (_code, signal) => resolve(signal)); });
  try {
    await Promise.all([bystander, group].map((child) => new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); })));
    const pgid = group.pid ?? Number.NaN;

    expect(signalGroup(pgid, 0)).toBe('sent');
    expect(signalGroup(pgid, 'SIGKILL')).toBe('sent');
    expect(await ended).toBe('SIGKILL');
    expect(signalGroup(pgid, 0)).toBe('gone');
    expect(signalPid(pgid, 0)).toBe('gone');
    expect(signalPid(bystander.pid ?? Number.NaN, 0)).toBe('sent');
  } finally {
    bystander.kill('SIGKILL');
    group.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('signals a process found earlier only while its pid still names the process found', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once('exit', (_code, signal) => resolve(signal)); });
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const found = (await descendantsOf(process.pid)).find(({ pid }) => pid === child.pid);
    if (found === undefined) throw new Error('the child was not found under this process');
    // The pid as a later process given it would have it: the same number, started at another time.
    const later = { pid: found.pid, start: 'ticks' in found.start ? { ...found.start, ticks: found.start.ticks + 1 } : { ...found.start, lstart: 'Thu Jan  1 00:00:00 1970' } };

    expect(await signalStillRunning([later], 'SIGTERM')).toBe(false);
    expect(signalPid(found.pid, 0)).toBe('sent');
    expect(await signalStillRunning([found], 'SIGTERM')).toBe(true);
    expect(await exited).toBe('SIGTERM');
  } finally {
    child.kill('SIGKILL');
  }
});

it.runIf(process.platform === 'win32')('signals no group on Windows, which has none', () => {
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

  expect(signalGroup(4242, 'SIGTERM')).toBe('refused');
  expect(processKill).not.toHaveBeenCalled();
});

it('stops a child on Windows through taskkill with no console window, as a hook-launched teamai has no console', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const taskkill = vi.mocked(execFile).mockImplementationOnce((() => unspawnedChild(1)) as unknown as typeof execFile);

  expect(await stopProcess(unspawnedChild(2147483647), Promise.resolve('closed'), false)()).toBe('closed');
  expect(taskkill).toHaveBeenCalledWith('taskkill', ['/pid', '2147483647', '/T', '/F'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
});

it('stops an attached child through child.kill without probing other PIDs', async () => {
  const child = unspawnedChild(2147483647);
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await stopProcess(child, Promise.resolve('closed'), false)()).toBe('closed');
  expect(kill.mock.calls).toEqual([['SIGTERM'], [0]]);
  expect(processKill).not.toHaveBeenCalled();
});

it.each([false, true])('signals nothing for a child whose spawn failed, whose handle would signal pid 0, this process\'s whole group (detached: %s)', async (detached) => {
  const child = spawn(path.join(os.tmpdir(), 'teamai-no-such-command'), [], { detached, stdio: 'ignore' });
  const failed = new Promise<string>((resolve) => { child.once('error', (error) => resolve(z.object({ code: z.string() }).parse(error).code)); });
  // Spied before the stop, so a regression reaches no process: Node's kill of this handle would send SIGTERM to pid 0.
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

  expect(await stopProcess(child, failed, detached)()).toBe('ENOENT');
  expect(kill).not.toHaveBeenCalled();
  expect(processKill).not.toHaveBeenCalled();
});

it('sends nothing through the handle of a child whose spawn failed, in the tick it failed, when the handle would signal pid 0', async () => {
  const child = spawn(path.join(os.tmpdir(), 'teamai-no-such-command'), [], { stdio: 'ignore' });
  const failed = new Promise<string>((resolve) => { child.once('error', (error) => resolve(z.object({ code: z.string() }).parse(error).code)); });
  // Spied, so a regression reaches no process.
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);

  expect(signalChild(child, 'SIGKILL')).toBe('refused');
  expect(kill).not.toHaveBeenCalled();
  expect(await failed).toBe('ENOENT');
});

it('gives an attached child five seconds before SIGKILL and waits for its exit', async () => {
  // The read of its descendants (ps, which finds none on an empty PATH, or /proc on Linux) runs in real time before the
  // SIGTERM; only the grace period after it counts on the faked clock.
  vi.stubEnv('PATH', '');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const child = unspawnedChild(2147483647);
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  let finish = (): void => {};
  const exit = new Promise<void>((resolve) => { finish = resolve; });
  const stop = stopProcess(child, exit, false);
  const stopping = stop();
  expect(stop()).toBe(stopping);
  while (kill.mock.calls.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  await vi.advanceTimersByTimeAsync(4999);
  expect(kill.mock.calls).toEqual([['SIGTERM']]);
  await vi.advanceTimersByTimeAsync(1);
  expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  finish();
  await stopping;
});

it('finishes promptly when a signalled group disappears shortly after the shell exits', async () => {
  vi.useFakeTimers();
  const child = unspawnedChild(2147483647);
  let probes = 0;
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && ++probes > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  let ended = false;
  const stopping = stopProcess(child, Promise.resolve('closed'), true)().then(() => { ended = true; });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toBe(true);
  } finally { await vi.runAllTimersAsync(); await stopping; }
});

it('stops a detached group that outlives its child', async () => {
  vi.useFakeTimers();
  const child = unspawnedChild(2147483647);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const stopping = stopProcess(child, Promise.resolve('closed'), true)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await stopping).toBe('closed');
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-2147483647, 'SIGTERM'], [-2147483647, 'SIGKILL']]);
  expect(kill).toHaveBeenCalledWith(-2147483647, 0);
});

it.skipIf(process.platform === 'win32')('stops an attached command when ps is unavailable', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const exit = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('close', (_code, signal) => resolve(signal));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    vi.stubEnv('PATH', '');
    expect(await stopProcess(child, exit, false)()).toBe('SIGTERM');
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
});

it.runIf(READS_PS)('only escalates captured descendants with the same start time, including reparented survivors', async () => {
  // On the real clock: the grace period runs out while ps, which runs off the event loop, answers in real time.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const snapshot = path.join(directory, 'snapshot');
  const child = unspawnedChild(424242);
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGTERM') {
      fs.writeFileSync(snapshot, '424243 1 424242 Sun Oct 18 10:00:01 2026\n424244 424242 424242 Sun Oct 18 10:00:00 2026\n424245 1 424242 Sun Oct 18 10:00:00 2026\n');
    }
    return true;
  });
  try {
    fs.writeFileSync(snapshot, '424243 424242 424242 Sun Oct 18 10:00:00 2026\n424244 424242 424242 Sun Oct 18 10:00:00 2026\n424245 424244 424242 Sun Oct 18 10:00:00 2026\n');
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
case "$3" in
  pid=,ppid=*) /bin/cat "${snapshot}" ;;
  pid=,lstart=) while read -r pid parent group start; do echo "$pid $start"; done < "${snapshot}" ;;
esac
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    expect(await stopping).toBe('closed');
    for (const pid of [424243, 424244, 424245]) expect(processKill).toHaveBeenCalledWith(pid, 'SIGTERM');
    expect(processKill).not.toHaveBeenCalledWith(424243, 0);
    expect(processKill).not.toHaveBeenCalledWith(424243, 'SIGKILL');
    for (const pid of [424244, 424245]) {
      expect(processKill).toHaveBeenCalledWith(pid, 0);
      expect(processKill).toHaveBeenCalledWith(pid, 'SIGKILL');
    }
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(READS_PS)('escalates only the shell when the current process snapshot fails', async () => {
  // On the real clock: the grace period runs out while ps, which runs off the event loop, answers in real time.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const child = unspawnedChild(424242);
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    // The first snapshot, taken before the stop, lists a descendant; every later one fails.
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
[ -e "${directory}/listed" ] && exit 1
: > "${directory}/listed"
echo '424243 424242 Sun Oct 18 10:00:00 2026'
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    expect(await stopping).toBe('closed');
    expect(processKill.mock.calls).toEqual([[424243, 'SIGTERM']]);
    expect(kill.mock.calls.filter(([signal]) => signal !== 0)).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(kill).toHaveBeenCalledWith(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Starts a detached shell that leads its own group and keeps a `sleep` in it, as a command's shell does. */
async function detachedGroup() {
  const shell = spawn('sh', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    shell.once('spawn', resolve);
    shell.once('error', reject);
  });
  const pid = shell.pid;
  if (pid === undefined) throw new Error('the detached shell has no pid');
  const alive = (): boolean => {
    return signalGroup(pid, 0) === 'sent';
  };
  return { shell, pid, alive };
}

/** The record `recordGroup` keeps of `pid` in `records`, once it says when the process started. */
async function completedRecord(records: string, pid: number): Promise<Record<string, unknown>> {
  const file = path.join(records, `group-${pid}.json`);
  let record: Record<string, unknown> = {};
  await vi.waitFor(() => {
    record = z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect('startTicks' in record || 'start' in record).toBe(true);
  }, { timeout: 5000 });
  return record;
}

it.skipIf(process.platform === 'win32')('stops a detached group whose shell was killed, from what was recorded of it', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-killed-'));
  const { shell, pid, alive } = await detachedGroup();
  try {
    recordGroup(shell, records);
    await completedRecord(records, pid);
    const closed = new Promise((resolve) => { shell.once('close', resolve); });
    signalPid(pid, 'SIGKILL');
    await closed;
    expect(alive()).toBe(true);
    await stopRecordedGroup(records);
    expect(alive()).toBe(false);
  } finally {
    signalGroup(pid, 'SIGKILL');
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('leaves a group alone when its pid now leads a process started at another time', async () => {
  const { pid, alive } = await detachedGroup();
  try {
    expect(await stopGroup({ pid, start: 'Thu Jan  1 00:00:00 1970' })).toBe(false);
    expect(alive()).toBe(true);
  } finally {
    signalGroup(pid, 'SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('stops every group recorded in a directory, not only the last one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-groups-'));
  const first = await detachedGroup();
  const second = await detachedGroup();
  try {
    recordGroup(first.shell, directory);
    recordGroup(second.shell, directory);
    await stopRecordedGroup(directory);
    expect(first.alive()).toBe(false);
    expect(second.alive()).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    for (const group of [first, second]) {
      signalGroup(group.pid, 'SIGKILL');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group whose starter was killed before ps told it when the group started', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-unread-'));
  const group = await detachedGroup();
  try {
    // No ps answers while the starter records the group, as when it is killed before ps does.
    vi.stubEnv('PATH', '');
    recordGroup(group.shell, directory);
    vi.unstubAllEnvs();

    await stopRecordedGroup(directory);

    expect(group.alive()).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group recorded before ps answered where ps prints dates in the person\'s language', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-locale-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  // A ps that prints in Chinese, as under a Chinese locale, unless asked for the C locale.
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\n[ "$LC_ALL" = C ] || export LC_ALL=zh_CN.UTF-8\nexec /bin/ps "$@"\n', { mode: 0o755 });
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', '');
    recordGroup(group.shell, records);
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory with a `ps` that answers after `seconds`, as on a loaded machine, and the records folder. */
function slowPs(seconds: number): { directory: string; bin: string; records: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-slow-ps-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nsleep ${seconds}\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return { directory, bin, records };
}

it.runIf(READS_PS)('records a group without holding the event loop while ps answers', async () => {
  const { directory, bin, records } = slowPs(1.5);
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const started = performance.now();
    const fired = new Promise<number>((resolve) => { setTimeout(() => resolve(performance.now() - started), 10); });
    recordGroup(group.shell, records);
    vi.unstubAllEnvs();

    expect(await fired).toBeLessThan(1000);
    const file = path.join(records, `group-${group.pid}.json`);
    await vi.waitFor(() => { expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: group.pid, start: expect.any(String) }); }, { timeout: 5000 });
    expect(fs.readFileSync(path.join(records, 'group.json'), 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group recorded while ps has not answered yet, and leaves no record behind', async () => {
  const { directory, bin, records } = slowPs(0.6);
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(group.shell, records);
    vi.unstubAllEnvs();

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
    // Past the time ps takes to answer, so a write it made after the stop would show.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.readdirSync(records)).toEqual([]);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory whose `ps` answers as BusyBox's does, which prints no start time: no `lstart`, no `-p`. */
function busyboxPs(): { directory: string; bin: string; records: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-busybox-ps-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: bad -o argument \'lstart\'" >&2\nexit 1\n', { mode: 0o755 });
  return { directory, bin, records };
}

/** Whether process `pid` is still running. */
function isRunning(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

it.runIf(process.platform === 'linux')('stops a recorded group where ps cannot tell when a process started, as in an Alpine container', async () => {
  const { directory, bin, records } = busyboxPs();
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(group.shell, records);

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a recorded attached command and what it started where ps cannot tell when a process started', async () => {
  const { directory, bin, records } = busyboxPs();
  const shell = spawn('sh', ['-c', 'sleep 300 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const sleeper = await new Promise<number>((resolve, reject) => {
    shell.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    shell.once('error', reject);
  });
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(shell, records, { isAttached: true });

    await stopRecordedGroup(records);

    await vi.waitFor(() => { expect(isRunning(sleeper)).toBe(false); }, { timeout: 2000 });
    await vi.waitFor(() => { expect(shell.signalCode ?? shell.exitCode).not.toBeNull(); }, { timeout: 2000 });
  } finally {
    signalPid(sleeper, 'SIGKILL');
    shell.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** When process `pid` started, in clock ticks since boot, as the kernel reports it in field 22 of `/proc/<pid>/stat`. */
function kernelStartTicks(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

it.runIf(process.platform === 'linux')('leaves a recorded group alone when its record names another pid namespace', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-namespace-'));
  const group = await detachedGroup();
  try {
    // Written in a container sharing this home: its pid and start name a process only in its own namespace.
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, startTicks: kernelStartTicks(group.pid), pidNamespace: 'pid:[1]' }));

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(true);
    // Kept for a stop in that namespace, which can still tell its process.
    expect(fs.existsSync(path.join(records, `group-${group.pid}.json`))).toBe(true);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('keeps the spawn time in a record whose start /proc tells, which a teamai that reads no startTicks stops by', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-record-spawned-'));
  const group = await detachedGroup();
  try {
    recordGroup(group.shell, records);

    expect(await completedRecord(records, group.pid)).toMatchObject({ pid: group.pid, startTicks: kernelStartTicks(group.pid), spawnedAt: expect.any(Number) });
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a recorded group whose record has its start but no pid namespace, as a teamai that could not read its namespace writes', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-no-namespace-'));
  const group = await detachedGroup();
  try {
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, startTicks: kernelStartTicks(group.pid) }));

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a group an earlier teamai recorded with the start ps printed', async ({ skip }) => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-lstart-'));
  const group = await detachedGroup();
  try {
    let start = '';
    try {
      start = execFileSync('ps', ['-o', 'lstart=', '-p', String(group.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    } catch {
      skip('this ps prints no start time (BusyBox)');
    }
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, start }));
    const closed = new Promise((resolve) => { group.shell.once('close', resolve); });
    signalPid(group.pid, 'SIGKILL');
    await closed;

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    signalGroup(group.pid, 'SIGKILL');
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('tells the process a record names from a later one given its pid, by the time the record keeps', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const spawnedAt = Date.now();
  try {
    const { pid } = child;
    if (pid === undefined) throw new Error('sleep did not start');

    expect(await isSameProcess({ pid, spawnedAt })).toBe('same');
    expect(await isSameProcess({ pid, spawnedAt: spawnedAt - 3_600_000 })).toBe('other');
    expect(await isSameProcess({ pid, startedAt: spawnedAt + 1000 })).toBe('same');
    expect(await isSameProcess({ pid, startedAt: spawnedAt - 3_600_000 })).toBe('other');
    expect(await isSameProcess({ pid })).toBe('unknown');
    expect(await isSameProcess({ pid: 2147483646 })).toBe('other');

    // kill(0) reads this process's own group and kill(1) init, so neither is probed. teamai runs as pid 1 in a container,
    // so a record of either is taken as live, as mayBeRunning takes it, and what it holds is never taken from it.
    const probe = vi.spyOn(process, 'kill');
    expect(await isSameProcess({ pid: 0, spawnedAt })).toBe('same');
    expect(await isSameProcess({ pid: 1, spawnedAt })).toBe('same');
    expect(probe).not.toHaveBeenCalled();
  } finally {
    child.kill('SIGKILL');
  }
});

it.runIf(process.platform === 'linux')('tells a process by its start ticks, and leaves one another pid namespace recorded to that namespace', async () => {
  const own = await identityOf(process.pid);

  expect(own).toEqual({ pid: process.pid, startTicks: kernelStartTicks(process.pid), pidNamespace: fs.readlinkSync('/proc/self/ns/pid') });
  expect(await isSameProcess(own)).toBe('same');
  expect(await isSameProcess({ ...own, startTicks: kernelStartTicks(process.pid) + 1 })).toBe('other');
  expect(await isSameProcess({ ...own, pidNamespace: 'pid:[1]' })).toBe('foreign');
});

/** What a record keeps of when process `pid` started: its ticks on Linux, else ps's start. */
async function recordedStart(pid: number): Promise<{ startTicks?: number } | { start: string }> {
  return process.platform === 'linux'
    ? { startTicks: (await identityOf(pid)).startTicks }
    : { start: execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim() };
}

/** A detached shell that starts `sleep 600` in its group and prints its pid, then exits, or with `stays`, waits for it. */
async function groupWithMember(stays: boolean): Promise<{ leader: number; member: number }> {
  const shell = spawn('sh', ['-c', `sleep 600 & echo $!${stays ? '; wait' : ''}`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const member = await new Promise<number>((resolve) => { shell.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim()))); });

  // 'exit', not 'close': the sleep holds the shell's stdout open.
  if (!stays) await new Promise((resolve) => shell.once('exit', resolve));

  if (shell.pid === undefined) throw new Error('sh did not start');

  return { leader: shell.pid, member };
}

it.skipIf(process.platform === 'win32')('stops the group an attached command shared with its starter once that group\'s leader is gone, members its shell left included', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-starter-group-'));
  const { leader, member } = await groupWithMember(false);
  try {
    // The command's shell and its starter, which led the group, are gone; the command's child is left in the group.
    fs.writeFileSync(path.join(directory, `group-${leader}.json`), JSON.stringify({ pid: leader, ...await recordedStart(member), tree: true, starterGroup: leader }));
    expect(isRunning(member)).toBe(true);

    await stopRecordedGroup(directory);

    expect(isRunning(member)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    signalGroup(leader, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('leaves the group an attached command shared with its starter while that group\'s leader still runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-starter-group-'));
  const { leader, member } = await groupWithMember(true);
  try {
    // The command's pid names no process: only the group it shared with its starter is left to judge.
    fs.writeFileSync(path.join(directory, `group-${member}.json`), JSON.stringify({ pid: 2147483646, ...await recordedStart(member), tree: true, starterGroup: leader }));

    await stopRecordedGroup(directory);

    expect(isRunning(leader)).toBe(true);
    expect(isRunning(member)).toBe(true);
  } finally {
    signalGroup(leader, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(READS_PS)('leaves the group an attached command shared with its starter when it cannot tell its own group', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-starter-group-'));
  const { leader, member } = await groupWithMember(false);
  try {
    fs.writeFileSync(path.join(directory, `group-${leader}.json`), JSON.stringify({ pid: leader, ...await recordedStart(member), tree: true, starterGroup: leader }));
    // No ps to tell this process's group, which the group to stop might be.
    vi.stubEnv('PATH', '');

    await stopRecordedGroup(directory);

    expect(isRunning(member)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    signalGroup(leader, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops only what started in the starter\'s group since the command did, leaving what ran there before it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-starter-group-'));
  // The group's leader starts a daemon, as an earlier step may leave one, then, a second later, the command's child.
  const shell = spawn('sh', ['-c', 'sleep 600 & echo $!; sleep 1.2; sleep 601 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const pids = await new Promise<number[]>((resolve) => {
    let printed = '';
    shell.stdout.on('data', (chunk: Buffer) => {
      printed += String(chunk);
      const found = printed.trim().split(/\s+/).map(Number);
      if (found.length === 2) resolve(found);
    });
  });
  await new Promise((resolve) => shell.once('exit', resolve));
  if (shell.pid === undefined) throw new Error('sh did not start');
  const leader = shell.pid;
  const [daemon, child] = pids as [number, number];
  try {
    // The command started when its child did, to the second; its pid names no process now.
    fs.writeFileSync(path.join(directory, `group-${leader}.json`), JSON.stringify({ pid: 2147483646, ...await recordedStart(child), tree: true, starterGroup: leader }));

    await stopRecordedGroup(directory);

    expect(isRunning(child)).toBe(false);
    expect(isRunning(daemon)).toBe(true);
  } finally {
    signalGroup(leader, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(READS_PS)('lets a timer fire on time while it stops an attached command and what it left, however long ps takes', async () => {
  const { directory, bin } = slowPs(0.5);
  const shell = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const left = await new Promise<number>((resolve) => { shell.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))); });
  const exit = new Promise<void>((resolve) => { shell.once('exit', () => resolve()); });
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const lags: number[] = [];
    let last = performance.now();
    const lagTimer = setInterval(() => { const now = performance.now(); lags.push(now - last); last = now; }, 10);
    await stopProcess(shell, exit, false)();
    clearInterval(lagTimer);
    vi.unstubAllEnvs();

    expect(isRunning(left)).toBe(false);
    expect(Math.max(...lags)).toBeLessThan(250);
  } finally {
    signalPid(left, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  // The stop may wait out its five-second grace, with each ps it runs taking half a second.
}, 20_000);

/** A directory with a `ps` that fails the calls `failing` counts (from 1), as one past its timeout, and answers the rest. */
function psFailing(failing: (call: number) => boolean, upTo = 20): { directory: string; bin: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-failing-ps-'));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const fails = Array.from({ length: upTo }, (_, at) => at + 1).filter(failing).join(' ');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho . >> "${directory}/calls"\ncall=$(wc -l < "${directory}/calls" | tr -d ' ')\nfor n in ${fails}; do [ "$call" = "$n" ] && exit 1; done\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return { directory, bin };
}

/** A directory with a `ps` that answers its first `times` calls and fails every later one, as one past its timeout. */
function psAnswering(times: number): { directory: string; bin: string } {
  return psFailing((call) => call > times);
}

/** An attached shell whose child ignores SIGTERM, as a tool that traps it does; the shell itself ends on it. */
async function shellLeavingDeafChild(): Promise<{ shell: ChildProcess; deaf: number; exit: Promise<void> }> {
  const shell = spawn('/bin/sh', ['-c', '(trap "" TERM; exec sleep 30) & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const deaf = await new Promise<number>((resolve) => { shell.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))); });
  const exit = new Promise<void>((resolve) => { shell.once('exit', () => resolve()); });

  return { shell, deaf, exit };
}

it.runIf(READS_PS)('keeps the record of an attached command whose stop ps stopped answering before it saw the command\'s processes end', async () => {
  const { directory, bin } = psAnswering(3);
  const { shell, deaf, exit } = await shellLeavingDeafChild();
  const records = path.join(directory, 'records');
  fs.mkdirSync(records);
  const pid = shell.pid ?? 0;
  try {
    fs.writeFileSync(path.join(records, `group-${pid}.json`), JSON.stringify({ pid, ...await recordedStart(pid), tree: true }));
    // The reads that find the command and what it started answer; the ones that would see them end do not.
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const left = await stopRecordedGroup(records);
    vi.unstubAllEnvs();
    await exit;

    expect(isRunning(deaf)).toBe(true);
    expect(left).toEqual([pid]);
    expect(fs.existsSync(path.join(records, `group-${pid}.json`))).toBe(true);

    // A later stop, ps answering again, still reaches what the command started, though the command itself is gone.
    expect(await stopRecordedGroup(records)).toEqual([]);
    expect(isRunning(deaf)).toBe(false);
  } finally {
    signalPid(deaf, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.runIf(READS_PS)('keeps the record of an attached command, with what it started, when ps fails on the read after the one that found it', async () => {
  // The read that finds the command answers, the next one does not, and every later one answers.
  const { directory, bin } = psFailing((call) => call === 2);
  const { shell, deaf } = await shellLeavingDeafChild();
  const records = path.join(directory, 'records');
  fs.mkdirSync(records);
  const pid = shell.pid ?? 0;
  try {
    fs.writeFileSync(path.join(records, `group-${pid}.json`), JSON.stringify({ pid, ...await recordedStart(pid), tree: true }));
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const left = await stopRecordedGroup(records);
    vi.unstubAllEnvs();

    // Nothing is signalled blind, and the record names what the read that found the command found it had started.
    expect(isRunning(deaf)).toBe(true);
    expect(left).toEqual([pid]);
    const kept = JSON.parse(fs.readFileSync(path.join(records, `group-${pid}.json`), 'utf8')) as { left?: { pid: number }[] };
    expect(kept.left?.map(({ pid: found }) => found)).toContain(deaf);
  } finally {
    vi.unstubAllEnvs();
    for (const left of [deaf, pid]) signalPid(left, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.runIf(READS_PS)('keeps the record of an attached command whose starter\'s group ps stopped answering before it saw stop', async () => {
  const { directory, bin } = psAnswering(4);
  const records = path.join(directory, 'records');
  fs.mkdirSync(records);
  const { leader, member } = await groupWithMember(false);
  try {
    // The command's pid names no process: only the group it shared with its starter is left to stop.
    fs.writeFileSync(path.join(records, `group-${member}.json`), JSON.stringify({ pid: 2147483646, ...await recordedStart(member), tree: true, starterGroup: leader }));
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const left = await stopRecordedGroup(records);
    vi.unstubAllEnvs();

    expect(left).toEqual([2147483646]);
    expect(fs.existsSync(path.join(records, `group-${member}.json`))).toBe(true);
  } finally {
    signalGroup(leader, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.skipIf(process.platform === 'win32')('tells each process read once, with the ps it ran or stands for, on every platform', async () => {
  const told: unknown[] = [];
  const listen = (message: unknown): void => { told.push(message); };
  diagnostics.subscribe(PROCESS_READ_CHANNEL, listen);
  try {
    expect(await isSameProcess({ pid: process.pid, startedAt: Date.now() })).toBe('same');
    expect(await ownGroups()).toBeDefined();
  } finally {
    diagnostics.unsubscribe(PROCESS_READ_CHANNEL, listen);
  }

  const spawned = process.platform !== 'linux';
  expect(told).toEqual([
    { ps: ['-o', 'lstart=', '-p', String(process.pid)], spawned },
    { ps: ['-o', 'pgid=,tpgid=', '-p', String(process.pid)], spawned },
  ]);
});
