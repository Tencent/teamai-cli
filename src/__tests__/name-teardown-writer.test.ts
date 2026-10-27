import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.
// The race itself is not reproducible on every platform (Node 24's native
// rmSync on Linux almost never loses it), so the setup file is loaded over
// removals that always lose, while the writers are real processes.

/** fs.rmSync and fs.promises.rm as the setup file wraps removals that always fail with ENOTEMPTY. */
async function wrapLosingRemovals(): Promise<{ rmSync: typeof fs.rmSync; rm: typeof fs.promises.rm }> {
  const installed = { rmSync: fs.rmSync, rm: fs.promises.rm };
  const lost = (target: fs.PathLike) => Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(target)}'`), { code: 'ENOTEMPTY' });
  fs.rmSync = (target) => { throw lost(target); };
  fs.promises.rm = async (target) => { throw lost(target); };
  try {
    vi.resetModules();
    await import('./helpers/name-teardown-writer.js');
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
