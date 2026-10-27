import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.

/** Start `writer` (a looping node script), let it run, and return the error removing `root` with `remove` fails with. */
async function removeWhileWriting(
  root: string,
  writer: string,
  options: SpawnOptions,
  remove: (dir: string) => unknown = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
): Promise<{ message: string; pid: number | undefined }> {
  const child = spawn(process.execPath, ['-e', writer], { ...options, stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    let failure: unknown;
    try { await remove(root); } catch (e) { failure = e; }
    expect(failure).toMatchObject({ code: 'ENOTEMPTY' });
    return { message: failure instanceof Error ? failure.message : '', pid: child.pid };
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it('names what reappeared and the process still writing when a removal meets ENOTEMPTY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  // Shaped like git's detached upkeep: it runs inside the repo and its
  // command line does not name the directory the teardown removes.
  const { message, pid } = await removeWhileWriting(root, `
    const fs = require('node:fs');
    for (let n = 0; ; n++) {
      try { fs.mkdirSync('objects/pack', { recursive: true }); fs.writeFileSync('objects/pack/tmp_pack_' + n, ''); } catch {}
    }
  `, { cwd: repo });

  expect(message).toMatch(/reappeared during removal:\n(?: {2}.+\n)* {2}repo\/objects\/pack\/tmp_pack_\d+ /);
  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
});

// macOS keeps other processes' environments from ps; CI runs e2e on Linux.
it.runIf(process.platform === 'linux')('names a writer that reaches the directory only through its environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  // Shaped like teamai's detached --bg-only child: it starts outside the
  // sandbox and finds ~/.teamai through HOME alone.
  const { message, pid } = await removeWhileWriting(root, `
    const fs = require('node:fs');
    const dir = process.env.HOME + '/.teamai';
    for (let n = 0; ; n++) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/debug-' + n + '.log', ''); } catch {}
    }
  `, { cwd: os.tmpdir(), env: { ...process.env, HOME: home } });

  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
  expect(message).not.toContain(`HOME=${home}`);
});

it('names the writer when an async removal meets ENOTEMPTY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const { message, pid } = await removeWhileWriting(root, `
    const fs = require('node:fs');
    for (let n = 0; ; n++) {
      try { fs.mkdirSync('objects/pack', { recursive: true }); fs.writeFileSync('objects/pack/tmp_pack_' + n, ''); } catch {}
    }
  `, { cwd: repo }, (dir) => fs.promises.rm(dir, { recursive: true, force: true }));

  expect(message).toMatch(/reappeared during removal:\n(?: {2}.+\n)* {2}repo\/objects\/pack\/tmp_pack_\d+ /);
  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
});
