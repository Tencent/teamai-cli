import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { stopLeftChildren } from './helpers/left-children.js';
import { signalPid } from '@teamai/shared/process-group';

const IDLE = 'setInterval(() => {}, 1000)';

function isAlive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent' && !(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim().startsWith('Z');
}

/** The pid of `child`, which a spawn that started nothing has not: never 0, which signals the whole process group. */
function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('The test could not start its child process.');

  return child.pid;
}

it.skipIf(process.platform === 'win32')('stops a child the test left running and the process it started, and names the child', async () => {
  const grandchild = `process.stdout.write(String(require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' }).pid) + '\\n'); ${IDLE}`;
  const child = spawn(process.execPath, ['-e', grandchild], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = pidOf(child);
  const under = Number(await new Promise<string>((resolve) => child.stdout.once('data', (data: Buffer) => resolve(data.toString().trim()))));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    const left = await stopLeftChildren(() => (child.exitCode === null && child.signalCode === null ? [{ pid, command: 'the CLI' }] : []));
    expect(left).toEqual([`${pid} the CLI`]);
    await exited;
    expect(isAlive(under), 'the process the child started was stopped too').toBe(false);
  } finally {
    for (const at of [pid, under]) {
      signalPid(at, 'SIGKILL');
    }
  }
});

it('names nothing when every child ends by itself shortly after the test', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  await expect(stopLeftChildren(() => (child.exitCode === null && child.signalCode === null ? [{ pid: pidOf(child), command: 'brief' }] : []))).resolves.toEqual([]);
  await exited;
});
