import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// oxlint-disable-next-line teamai/workflow-boundaries -- tests the merge snapshot place records before finish
import { recordMergePreparation } from '../workflow/place/writer.js';
import { commitWork, worktreeContentKey } from '../workflow/worktree.js';

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

  it('does not record a staged deletion whose path the host recreated', async () => {
    const dir = repo();
    git(dir, 'rm', '-q', 'tracked.txt');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'host\n');

    expect(await recordMergePreparation(dir)).toBeUndefined();
    const recorded = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'teamai-merge.json').trim());
    const merge = JSON.parse(fs.readFileSync(recorded, 'utf8'));
    expect(merge).not.toHaveProperty('tracked.txt');
  });

  it('stages the reported path and not a file a bracket in that path matches', async () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'app', '[id]'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app', 'i'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', '[id]', 'page.tsx'), 'page\n');
    fs.writeFileSync(path.join(dir, 'app', 'i', 'page.tsx'), 'host\n');

    const committed = await commitWork(dir, 'teamai: fix', undefined, undefined, ['app/[id]/page.tsx']);

    expect(committed).not.toHaveProperty('error');
    const tree = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tree).toContain('app/[id]/page.tsx');
    expect(tree).not.toContain('app/i/page.tsx');
    expect(git(dir, 'status', '--porcelain')).toContain('app/i/');
  });

  it('fingerprints a submodule by the commit checked out in it', async () => {
    const dir = repo();
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sub-'));
    dirs.push(origin);
    execFileSync('git', ['init', '-q'], { cwd: origin });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: origin });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: origin });
    fs.writeFileSync(path.join(origin, 'readme.txt'), 'one\n');
    execFileSync('git', ['add', 'readme.txt'], { cwd: origin });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: origin });
    const first = git(origin, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(origin, 'readme.txt'), 'two\n');
    execFileSync('git', ['commit', '-qm', 'two', 'readme.txt'], { cwd: origin });
    const second = git(origin, 'rev-parse', 'HEAD').trim();
    execFileSync('git', ['clone', '-q', origin, path.join(dir, 'vendor')]);
    git(path.join(dir, 'vendor'), 'checkout', '-q', first);
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${first},vendor`);

    expect(await worktreeContentKey(dir, 'vendor')).toBe(`gitlink:${first}`);
    git(path.join(dir, 'vendor'), 'checkout', '-q', second);
    expect(await worktreeContentKey(dir, 'vendor')).toBe(`gitlink:${second}`);
  });
});
