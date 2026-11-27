import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { leftSkillRunners, RUNNER_EXIT_MS, stopLeftSkillRunners } from './skill-runners.js';
import { signalPid } from '@teamai/shared/process-group';

/** Track detached children before their parent exits, so a fixture can join them. */
export function trackDetachedProcesses(root: string): { preload: string; nodeOptions: string; running: () => number[]; waitForExit: (options?: { runnerExitMs?: number }) => Promise<void> } {
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
    waitForExit: (options) => waitForExitIn(children, options?.runnerExitMs),
  };
}

/**
 * Wait for the detached children of every process this worker started, as a
 * test does before it asserts what they wrote. The teardown-writers setup file
 * tracks them. A skill runner among them that does not end stops, with the
 * groups its step started, and the wait fails naming it.
 */
export function waitForDetachedChildren(): Promise<void> {
  return waitForExitIn(trackedChildren());
}

/** waitForDetachedChildren, for a test that runs the CLI with spawnSync and reads what its detached pass wrote. */
export function waitForDetachedChildrenSync(): void {
  const children = trackedChildren();
  const deadline = Date.now() + 60_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (runningIn(children).length > 0) {
    if (Date.now() >= deadline) throw new Error(`Detached fixture processes did not exit: ${runningIn(children).join(', ')}`);
    Atomics.wait(pause, 0, 0, 25);
  }
}

function trackedChildren(): string {
  const root = process.env.TEAMAI_TEST_DETACHED_ROOT;
  if (!root) throw new Error('No detached-process tracker: add src/__tests__/helpers/teardown-writers.ts to setupFiles.');
  return path.join(root, 'detached-children');
}

/** The tracked pids still running; each exited one is forgotten. */
function runningIn(children: string): number[] {
  return fs.readdirSync(children).map(Number).filter((pid) => {
    if (signalPid(pid, 0) === 'sent') return !isZombie(pid);
    // `gone`: the pid is gone. `denied`: it belongs to a process this runner
    // cannot signal: on macOS a pid the kernel recycled to another user's
    // process answers that way. It is not teamai's child any more, so it is
    // forgotten like a gone one (#1504).
    fs.unlinkSync(path.join(children, String(pid)));
    return false;
  });
}

async function waitForExitIn(children: string, runnerExitMs = RUNNER_EXIT_MS): Promise<void> {
  const deadline = Date.now() + 60_000;
  // A runner whose attempt stays open polls its run for good: waited on alone, it would fail this wait and outlive it.
  const stopped = stopLeftSkillRunners(() => runningIn(children), { exitMs: runnerExitMs });
  while (runningIn(children).length > 0) {
    if (Date.now() >= deadline) throw new Error([`Detached fixture processes did not exit: ${runningIn(children).join(', ')}`, ...(stopped.length > 0 ? [leftSkillRunners(stopped)] : [])].join('\n'));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (stopped.length > 0) throw new Error(leftSkillRunners(stopped));
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
