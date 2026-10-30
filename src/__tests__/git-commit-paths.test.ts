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

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
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

  it.each(['existing', 'unborn'])('preserves unrelated staged and unstaged changes with an %s HEAD', async (head) => {
    const business = path.join(dir, 'business.ts');
    if (head === 'existing') {
      fs.writeFileSync(business, 'committed business\n');
      fs.writeFileSync(path.join(dir, 'deleted.txt'), 'keep this deletion staged\n');
      git(['add', '.']);
      git(['commit', '-qm', 'seed']);
      git(['rm', 'deleted.txt']);
    }
    fs.writeFileSync(business, 'staged business\n');
    fs.writeFileSync(path.join(dir, 'added.txt'), 'staged addition\n');
    git(['add', 'business.ts', 'added.txt']);
    fs.writeFileSync(business, 'unstaged business\n');
    const businessPaths = ['business.ts', 'added.txt', 'deleted.txt'];
    const stagedBefore = gitOutput(['diff', '--cached', '--binary', '--no-renames', '--', ...businessPaths]);
    fs.mkdirSync(path.join(dir, '.teamai', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.teamai', 'skills', '.gitkeep'), '');

    expect(await commitPaths(dir, 'init skeleton', ['.teamai/skills'])).toBe(true);

    expect(gitOutput(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim())
      .toBe('.teamai/skills/.gitkeep');
    expect(gitOutput(['diff', '--cached', '--binary', '--no-renames', '--', ...businessPaths])).toBe(stagedBefore);
    expect(gitOutput(['show', ':business.ts'])).toBe('staged business\n');
    expect(fs.readFileSync(business, 'utf8')).toBe('unstaged business\n');
  });

  it('does not commit unrelated staged changes when the selected files are unchanged', async () => {
    fs.writeFileSync(path.join(dir, 'skeleton.txt'), 'skeleton\n');
    git(['add', '.']);
    git(['commit', '-qm', 'seed']);
    const head = gitOutput(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'business.ts'), 'staged business\n');
    git(['add', 'business.ts']);
    const stagedBefore = gitOutput(['diff', '--cached', '--binary']);

    expect(await commitPaths(dir, 'nothing new', ['skeleton.txt'])).toBe(false);

    expect(gitOutput(['rev-parse', 'HEAD'])).toBe(head);
    expect(gitOutput(['diff', '--cached', '--binary'])).toBe(stagedBefore);
  });

  it('commits selected additions and deletions without treating filenames as pathspecs', async () => {
    const skills = path.join(dir, '.teamai', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'old.md'), 'old\n');
    fs.writeFileSync(path.join(skills, '.gitkeep'), '');
    git(['add', '.']);
    git(['commit', '-qm', 'seed']);
    fs.unlinkSync(path.join(skills, 'old.md'));
    fs.writeFileSync(path.join(skills, '[notes] space.md'), 'new\n');
    fs.writeFileSync(path.join(skills, 'n space.md'), 'another selected file\n');
    fs.mkdirSync(path.join(dir, 'empty'));

    expect(await commitPaths(dir, 'update skeleton', ['.teamai/skills', 'empty'])).toBe(true);

    expect(gitOutput(['show', 'HEAD:.teamai/skills/[notes] space.md'])).toBe('new\n');
    expect(gitOutput(['diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD']))
      .toContain('D\t.teamai/skills/old.md');
    expect(gitOutput(['status', '--porcelain'])).toBe('');
  });

  it.each(['untracked', 'staged'])('treats the requested path literally when a matching unrelated file is %s', async (state) => {
    const selected = 'dir[1]/settings.json';
    const unrelated = 'dir1/settings.json';
    fs.mkdirSync(path.join(dir, 'dir[1]'));
    fs.mkdirSync(path.join(dir, 'dir1'));
    fs.writeFileSync(path.join(dir, selected), 'selected\n');
    fs.writeFileSync(path.join(dir, unrelated), 'unrelated staged content\n');
    if (state === 'staged') git(['--literal-pathspecs', 'add', '--', unrelated]);
    fs.writeFileSync(path.join(dir, unrelated), 'unrelated working content\n');
    const stagedBefore = gitOutput(['diff', '--cached', '--binary', '--', unrelated]);

    expect(await commitPaths(dir, 'init settings', [selected])).toBe(true);

    expect(gitOutput(['ls-tree', '-r', '--name-only', 'HEAD']).trim()).toBe(selected);
    expect(gitOutput(['diff', '--cached', '--binary', '--', unrelated])).toBe(stagedBefore);
    expect(fs.readFileSync(path.join(dir, unrelated), 'utf8')).toBe('unrelated working content\n');
    if (state === 'untracked') expect(gitOutput(['ls-files', '--others', '--exclude-standard']).trim()).toBe(unrelated);
  });
});
