import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasCommits, commitPaths } from '../utils/git.js';

// Real-git integration tests for the single-repo init-commit helpers.
// (git.test.ts mocks simple-git globally, so these live in their own file.)

let dir: string;
function git(args: string[]) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-commitpaths-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.co']);
  git(['config', 'user.name', 't']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hasCommits', () => {
  it('is false for a freshly-init repo (unborn HEAD)', async () => {
    expect(await hasCommits(dir)).toBe(false);
  });

  it('is true once a commit exists', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
    expect(await hasCommits(dir)).toBe(true);
  });
});

describe('commitPaths', () => {
  it('creates the first commit in an empty repo from the given paths', async () => {
    fs.mkdirSync(path.join(dir, '.teamai', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.teamai', 'skills', '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, '.teamai', 'teamai.yaml'), 'team: x\nmode: self\n');

    const committed = await commitPaths(dir, 'init skeleton', ['.teamai/skills', '.teamai/teamai.yaml']);
    expect(committed).toBe(true);
    expect(await hasCommits(dir)).toBe(true);

    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
    expect(tracked).toContain('.teamai/skills/.gitkeep');
    expect(tracked).toContain('.teamai/teamai.yaml');
  });

  it('returns false when none of the paths exist', async () => {
    const committed = await commitPaths(dir, 'nothing', ['.teamai/does-not-exist']);
    expect(committed).toBe(false);
    expect(await hasCommits(dir)).toBe(false);
  });

  it('skips a gitignored path instead of aborting the whole commit', async () => {
    // env/ is gitignored (single-repo layout), skills/ is not — the commit must
    // still succeed with the non-ignored path.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-dir/\n');
    fs.mkdirSync(path.join(dir, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ignored-dir', 'x'), 'x');
    fs.mkdirSync(path.join(dir, 'kept'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'kept', 'y'), 'y');

    const committed = await commitPaths(dir, 'mixed', ['ignored-dir', 'kept']);
    expect(committed).toBe(true);
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
    expect(tracked).toContain('kept/y');
    expect(tracked).not.toContain('ignored-dir/x');
  });
});
