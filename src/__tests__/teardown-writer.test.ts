import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// A teardown that loses the race to a late writer fails with ENOTEMPTY. The
// error has to name the writer, or the next CI failure is as blind as #1413.
it('names what reappeared and the process still writing when a removal meets ENOTEMPTY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-teardown-writer-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  // Shaped like git's detached upkeep: it runs inside the repo and its
  // command line does not name the directory the teardown removes.
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    for (let n = 0; ; n++) {
      try { fs.mkdirSync('objects/pack', { recursive: true }); fs.writeFileSync('objects/pack/tmp_pack_' + n, ''); } catch {}
    }
  `], { cwd: repo, stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    let failure: unknown;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { failure = e; }

    expect(failure).toMatchObject({ code: 'ENOTEMPTY' });
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toMatch(/reappeared during removal:\n(?: {2}.+\n)* {2}repo\/objects\/pack\/tmp_pack_\d+ /);
    expect(message).toContain(`still running in or on ${root}:\n  ${writer.pid} `);
  } finally {
    writer.kill();
    await new Promise((resolve) => writer.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
