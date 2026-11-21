import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worktreeHooks } from '../workflow/worktree.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

describe('worktreeHooks in a worktree of a bare repository', () => {
  let sandbox: string;
  let bare: string;
  let member: string;
  let sibling: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bare-wt-'));
    bare = path.join(sandbox, 'repo.git');
    member = path.join(sandbox, 'member');
    sibling = path.join(sandbox, 'sibling');
    git(['init', '--bare', '-q', '-b', 'main', bare], sandbox);
    const seed = path.join(sandbox, 'seed');

    fs.mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    git(['commit', '-q', '--allow-empty', '-m', 'seed'], seed);
    git(['push', '-q', bare, 'main'], seed);
    git(['--git-dir', bare, 'worktree', 'add', '-q', '-b', 'member', member, 'main'], sandbox);
    git(['--git-dir', bare, 'worktree', 'add', '-q', '-b', 'sibling', sibling, 'main'], sandbox);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('keeps every linked worktree usable and the main one bare', async () => {
    await worktreeHooks(member, path.join(sandbox, 'hooks'));

    for (const dir of [member, sibling]) {
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: dir }).status).toBe(0);
    }

    expect(git(['--git-dir', bare, 'rev-parse', '--is-bare-repository'], sandbox)).toBe('true');
    expect(git(['config', '--worktree', '--get', 'core.hooksPath'], member)).toBe(path.join(sandbox, 'hooks'));
  });
});
