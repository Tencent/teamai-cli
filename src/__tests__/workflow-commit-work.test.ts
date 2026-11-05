import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// oxlint-disable-next-line teamai/workflow-boundaries -- tests the merge snapshot place records before finish
import { recordMergePreparation } from '../workflow/place/writer.js';
import { commitWork } from '../workflow/worktree.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-commit-work-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('commitWork', () => {
  it('stages only the paths it is given, so a file beside them stays uncommitted', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');

    await commitWork(dir, 'teamai: fix', undefined, undefined, ['a.txt']);

    expect(git(dir, 'show', 'HEAD:a.txt')).toBe('a\n');
    expect(git(dir, 'status', '--porcelain')).toBe('?? b.txt\n');
  });

  it('commits a staged rename and a staged removal when the child listed the paths git status shows', async () => {
    const dir = repo();
    git(dir, 'mv', 'tracked.txt', 'renamed.txt');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'gone\n');
    git(dir, 'add', 'gone.txt');
    git(dir, 'commit', '-qm', 'gone');
    git(dir, 'rm', '-q', 'gone.txt');

    const committed = await commitWork(dir, 'teamai: fix', undefined, undefined, ['renamed.txt', 'tracked.txt', 'gone.txt']);

    expect(committed).not.toHaveProperty('error');
    expect(git(dir, 'show', 'HEAD:renamed.txt')).toBe('clean\n');
    expect(() => git(dir, 'show', 'HEAD:tracked.txt')).toThrow();
    expect(() => git(dir, 'show', 'HEAD:gone.txt')).toThrow();
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('records a file the merge staged and not an unstaged edit of a tracked file', async () => {
    const dir = repo();
    const branch = git(dir, 'branch', '--show-current').trim();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'base\n');
    git(dir, 'add', 'a.ts');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'right\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'from right\n');
    git(dir, 'add', 'a.ts', 'b.ts');
    git(dir, 'commit', '-qm', 'other');
    git(dir, 'checkout', '-q', branch);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'left\n');
    git(dir, 'commit', '-qm', 'left', 'a.ts');
    expect(() => git(dir, 'merge', 'other')).toThrow();
    fs.appendFileSync(path.join(dir, 'tracked.txt'), 'host\n');

    expect(await recordMergePreparation(dir)).toBeUndefined();
    const recorded = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'teamai-merge.json').trim());
    const merge = JSON.parse(fs.readFileSync(recorded, 'utf8'));
    expect(merge).toHaveProperty('b.ts');
    expect(merge).not.toHaveProperty('tracked.txt');
    expect(merge).not.toHaveProperty('a.ts');
  });
});
