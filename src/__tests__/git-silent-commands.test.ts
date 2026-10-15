import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit } from '../utils/git.js';

// Real-git test: simple-git sleeps 50ms after a git process that printed
// nothing. createGit must not pay that on every silent command (`add`,
// `fetch`, `worktree prune`, a config write).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-silent-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe('createGit', () => {
  it('finishes a command that prints nothing as fast as one that prints', async () => {
    const git = createGit(dir);
    const runs = 20;
    await git.raw(['config', '--local', 'teamai.probe', 'value']);

    const printing = await elapsed(async () => {
      for (let i = 0; i < runs; i++) await git.raw(['config', '--local', '--get', 'teamai.probe']);
    });
    const silent = await elapsed(async () => {
      for (let i = 0; i < runs; i++) await git.raw(['config', '--local', 'teamai.probe', 'value']);
    });

    // A 50ms sleep per silent command would add 1000ms; spawn noise stays well under half that.
    expect(silent).toBeLessThan(printing + runs * 25);
  });

  it('returns what git printed, and nothing for a silent command', async () => {
    const git = createGit(dir);
    expect(await git.raw(['config', '--local', 'teamai.probe', 'value'])).toBe('');
    expect(await git.raw(['config', '--local', '--get', 'teamai.probe'])).toBe('value\n');
  });
});
