import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.

type Race = {
  root: string;
  writer: string;
  writes: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  remove: (dir: string) => unknown;
  attempts?: number;
};

/**
 * Start `writer` (a node script looping writes into `writes`), wait until it
 * has written, and return the error removing `root` with `remove` fails with,
 * or undefined when every removal won. A removal that wins the race takes the
 * writer's tree with it, so it is tried again with a fresh writer.
 */
async function removeWhileWriting({ root, writer, writes, cwd, env, remove, attempts = 5 }: Race): Promise<{ message: string; pid: number | undefined } | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(process.execPath, ['-e', writer], { cwd, env, stdio: 'ignore' });
    try {
      const deadline = Date.now() + 10_000;
      while (!(fs.existsSync(writes) && fs.readdirSync(writes).length > 0)) {
        if (Date.now() > deadline) throw new Error(`the writer did not write into ${writes} within 10s`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let failure: unknown;
      try { await remove(root); } catch (e) { failure = e; }
      if (failure === undefined) continue;
      expect(failure).toMatchObject({ code: 'ENOTEMPTY' });
      return { message: failure instanceof Error ? failure.message : '', pid: child.pid };
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  return undefined;
}

async function loseRace(race: Race): Promise<{ message: string; pid: number | undefined }> {
  const lost = await removeWhileWriting(race);
  if (!lost) throw new Error(`every removal of ${race.root} beat the writer`);
  return lost;
}

const removeAsync = (dir: string) => fs.promises.rm(dir, { recursive: true, force: true });

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Shaped like git's detached upkeep: it runs inside the repo and its command
// line does not name the directory the teardown removes.
const UPKEEP = `
  const fs = require('node:fs');
  for (let n = 0; ; n++) {
    try { fs.mkdirSync('objects/pack', { recursive: true }); fs.writeFileSync('objects/pack/tmp_pack_' + n, ''); } catch {}
  }
`;

it('names what reappeared and the process still writing when a removal meets ENOTEMPTY', async ({ skip }) => {
  const root = tempRoot();
  const repo = path.join(root, 'repo');
  const lost = await removeWhileWriting({
    root,
    writer: UPKEEP,
    writes: path.join(repo, 'objects', 'pack'),
    cwd: repo,
    remove: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    attempts: 20,
  });
  // Node 24's native rmSync leaves a writer almost no window on Linux.
  if (!lost) return skip(`rmSync beat the writer 20 times on ${process.platform} ${process.version}`);
  const { message, pid } = lost;

  expect(message).toMatch(/reappeared during removal:\n(?: {2}.+\n)* {2}repo\/objects\/pack\/tmp_pack_\d+ /);
  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
});

// macOS keeps other processes' environments from ps; CI runs e2e on Linux.
it.runIf(process.platform === 'linux')('names a writer that reaches the directory only through its environment', async () => {
  const root = tempRoot();
  const home = path.join(root, 'home');
  // Shaped like teamai's detached --bg-only child: it starts outside the
  // sandbox and finds ~/.teamai through HOME alone.
  const { message, pid } = await loseRace({
    root,
    writer: `
      const fs = require('node:fs');
      const dir = process.env.HOME + '/.teamai';
      for (let n = 0; ; n++) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/debug-' + n + '.log', ''); } catch {}
      }
    `,
    writes: path.join(home, '.teamai'),
    cwd: os.tmpdir(),
    env: { ...process.env, HOME: home },
    remove: removeAsync,
  });

  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
  expect(message).not.toContain(`HOME=${home}`);
});

it('names the writer when an async removal meets ENOTEMPTY', async () => {
  const root = tempRoot();
  const repo = path.join(root, 'repo');
  const { message, pid } = await loseRace({ root, writer: UPKEEP, writes: path.join(repo, 'objects', 'pack'), cwd: repo, remove: removeAsync });

  // Not which entries: the rejected removal's sibling unlinks still run on the
  // thread pool while the entries are listed.
  expect(message).toContain('Entries that reappeared during removal:');
  expect(message).toContain(`still running in or on ${root}:\n  ${pid} `);
});
