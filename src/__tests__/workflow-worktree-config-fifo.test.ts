import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../workflow/worktree.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the agent configuration of a copy an earlier step left a FIFO in', () => {
  // Git ignores a FIFO, so one a step made in its copy outlives the step's commit and is there for the next step.
  it('saves the files at once and leaves the FIFO out, rather than waiting on it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-config-fifo-'));
    dirs.push(root);
    const copy = path.join(root, 'copy');
    const saved = path.join(root, 'saved');
    fs.mkdirSync(path.join(copy, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(saved);
    fs.writeFileSync(path.join(copy, '.claude', 'settings.json'), '{}\n');
    const fifo = path.join(copy, '.claude', 'skills', 'x');
    execFileSync('mkfifo', [fifo]);
    // A copy that waits on the FIFO ends only when another process opens it, which this one does from three seconds on.
    releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', fifo], { stdio: 'ignore' }));

    const start = Date.now();
    await saveConfig(copy, saved, ['.claude']);

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(fs.readFileSync(path.join(saved, '.claude', 'settings.json'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(saved, '.claude', 'skills', 'x'))).toBe(false);
  });
});
