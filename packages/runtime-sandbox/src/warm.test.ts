import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planWarm, scratchOf } from './warm.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('planWarm on a checkout where a step left a FIFO', () => {
  it('refuses the FIFO as a cache file at once, rather than waiting for a writer', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-warm-fifo-'));
    dirs.push(checkout);
    const pipe = path.join(checkout, 'package-lock.json');
    execFileSync('mkfifo', [pipe]);
    // A read that waits on the FIFO ends only once another process opens it, from three seconds on.
    releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', pipe], { stdio: 'ignore' }));
    const start = Date.now();

    const planned = planWarm({ base: 'node:22', recipe: { cache: ['package-lock.json'], prepare: 'npm ci' }, checkout });

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(planned).toMatchObject({ ok: false, failure: { code: 'bad_option', key: 'warm.cache' } });
  });
});

describe.skipIf(process.platform === 'win32')('scratchOf', () => {
  it('copies each cache file with its mode, so an executable stays executable in the build context', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-warm-mode-'));
    dirs.push(checkout);
    const script = path.join(checkout, 'install.sh');
    fs.writeFileSync(script, '#!/bin/sh\n');
    fs.chmodSync(script, 0o755);

    const scratch = scratchOf([{ file: 'tools/install.sh', from: script }]);
    dirs.push(scratch.dir);

    expect(fs.readFileSync(path.join(scratch.dir, 'tools/install.sh'), 'utf8')).toBe('#!/bin/sh\n');
    expect(fs.statSync(path.join(scratch.dir, 'tools/install.sh')).mode & 0o777).toBe(0o755);
  });
});
