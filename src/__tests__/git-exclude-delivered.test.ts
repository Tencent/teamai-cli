import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deliveredUnion } from '../git-exclude-delivered.js';
import { liveDeliveredLists } from '../pull.js';

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
    vi.unstubAllEnvs();
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

  it('keeps listing a path a member\'s rule for that file hides once teamai\'s delivered block below it lists the path too', async () => {
    const listed = { paths: [path.join(main, rel)], foreign: [] };
    await fse.outputFile(exclude(), `/${rel}\n`);
    expect(await union()).toEqual(listed);
    // The block the pull writes for it; its line now decides for git.
    await fse.outputFile(exclude(), `/${rel}\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(listed);
  });

  it('keeps listing a path the member\'s core.excludesFile hides once teamai\'s delivered block lists the path too', async () => {
    const listed = { paths: [path.join(main, rel)], foreign: [] };
    const globalFile = path.join(tmp, 'global-ignore');
    await fse.outputFile(globalFile, `/${rel}\n`);
    git(main, 'config', 'core.excludesFile', globalFile);
    expect(await union()).toEqual(listed);
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(listed);
  });

  it('holds a path back while the member\'s own rule re-includes another checkout\'s file there, before and after teamai\'s block', async () => {
    const foreign = { paths: [], foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }] };
    await fse.outputFile(exclude(), `!/${rel}\n`);
    expect(await union()).toEqual(foreign);
    await fse.outputFile(exclude(), `!/${rel}\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(foreign);
  });

  it('holds a path back when the other checkout\'s .gitignore re-includes the directory the member\'s core.excludesFile hides', async () => {
    const globalFile = path.join(tmp, 'global-ignore');
    await fse.outputFile(globalFile, '/.claude/\n');
    git(main, 'config', 'core.excludesFile', globalFile);
    await fse.outputFile(path.join(wt, '.gitignore'), '!/.claude/\n');
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back when core.excludesFile is set empty, whatever git\'s default ignore file holds', async () => {
    const xdg = path.join(tmp, 'xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    await fse.outputFile(path.join(xdg, 'git', 'ignore'), `/${rel}\n`);
    git(main, 'config', 'core.excludesFile', '');
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back while another checkout\'s own file there is visible to git', async () => {
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it.skipIf(process.platform === 'win32')('asks git about another checkout\'s file once, however many checkouts list its path', async () => {
    const rels = ['a', 'b', 'c', 'd'].map((name) => `.claude/skills/${name}/SKILL.md`);
    for (const r of rels) await fse.outputFile(path.join(wt, r), 'mine\n');
    const listers = async (count: number) => Promise.all(Array.from({ length: count }, async (_, i) => {
      const root = path.join(tmp, `lister-${count}-${i}`);
      for (const r of rels) await fse.outputFile(path.join(root, r), 'team\n');
      return { root, paths: rels.map((r) => path.join(root, r)) };
    }));
    const log = path.join(tmp, 'git-spawns.log');
    const bin = path.join(tmp, 'bin');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await fse.outputFile(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const spawnsFor = async (count: number) => {
      const checkouts = [...await listers(count), { root: wt, paths: [] }];
      await fse.remove(log);
      const union = await deliveredUnion(checkouts);
      expect(union.foreign).toHaveLength(count * rels.length);
      return (await fse.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    };
    await spawnsFor(1);

    const one = await spawnsFor(1);
    const six = await spawnsFor(6);

    expect(one).toBeGreaterThan(0);
    expect(six).toBe(one);
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

describe('liveDeliveredLists', () => {
  let tmp: string;
  let main: string;
  let wt: string;

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-live-lists-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    await fse.outputFile(path.join(main, 'README.md'), 'app\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('lists the current checkout once beside records an older release saved without a root', async () => {
    const skill = path.join(main, '.claude/skills/team/SKILL.md');
    // An older release wrote neither `root` nor `gitExcludePaths`.
    const records = { 'old-1': { rev: 'a', targets: ['claude'] }, 'old-2': { rev: 'a', targets: ['claude'] } };

    const lists = await liveDeliveredLists(main, records, { key: 'current', paths: { skills: [skill] } });

    expect(lists).toEqual([{ root: main, paths: [skill] }, { root: wt, paths: null }]);
  });
});
