import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexRollout } from './codex-rollout.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a Codex rollout a step left as a FIFO', () => {
  it('reads as no usage within its flush retries, rather than waiting on the FIFO for a writer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-rollout-fifo-'));
    dirs.push(dir);
    const pipe = path.join(dir, 'rollout.jsonl');
    execFileSync('mkfifo', [pipe]);
    // A read that waits on the FIFO ends only once another process opens it, from three seconds on.
    releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', pipe], { stdio: 'ignore' }));
    const start = Date.now();

    const reading = await readCodexRollout({ transcriptPath: pipe, sessionId: 'session-1', settled: false });

    // The flush retries take 1.75 s on their own.
    expect(Date.now() - start).toBeLessThan(2_600);
    expect(reading.requests).toEqual([]);
  });
});
