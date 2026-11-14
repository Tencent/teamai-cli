import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keptLocksNotice, settleGitLocks } from '../workflow/steps/git-locks.js';
import { worktreePath } from '../workflow/worktree.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(): { root: string; checkout: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-locks-')));
  dirs.push(root);
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: checkout });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: checkout });

  return { root, checkout };
}

describe('settleGitLocks', () => {
  it('removes the locks a clone has, and none behind a link the agent made under .git/refs', async () => {
    const { root, checkout } = repo();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'kept.lock'), '');
    fs.writeFileSync(path.join(checkout, '.git', 'index.lock'), '');
    fs.writeFileSync(path.join(checkout, '.git', 'refs', 'heads', 'main.lock'), '');
    fs.symlinkSync(outside, path.join(checkout, '.git', 'refs', 'outside'));

    expect(await settleGitLocks({ cwd: checkout, place: 'clone' })).toEqual([]);
    expect([fs.existsSync(path.join(checkout, '.git', 'index.lock')), fs.existsSync(path.join(checkout, '.git', 'refs', 'heads', 'main.lock'))]).toEqual([false, false]);
    expect(fs.readdirSync(outside)).toEqual(['kept.lock']);
  });

  it('leaves a folder the agent named like a lock in a clone', async () => {
    const { checkout } = repo();
    fs.writeFileSync(path.join(checkout, '.git', 'index.lock'), '');
    fs.mkdirSync(path.join(checkout, '.git', 'refs', 'heads', 'wip.lock'));
    fs.mkdirSync(path.join(checkout, '.git', 'modules.lock'));

    await settleGitLocks({ cwd: checkout, place: 'clone' });

    expect(fs.existsSync(path.join(checkout, '.git', 'index.lock'))).toBe(false);
    expect([fs.statSync(path.join(checkout, '.git', 'refs', 'heads', 'wip.lock')).isDirectory(), fs.statSync(path.join(checkout, '.git', 'modules.lock')).isDirectory()]).toEqual([true, true]);
  });

  it('removes nothing through a worktree whose .git the agent pointed at another git directory, and names the checkout\'s locks', async () => {
    const { root, checkout } = repo();
    const worktree = worktreePath(checkout, 'teamai/run/step');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'teamai/run/step', worktree], { cwd: checkout });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'index.lock'), '');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${elsewhere}\n`);
    fs.writeFileSync(path.join(checkout, '.git', 'index.lock'), '');
    fs.writeFileSync(path.join(checkout, '.git', 'packed-refs.lock'), '');

    expect(await settleGitLocks({ cwd: worktree, place: 'worktree' })).toEqual([path.join(checkout, '.git', 'packed-refs.lock')]);
    expect([fs.existsSync(path.join(elsewhere, 'index.lock')), fs.existsSync(path.join(checkout, '.git', 'index.lock'))]).toEqual([true, true]);
  });

  it('removes the own locks of a worktree made from a member checkout that is itself a linked worktree, and names the repository\'s', async () => {
    const { root, checkout } = repo();
    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'mine', linked], { cwd: checkout });
    const worktree = worktreePath(linked, 'teamai/run/step');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'teamai/run/step', worktree], { cwd: linked });
    const own = path.join(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree, encoding: 'utf8' }).trim(), 'index.lock');
    const ref = path.join(checkout, '.git', 'refs', 'heads', 'teamai', 'run', 'step.lock');
    fs.writeFileSync(own, '');
    fs.writeFileSync(ref, '');

    expect(await settleGitLocks({ cwd: worktree, place: 'worktree' })).toEqual([ref]);
    expect(fs.existsSync(own)).toBe(false);
  });

  it('names the locks of a member\'s linked worktree and of its repository, and removes none', async () => {
    const { root, checkout } = repo();
    const linked = path.join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'mine', linked], { cwd: checkout });
    const own = path.join(checkout, '.git', 'worktrees', 'linked', 'index.lock');
    const ref = path.join(checkout, '.git', 'refs', 'heads', 'mine.lock');
    fs.writeFileSync(own, '');
    fs.writeFileSync(ref, '');

    expect((await settleGitLocks({ cwd: linked, place: 'member' })).sort()).toEqual([own, ref].sort());
    expect([fs.existsSync(own), fs.existsSync(ref)]).toEqual([true, true]);
  });

  it('names the locks of a member\'s checkout a step started from a folder inside of', async () => {
    const { checkout } = repo();
    const inside = path.join(checkout, 'packages', 'app');
    fs.mkdirSync(inside, { recursive: true });
    const lock = path.join(checkout, '.git', 'index.lock');
    fs.writeFileSync(lock, '');

    expect(await settleGitLocks({ cwd: inside, place: 'member' })).toEqual([lock]);
  });
});

describe('keptLocksNotice', () => {
  it.each([
    { platform: 'darwin', command: "rm '/repo/.git/index.lock' '/repo/.git/it'\\''s.lock'" },
    { platform: 'win32', command: "Remove-Item -LiteralPath '/repo/.git/index.lock','/repo/.git/it''s.lock'" },
  ])('gives the command that removes the locks it kept on $platform', ({ platform, command }) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    let notice: string;

    try {
      notice = keptLocksNotice(['/repo/.git/index.lock', "/repo/.git/it's.lock"], 'claude');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }

    expect(notice.endsWith(`remove it: ${command}`)).toBe(true);
  });
});
