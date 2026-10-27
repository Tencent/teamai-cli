import childProcess, { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, onTestFinished, vi } from 'vitest';
import { waitForDetachedChildren } from './helpers/detached-processes.js';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.
// The race itself is not reproducible on every platform (Node 24's native
// rmSync on Linux almost never loses it), so the setup file is loaded over
// removals that always lose, while the writers are real processes.

/**
 * fs.rmSync and fs.promises.rm as the setup file wraps removals that fail with ENOTEMPTY while `isLosing` holds. The
 * setup file's hold on child_process and the environment lasts until the test ends, for the children the test starts.
 */
async function wrapLosingRemovals(isLosing = () => true): Promise<{ rmSync: typeof fs.rmSync; rm: typeof fs.promises.rm }> {
  const installed = { rmSync: fs.rmSync, rm: fs.promises.rm };
  const spawning = { ...childProcess };
  const { NODE_OPTIONS, TEAMAI_TEST_DETACHED_ROOT } = process.env;
  onTestFinished(() => {
    Object.assign(childProcess, spawning);
    syncBuiltinESMExports();
    Object.assign(process.env, { NODE_OPTIONS, TEAMAI_TEST_DETACHED_ROOT });
  });
  const lost = (target: fs.PathLike) => Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(target)}'`), { code: 'ENOTEMPTY' });
  fs.rmSync = (target, options) => {
    if (isLosing()) throw lost(target);
    installed.rmSync(target, options);
  };
  fs.promises.rm = async (target, options) => {
    if (isLosing()) throw lost(target);
    await installed.rm(target, options);
  };
  try {
    vi.resetModules();
    await import('./helpers/teardown-writers.js');
    return { rmSync: fs.rmSync, rm: fs.promises.rm };
  } finally {
    fs.rmSync = installed.rmSync;
    fs.promises.rm = installed.rm;
    syncBuiltinESMExports();
  }
}

/** A live process that only waits, killed when the test ends and gone on its own after a minute. */
async function idleProcess(options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<number | undefined> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { ...options, stdio: 'ignore' });
  onTestFinished(() => { child.kill(); });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  return child.pid;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A repo with a pack file, and a process shaped like git's detached upkeep: it runs inside the repo and its command line does not name it. */
async function repoWithUpkeep(root: string): Promise<number | undefined> {
  const pack = path.join(root, 'repo', 'objects', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'tmp_pack_1'), '');
  return idleProcess({ cwd: path.join(root, 'repo') });
}

/**
 * Run a node parent that exits at once and leaves a detached child that writes
 * `done` after `ms` and exits, as hook-dispatch leaves its --bg-only pass. The
 * parent gets `env`, the environment every test passes on by default, and
 * nothing that tracks its children. The child's last write marks its end:
 * signal 0 still reaches it as a zombie until its new parent reaps it.
 */
function leaveDetachedChild(done: string, ms: number, env?: NodeJS.ProcessEnv): void {
  const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, ''), ${ms})`;
  const parent = spawnSync(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref();
  `], { encoding: 'utf-8', env });
  expect(parent.status, parent.stderr).toBe(0);
}

it('waits for a detached child the suite started before rmSync gives up on ENOTEMPTY', async () => {
  const done = path.join(tempRoot(), 'done');
  const { rmSync } = await wrapLosingRemovals(() => !fs.existsSync(done));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  leaveDetachedChild(done, 1_500);

  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
});

it('waits for a detached child the suite started before fs.promises.rm gives up on ENOTEMPTY', async () => {
  const done = path.join(tempRoot(), 'done');
  const { rm } = await wrapLosingRemovals(() => !fs.existsSync(done));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  leaveDetachedChild(done, 1_500);

  await rm(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
});

it('waits for a detached child of a process the test started with a NODE_OPTIONS of its own', async () => {
  const done = path.join(tempRoot(), 'done');
  const { rmSync } = await wrapLosingRemovals(() => !fs.existsSync(done));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  leaveDetachedChild(done, 1_500, { ...process.env, NODE_OPTIONS: '--no-deprecation' });

  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
});

it('stops waiting once a detached child the worker started has exited, though the worker has not reaped it', async () => {
  const done = path.join(tempRoot(), 'done');
  const { rmSync } = await wrapLosingRemovals(() => !fs.existsSync(done));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, ''), 300)`], { detached: true, stdio: 'ignore' }).unref();

  const started = performance.now();
  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
  expect(performance.now() - started).toBeLessThan(5_000);
});

it('waits for a detached shell command started without an argument list', async () => {
  const scratch = tempRoot();
  const done = path.join(scratch, 'done');
  const script = path.join(scratch, 'late-writer.js');
  fs.writeFileSync(script, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, ''), 1500)`);
  const { rmSync } = await wrapLosingRemovals(() => !fs.existsSync(done));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  // The shape of startGroupedCommand's spawn, as a workflow step runs it.
  spawn(`"${process.execPath}" "${script}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();

  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
});

it('lets a test wait for the detached children of a process it started before it asserts what they wrote', async () => {
  const done = path.join(tempRoot(), 'done');
  leaveDetachedChild(done, 500);

  await waitForDetachedChildren();

  expect(fs.existsSync(done)).toBe(true);
});

it('keeps what promisify(execFile) resolves to', async () => {
  const run = promisify(childProcess.execFile);

  await expect(run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'])).resolves.toEqual({ stdout: 'out', stderr: 'err' });
});

// Processes are found with /proc, or ps and lsof; Windows has neither.
it.skipIf(process.platform === 'win32')('names what reappeared and the process still in the directory when rmSync meets ENOTEMPTY', async () => {
  const { rmSync } = await wrapLosingRemovals();
  const root = tempRoot();
  const pid = await repoWithUpkeep(root);

  let message = '';
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { message = e instanceof Error ? e.message : ''; }

  expect(message).toMatch(/^ENOTEMPTY: directory not empty/);
  expect(message).toMatch(/reappeared during removal:\n(?: {2}.+\n)* {2}repo\/objects\/pack\/tmp_pack_1 /);
  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
});

it.skipIf(process.platform === 'win32')('names the process still in the directory when fs.promises.rm meets ENOTEMPTY', async () => {
  const { rm } = await wrapLosingRemovals();
  const root = tempRoot();
  const pid = await repoWithUpkeep(root);

  await expect(rm(root, { recursive: true, force: true })).rejects.toThrow(`still running in or on ${root}:\n  ${pid} `);
});

// macOS keeps other processes' environments from ps; CI runs e2e on Linux.
it.runIf(process.platform === 'linux')('names a process that reaches the directory only through its environment', async () => {
  const { rmSync } = await wrapLosingRemovals();
  const root = tempRoot();
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  // Shaped like teamai's detached --bg-only child: it starts outside the
  // sandbox and finds ~/.teamai through HOME alone.
  const pid = await idleProcess({ cwd: os.tmpdir(), env: { ...process.env, HOME: home } });

  let message = '';
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { message = e instanceof Error ? e.message : ''; }

  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
  expect(message).not.toContain(`HOME=${home}`);
});
