import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// oxlint-disable-next-line teamai/workflow-boundaries -- tests the conflicts a writer's settle remembers, which place.ts runs directly
import { rememberConflicts } from '../workflow/place/writer.js';
import { git } from '../workflow/worktree.js';

const dirs: string[] = [];
const releasers: ChildProcess[] = [];

afterEach(() => {
  for (const releaser of releasers.splice(0)) releaser.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy whose merge stopped on a conflict in a.txt. */
function conflicted(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-writer-fifo-'));
  dirs.push(dir);
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs\n');
  run('commit', '-q', '-am', 'theirs');
  run('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'ours\n');
  run('commit', '-q', '-am', 'ours');
  expect(() => run('merge', '-q', 'theirs')).toThrow();

  return dir;
}

describe.skipIf(process.platform === 'win32')('the conflicts a merge started with, where a step left a FIFO', () => {
  it('refuses the FIFO at once, rather than waiting for a reader to write them', async () => {
    const dir = conflicted();
    const pipe = path.join(dir, '.git', 'teamai-conflicts.json');
    execFileSync('mkfifo', [pipe]);
    // A write that waits on the FIFO ends only once another process opens it, from three seconds on.
    releasers.push(spawn('sh', ['-c', 'sleep 3; while :; do exec 3<>"$1"; exec 3>&-; sleep 0.1; done', 'sh', pipe], { stdio: 'ignore' }));
    const start = Date.now();

    const remembered = await rememberConflicts(dir, git).then(() => 'remembered', (error: unknown) => error);

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(remembered).toMatchObject({ name: 'NotRegularFileError', kind: 'a pipe' });
  });
});
