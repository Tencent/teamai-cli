import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGit, gitBinary } from '../utils/git.js';

describe('gitBinary', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-binary-')));
    dirs.push(dir);
    return dir;
  }

  /** A dir holding a `git` file, executable unless said otherwise. */
  function gitDir(mode = 0o755): string {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(dir, 'git'), mode);
    return dir;
  }

  const onPath = (...entries: string[]) => entries.join(path.delimiter);
  /** Cases that rely on POSIX execute bits and shebangs, which Windows lacks. */
  const posixIt = it.skipIf(process.platform === 'win32');

  posixIt('resolves the first executable git in PATH order', () => {
    const empty = tempDir();
    const first = gitDir();
    const second = gitDir();
    expect(gitBinary({ pathEnv: onPath(empty, first, second), platform: 'darwin' }))
      .toBe(path.join(first, 'git'));
  });

  posixIt('looks PATH up again when it changes', () => {
    const a = gitDir();
    const b = gitDir();
    expect(gitBinary({ pathEnv: onPath(a, b), platform: 'darwin' })).toBe(path.join(a, 'git'));
    expect(gitBinary({ pathEnv: onPath(b, a), platform: 'darwin' })).toBe(path.join(b, 'git'));
  });

  posixIt('looks PATH up again when the resolved git is removed or loses execute permission', () => {
    const later = gitDir();

    const removed = gitDir();
    expect(gitBinary({ pathEnv: onPath(removed, later), platform: 'darwin' })).toBe(path.join(removed, 'git'));
    fs.rmSync(path.join(removed, 'git'));
    expect(gitBinary({ pathEnv: onPath(removed, later), platform: 'darwin' })).toBe(path.join(later, 'git'));

    const unexecutable = gitDir();
    expect(gitBinary({ pathEnv: onPath(unexecutable, later), platform: 'darwin' })).toBe(path.join(unexecutable, 'git'));
    fs.chmodSync(path.join(unexecutable, 'git'), 0o644);
    expect(gitBinary({ pathEnv: onPath(unexecutable, later), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name when git is not on PATH', () => {
    expect(gitBinary({ pathEnv: onPath(tempDir()), platform: 'darwin' })).toBe('git');
  });

  posixIt('falls back to the bare name when an earlier git is not executable, leaving that case to the spawn\'s own lookup', () => {
    expect(gitBinary({ pathEnv: onPath(gitDir(0o644), gitDir()), platform: 'darwin' })).toBe('git');
  });

  posixIt('falls back to the bare name when the first git cannot be spawned, which a bare-name lookup skips', async () => {
    const broken = tempDir();
    fs.writeFileSync(path.join(broken, 'git'), '#!/nonexistent/sh\n');
    fs.chmodSync(path.join(broken, 'git'), 0o755);
    const realGit = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
    const pathEnv = onPath(broken, realGit);
    expect(gitBinary({ pathEnv, platform: 'darwin' })).toBe('git');

    const savedPath = process.env.PATH;
    process.env.PATH = pathEnv;
    try {
      const repo = tempDir();
      await createGit(repo).init();
      expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  posixIt('falls back to the bare name when an earlier git cannot be read, such as a symlink loop', () => {
    const loop = tempDir();
    fs.symlinkSync(path.join(loop, 'git'), path.join(loop, 'git'));
    expect(gitBinary({ pathEnv: onPath(loop, gitDir()), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name when PATH has an entry a spawn resolves against its cwd', () => {
    const later = gitDir();
    expect(gitBinary({ pathEnv: onPath('', later), platform: 'darwin' })).toBe('git');
    expect(gitBinary({ pathEnv: onPath('bin', later), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name for a path simple-git refuses as its binary', () => {
    const spaced = path.join(tempDir(), 'with space');
    fs.mkdirSync(spaced);
    fs.writeFileSync(path.join(spaced, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(spaced, 'git'), 0o755);
    expect(gitBinary({ pathEnv: onPath(spaced), platform: 'darwin' })).toBe('git');
  });

  it('keeps the bare name on win32, where the OS resolves it', () => {
    expect(gitBinary({ pathEnv: onPath(gitDir()), platform: 'win32' })).toBe('git');
  });

  it('builds a createGit that simple-git accepts with the binary resolved from this PATH', async () => {
    const repo = tempDir();
    await createGit(repo).init();
    expect(fs.realpathSync((await createGit(repo).revparse(['--show-toplevel'])).trim())).toBe(repo);
  });
});
