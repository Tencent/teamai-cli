import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mayBeRunning } from '@teamai/shared/process-group';
import { z } from 'zod';
import type { Connection } from './connect.js';

// ─── What a test left running ───
//
//  Every runtime harness ends a test with `expectNothingLeft`, so a test that leaves a runtime, or a process a runtime
//  or a fake started, fails, and a new test is checked without asking (after sandcastle's testGlobalSetup.ts).
//

/** Every process on this machine whose command line names a path under `dir`, as `<pid> <args>`. */
export function processesUnder(dir: string): string[] {
  const roots = [...new Set([dir, ...(fs.existsSync(dir) ? [fs.realpathSync(dir)] : [])])];

  return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter((line) => line !== '' && roots.some((root) => line.includes(root)));
}

/** An answer about a place that names what the runtime leaves of it on purpose. */
const KeptSchema = z.object({ handle: z.string(), kept: z.array(z.string()) });

/** What the runtimes of `connections` said they leave on purpose: the `kept` of each answer about a place. */
function keptBy(connections: readonly Connection[]): string[] {
  return connections.flatMap(({ lines }) => lines.flatMap((line) => KeptSchema.safeParse(line).data?.kept ?? []));
}

/**
 * Whether `thing` names `name` whole, between spaces or the ends: never a name that merely starts with it, as
 * teamai-r1-a10 does with teamai-r1-a1, nor a path under it, as a process left in a kept directory runs from.
 */
function namesWhole(thing: string, name: string): boolean {
  for (let at = thing.indexOf(name); at !== -1; at = thing.indexOf(name, at + 1)) {
    const before = thing.charAt(at - 1);
    const after = thing.charAt(at + name.length);

    if ((at === 0 || /\s/.test(before)) && (after === '' || /\s/.test(after))) return true;
  }

  return false;
}

/** What `connections`, `dir` and `left` still hold, as `<kind>: <what>`, but what a runtime said it keeps. */
function leftRunning({ dir, connections, left }: Scope): string[] {
  const kept = keptBy(connections);
  const isKept = (thing: string): boolean => kept.some((name) => namesWhole(thing, name));
  const runtimes = connections.flatMap(({ child }) => (child.pid !== undefined && child.exitCode === null && child.signalCode === null && mayBeRunning(child.pid) ? [`runtime: ${child.pid} ${child.spawnargs.join(' ')}`] : []));

  return [...runtimes, ...processesUnder(dir).filter((line) => !isKept(line)).map((line) => `process: ${line}`), ...left().filter((thing) => !isKept(thing)).map((thing) => `left: ${thing}`)];
}

/** What a test made: its directory, its runtimes, and what else its fakes hold, such as a fake engine's containers. */
interface Scope {
  dir: string;
  connections: readonly Connection[];
  left: () => string[];
}

/** How long a process may take to end by itself after the test, as a detached opener or a fake's child does. */
const SETTLE_MS = 2000;

/**
 * Fails the test, naming each, when a runtime of `connections` still runs, any process names a path under `dir`, the
 * test's own directory, which everything it made is under, or `left` names anything, `SETTLE_MS` after the test: one
 * that ends by itself within that is no leak, and neither is what a runtime said, in its answers' `kept`, it leaves.
 */
export async function expectNothingLeft({ dir, connections = [], left = () => [] }: { dir: string; connections?: readonly Connection[]; left?: () => string[] }): Promise<void> {
  const scope = { dir, connections, left };
  const deadline = Date.now() + SETTLE_MS;
  let named = leftRunning(scope);

  while (named.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    named = leftRunning(scope);
  }

  if (named.length > 0) throw new Error(`The test left behind:\n${named.join('\n')}`);
}
