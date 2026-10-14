import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deliveredUnion } from '../git-exclude-delivered.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

describe('deliveredUnion', () => {
  const rel = '.claude/rules/team.md';
  let tmp: string;
  let main: string;
  let wt: string;
  // The main checkout lists its delivered copy; the worktree has its own file at that path, not in its list.
  const union = () => deliveredUnion([{ root: main, paths: [path.join(main, rel)] }, { root: wt, paths: [] }]);
  // The exclude file every checkout of the repository shares.
  const exclude = (): string => path.resolve(main, git(main, 'rev-parse', '--git-path', 'info/exclude').trim());

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-delivered-union-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    await fse.outputFile(path.join(main, 'README.md'), 'app\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    await fse.outputFile(path.join(main, rel), 'team\n');
    await fse.outputFile(path.join(wt, rel), 'mine\n');
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('lists a path another checkout\'s own git ignore rule already hides there', async () => {
    await fse.outputFile(path.join(wt, '.gitignore'), '.claude/\n');
    expect(await union()).toEqual({ paths: [path.join(main, rel)], foreign: [] });
  });

  it('lists a path a member\'s line in the shared info/exclude already hides in another checkout', async () => {
    await fse.outputFile(exclude(), `.claude/\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({ paths: [path.join(main, rel)], foreign: [] });
  });

  it('holds a path back while another checkout\'s own file there is visible to git', async () => {
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back when only teamai\'s own delivered block ignores the other checkout\'s file', async () => {
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(git(wt, 'check-ignore', '--', rel).trim()).toBe(rel);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });
});
