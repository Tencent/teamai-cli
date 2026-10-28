import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Track detached children before their parent exits, so a fixture can join them. */
export function trackDetachedProcesses(root: string): { preload: string; nodeOptions: string; running: () => number[]; waitForExit: () => Promise<void> } {
  const children = path.join(root, 'detached-children');
  fs.mkdirSync(children);
  const preload = path.join(root, 'track-detached.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const child = spawn.apply(this, args);
  const options = Array.isArray(args[1]) ? args[2] : args[1];
  if (options?.detached && child.pid) {
    fs.writeFileSync(path.join(${JSON.stringify(children)}, String(child.pid)), '');
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  return {
    preload,
    nodeOptions: `--require ${JSON.stringify(preload)}`,
    running: () => runningIn(children),
    waitForExit: () => waitForExitIn(children),
  };
}

/**
 * Wait for the detached children of every process this worker started, as a
 * test does before it asserts what they wrote. The teardown-writers setup file
 * tracks them.
 */
export function waitForDetachedChildren(): Promise<void> {
  const root = process.env.TEAMAI_TEST_DETACHED_ROOT;
  if (!root) throw new Error('No detached-process tracker: add src/__tests__/helpers/teardown-writers.ts to setupFiles.');
  return waitForExitIn(path.join(root, 'detached-children'));
}

/** The tracked pids still running; each exited one is forgotten. */
function runningIn(children: string): number[] {
  return fs.readdirSync(children).map(Number).filter((pid) => {
    try {
      process.kill(pid, 0);
      return !isZombie(pid);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
      fs.unlinkSync(path.join(children, String(pid)));
      return false;
    }
  });
}

async function waitForExitIn(children: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (runningIn(children).length > 0) {
    if (Date.now() >= deadline) throw new Error(`Detached fixture processes did not exit: ${runningIn(children).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Whether `pid` has exited and waits for its parent to reap it. Signal 0 still
 * reaches it, and a parent blocked in a synchronous wait never reaps it.
 */
function isZombie(pid: number): boolean {
  if (process.platform === 'win32') return false;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return false;
    }
  }
  return (spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout ?? '').trim().startsWith('Z');
}
