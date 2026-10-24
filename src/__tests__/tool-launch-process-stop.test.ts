import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stopProcess } from '../tool-launch/process-stop.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('stops an attached child through child.kill without probing other PIDs', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await stopProcess(child, Promise.resolve('closed'), false)()).toBe('closed');
  expect(kill.mock.calls).toEqual([['SIGTERM'], [0]]);
  expect(processKill).not.toHaveBeenCalled();
});

it('gives an attached child five seconds before SIGKILL and waits for its exit', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  let finish = (): void => {};
  const exit = new Promise<void>((resolve) => { finish = resolve; });
  const stop = stopProcess(child, exit, false);
  const stopping = stop();
  expect(stop()).toBe(stopping);
  await vi.advanceTimersByTimeAsync(4999);
  expect(kill.mock.calls).toEqual([['SIGTERM']]);
  await vi.advanceTimersByTimeAsync(1);
  expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  finish();
  await stopping;
});

it('stops a detached group that outlives its child', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const stopping = stopProcess(child, Promise.resolve('closed'), true)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await stopping).toBe('closed');
  expect(kill.mock.calls).toEqual([[-2147483647, 'SIGTERM'], [-2147483647, 0], [-2147483647, 'SIGKILL']]);
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

it.skipIf(process.platform === 'win32')('only escalates captured descendants with the same start time, including reparented survivors', async () => {
  vi.useFakeTimers();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const snapshot = path.join(directory, 'snapshot');
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 424242 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGTERM') {
      fs.writeFileSync(snapshot, '424243 1 Sun Oct 18 10:00:01 2026\n424244 424242 Sun Oct 18 10:00:00 2026\n424245 1 Sun Oct 18 10:00:00 2026\n');
    }
    return true;
  });
  try {
    fs.writeFileSync(snapshot, '424243 424242 Sun Oct 18 10:00:00 2026\n424244 424242 Sun Oct 18 10:00:00 2026\n424245 424244 Sun Oct 18 10:00:00 2026\n');
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
case "$3" in
  pid=,ppid=*) /bin/cat "${snapshot}" ;;
  pid=,lstart=) while read -r pid parent start; do echo "$pid $start"; done < "${snapshot}" ;;
esac
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    await vi.advanceTimersByTimeAsync(5000);
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

it.skipIf(process.platform === 'win32')('escalates only the shell when the current process snapshot fails', async () => {
  vi.useFakeTimers();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 424242 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
case "$3" in
  pid=,ppid=*) echo '424243 424242 Sun Oct 18 10:00:00 2026' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe('closed');
    expect(processKill.mock.calls).toEqual([[424243, 'SIGTERM']]);
    expect(kill.mock.calls).toEqual([['SIGTERM'], [0], ['SIGKILL']]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
