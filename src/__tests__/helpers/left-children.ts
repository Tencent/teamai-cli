import { setTimeout as pause } from 'node:timers/promises';
import { descends, processTable } from './skill-runners.js';
import { signalPid } from '@teamai/shared/process-group';

// A child a test leaves running, such as a CLI a timed-out test never saw end, outlives the test and keeps its home
// and checkout busy. The setup file every config loads hands the children each test started to stopLeftChildren.

/** How long a child may take to end by itself after the test, as one the test did not wait for. */
const SETTLE_MS = 2_000;
/** How long a stopped process may take to end on SIGTERM before it is killed. */
const KILL_MS = 2_000;
const POLL_MS = 50;
// Clocks a test's fake timers cannot freeze, or the wait would never end.
const now = performance.now.bind(performance);

/**
 * Each of `live()`, the children a test started that still run `SETTLE_MS` after it, as `<pid> <command>`, stopped with
 * every process under it: SIGTERM, then SIGKILL for what is left after `KILL_MS`. The processes under a child are found
 * from one snapshot taken before any is stopped, so one in a process group of its own is stopped too.
 */
export async function stopLeftChildren(live: () => ReadonlyArray<{ pid: number; command: string }>): Promise<string[]> {
  const settleAt = now() + SETTLE_MS;
  let left = live();
  while (left.length > 0 && now() < settleAt) {
    await pause(POLL_MS);
    left = live();
  }
  if (left.length === 0) return [];
  const tree = treeOf(left.map(({ pid }) => pid));
  for (const pid of tree) signal(pid, 'SIGTERM');
  const killAt = now() + KILL_MS;
  while (tree.some(isAlive) && now() < killAt) await pause(POLL_MS);
  for (const pid of tree.filter(isAlive)) signal(pid, 'SIGKILL');
  return left.map(({ pid, command }) => `${pid} ${command}`);
}

/** `roots` and every process under them; on Windows, where no process table is read, `roots` alone. */
function treeOf(roots: readonly number[]): number[] {
  if (process.platform === 'win32') return [...roots];
  const table = processTable();
  const parents = new Map(table.map((row) => [row.pid, row.ppid]));
  return [...new Set([...roots, ...table.filter((row) => roots.some((root) => descends(parents, row.pid, root))).map((row) => row.pid)])];
}

function isAlive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

function signal(pid: number, name: NodeJS.Signals): void {
  signalPid(pid, name);
}
