import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a Claude transcript a step left as something other than a file', () => {
  // A listing names only files, but a step can put a FIFO at a listed path before the transcript is read from it.
  it('fails the read at once when a FIFO stands at the listed transcript path, instead of stalling the process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-fifo-'));
    dirs.push(root);
    const storageRoot = path.join(root, 'projects');
    const sid = '7f9c1a52-0000-4000-8000-000000000001';
    const transcript = path.join(storageRoot, '-home-user-project', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    execFileSync('mkfifo', [transcript]);
    // A read that waits on the FIFO blocks this process, so another one opens it from three seconds on: such a read
    // then ends late, rather than never.
    releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', transcript], { stdio: 'ignore' }));

    const start = Date.now();
    const read = new ClaudeCodeAdapter('claude-code', storageRoot).readSession({ sessionId: sid, filePath: transcript });

    await expect(read).rejects.toThrow(`${transcript} is a pipe, not a regular file, so teamai does not read it`);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
