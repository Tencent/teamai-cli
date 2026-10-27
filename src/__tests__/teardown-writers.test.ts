import childProcess, { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, onTestFinished, vi } from 'vitest';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.
// The race itself is not reproducible on every platform (Node 24's native
// rmSync on Linux almost never loses it), so the setup file is loaded over
// removals that always lose, while the writers are real processes.

/**
 * fs.rmSync and fs.promises.rm as the setup file wraps removals that fail with ENOTEMPTY while `isLosing` holds. The
 * setup file's hold on child_process and NODE_OPTIONS lasts until the test ends, for the children the test starts.
 */
async function wrapLosingRemovals(isLosing = () => true): Promise<{ rmSync: typeof fs.rmSync; rm: typeof fs.promises.rm }> {
  const installed = { rmSync: fs.rmSync, rm: fs.promises.rm };
  const spawning = { ...childProcess };
  const nodeOptions = process.env.NODE_OPTIONS;
  onTestFinished(() => {
    Object.assign(childProcess, spawning);
    syncBuiltinESMExports();
    process.env.NODE_OPTIONS = nodeOptions;
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a node parent that exits at once and leaves a detached child running for
 * `ms`, as hook-dispatch leaves its --bg-only pass. The parent gets `env`, the
 * environment every test passes on by default, and nothing that tracks its children.
 */
async function leaveDetachedChild(ms: number, env?: NodeJS.ProcessEnv): Promise<number> {
  const pidFile = path.join(tempRoot(), 'detached.pid');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${ms})`;
  const parent = spawnSync(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref();
  `], { encoding: 'utf-8', env });
  expect(parent.status, parent.stderr).toBe(0);
  while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf-8') === '') await new Promise((resolve) => setTimeout(resolve, 10));
  const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
  onTestFinished(() => { if (isRunning(pid)) process.kill(pid); });
  return pid;
}

it('waits for a detached child the suite started before rmSync gives up on ENOTEMPTY', async () => {
  let writer: number | undefined;
  const { rmSync } = await wrapLosingRemovals(() => writer !== undefined && isRunning(writer));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  writer = await leaveDetachedChild(1_500);

  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
  expect(isRunning(writer)).toBe(false);
});

it('waits for a detached child the suite started before fs.promises.rm gives up on ENOTEMPTY', async () => {
  let writer: number | undefined;
  const { rm } = await wrapLosingRemovals(() => writer !== undefined && isRunning(writer));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  writer = await leaveDetachedChild(1_500);

  await rm(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
  expect(isRunning(writer)).toBe(false);
});

it('waits for a detached child of a process the test started with a NODE_OPTIONS of its own', async () => {
  let writer: number | undefined;
  const { rmSync } = await wrapLosingRemovals(() => writer !== undefined && isRunning(writer));
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  writer = await leaveDetachedChild(1_500, { ...process.env, NODE_OPTIONS: '--no-deprecation' });

  rmSync(root, { recursive: true, force: true });

  expect(fs.existsSync(root)).toBe(false);
  expect(isRunning(writer)).toBe(false);
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
