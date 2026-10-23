import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fse from 'fs-extra';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { archiveReplacedClone } from '../utils/replaced-clone.js';
import { acquireLock, releaseLock } from '../update.js';

let root: string;
let clone: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args: string[], cwd = clone) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-replace-')));
  clone = path.join(root, 'team-repo'); fs.mkdirSync(clone);
  git(['init', '-q', '-b', 'main']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'unpublished main', '--allow-empty']);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function worktree(name: string, branch = name) {
  const dir = path.join(root, name);
  git(['worktree', 'add', '-qb', branch, dir]);
  fs.writeFileSync(path.join(dir, 'pending.txt'), 'not published');
  return dir;
}
it('keeps dirty files, unpublished refs and repaired links for both side worktrees', async () => {
  worktree('reports-wt', 'teamai-reports'); worktree('learnings-wt', 'teamai-learnings');
  fs.writeFileSync(path.join(clone, 'local.txt'), 'main edit');
  const before = vi.fn();
  const backup = await archiveReplacedClone(clone, before);
  expect(before).toHaveBeenCalledOnce();
  expect(fs.existsSync(clone)).toBe(false);
  expect(fs.readFileSync(path.join(backup, 'team-repo', 'local.txt'), 'utf8')).toBe('main edit');
  for (const name of ['reports-wt', 'learnings-wt']) {
    expect(fs.existsSync(path.join(root, name))).toBe(false);
    expect(git(['status', '--porcelain'], path.join(backup, name))).toContain('pending.txt');
    expect(git(['rev-parse', '--git-common-dir'], path.join(backup, name))).toContain(backup);
  }
  expect(git(['show', '-s', '--format=%s', 'main'], path.join(backup, 'team-repo'))).toBe('unpublished main');
});
it('leaves an unproven sibling and the old clone untouched', async () => {
  const dir = path.join(root, 'reports-wt'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'mine'), 'foreign');
  const before = vi.fn();
  await expect(archiveReplacedClone(clone, before)).rejects.toThrow('not a proven worktree');
  expect(before).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(dir, 'mine'), 'utf8')).toBe('foreign');
  expect(git(['rev-parse', '--is-inside-work-tree'])).toBe('true');
});
it('refuses to invalidate an unrelated registered checkout', async () => {
  const extra = worktree('user-checkout');
  await expect(archiveReplacedClone(clone, async () => {})).rejects.toThrow('another registered worktree');
  expect(git(['status', '--porcelain'], extra)).toContain('pending.txt');
});
it.each(['.sync-lock', '.reports-lock', '.learnings-lock'])('refuses a live %s and releases earlier locks', async name => {
  const lock = path.join(root, name);
  expect(await acquireLock(lock)).toBe(true);
  try {
    await expect(archiveReplacedClone(clone, async () => {})).rejects.toThrow('is held');
    expect(fs.existsSync(clone)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
  } finally { await releaseLock(lock); }
  expect(fs.readdirSync(root).filter(name => name.endsWith('-lock'))).toEqual([]);
});
it('restores a moved dirty worktree if renaming the main clone fails', async () => {
  const dir = worktree('reports-wt');
  const rename = fse.rename.bind(fse);
  vi.spyOn(fse, 'rename').mockImplementation((async (from: string, to: string) => {
    if (from === clone) throw new Error('fixture rename failure');
    return rename(from, to);
  }) as typeof fse.rename);
  await expect(archiveReplacedClone(clone, async () => {})).rejects.toThrow('fixture rename failure');
  expect(git(['status', '--porcelain'], dir)).toContain('pending.txt');
  expect(fs.readdirSync(root).some(name => name.startsWith('previous-team-'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('refuses a dangling sibling symlink before changing the clone', async () => {
  const link = path.join(root, 'learnings-wt');
  fs.symlinkSync(path.join(root, 'missing'), link);
  await expect(archiveReplacedClone(clone, async () => {})).rejects.toThrow('not a proven worktree');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(git(['rev-parse', '--is-inside-work-tree'])).toBe('true');
});
