import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { commitPaths, commitSkippingHooks, createGit } from '../utils/git.js';

// Real-git tests: TeamAI-managed isolated commits skip hooks; ordinary
// commitPaths (teamai init seeding the user's working tree) still runs them.

let dir: string;
function git(args: string[]) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function writeHuskyStyleHook(repo: string, body: string) {
  const huskyDir = path.join(repo, '.husky');
  fs.mkdirSync(huskyDir, { recursive: true });
  fs.writeFileSync(path.join(huskyDir, 'pre-commit'), body, { mode: 0o755 });
  execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skip-hooks-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.co']);
  git(['config', 'user.name', 't']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('commitSkippingHooks', () => {
  it('commits when a husky v8 hook sources a missing husky.sh', async () => {
    writeHuskyStyleHook(dir, [
      '#!/bin/sh',
      '. "$(dirname -- "$0")/_/husky.sh"',
      'exit 1',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, '.teamai', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.teamai', 'skills', 'note.md'), 'knowledge\n');
    git(['add', '.teamai/skills/note.md']);

    await commitSkippingHooks(createGit(dir), '[teamai] Add skill');

    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf-8' });
    expect(log.trim()).toBe('[teamai] Add skill');
  });
});

describe('commitPaths (ordinary path)', () => {
  it('still runs git hooks — does not pass --no-verify', async () => {
    const marker = path.join(dir, 'hook-ran');
    writeHuskyStyleHook(dir, [
      '#!/bin/sh',
      `touch "${marker}"`,
      'exit 0',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, '.teamai', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.teamai', 'skills', '.gitkeep'), '');

    const committed = await commitPaths(dir, 'init skeleton', ['.teamai/skills']);
    expect(committed).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('fails when a husky v8 hook sources a missing husky.sh', async () => {
    writeHuskyStyleHook(dir, [
      '#!/bin/sh',
      '. "$(dirname -- "$0")/_/husky.sh"',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, '.teamai', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.teamai', 'skills', '.gitkeep'), '');

    await expect(commitPaths(dir, 'init skeleton', ['.teamai/skills'])).rejects.toThrow();
  });
});

describe('ordinary simple-git commit still invokes hooks', () => {
  it('createGit().commit without --no-verify is blocked by a missing husky.sh', async () => {
    writeHuskyStyleHook(dir, [
      '#!/bin/sh',
      '. "$(dirname -- "$0")/_/husky.sh"',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    git(['add', 'file.txt']);

    await expect(simpleGit({ baseDir: dir }).commit('user commit')).rejects.toThrow(/husky\.sh/);
  });
});
