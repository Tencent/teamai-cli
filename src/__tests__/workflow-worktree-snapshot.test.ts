import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { changedPaths, snapshotWorktree } from '../workflow/place/worktree-snapshot.js';
import { git, type Git } from '../workflow/worktree.js';

let repo = '';

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-snapshot-'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'member@example.com');
  sh('config', 'user.name', 'Member');
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

function sh(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** `git`, counting each process it starts. */
function counting(): { run: Git; calls: string[][] } {
  const calls: string[][] = [];

  return { calls, run: (cwd, args, options) => { calls.push(args); return git(cwd, args, options); } };
}

/** What `git ls-files -s` prints for `relative` alone, as `mode:blob:stage` joined by commas. */
function indexEntries(relative: string): string {
  return sh('ls-files', '-s', '--', relative).split('\n').filter((line) => line !== '')
    .map((line) => line.split('\t')[0]?.split(' ').join(':')).join(',');
}

it('lists the index entries of every changed path in one git call, however many paths there are', async () => {
  for (let index = 0; index < 12; index += 1) fs.writeFileSync(path.join(repo, `new-${index}.txt`), `${index}\n`);
  const { run, calls } = counting();

  const snapshot = await snapshotWorktree(repo, run);

  expect(snapshot.files.size).toBe(12);
  expect(calls.filter((args) => args.includes('ls-files'))).toHaveLength(1);
  expect(calls).toHaveLength(4);
});

it('keeps every stage of a conflicted path', async () => {
  fs.writeFileSync(path.join(repo, 'both.txt'), 'base\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'both');
  sh('checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'both.txt'), 'side\n');
  sh('commit', '-q', '-am', 'side');
  sh('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'both.txt'), 'main\n');
  sh('commit', '-q', '-am', 'main');
  expect(() => sh('merge', '-q', 'side')).toThrow();

  const staged = (await snapshotWorktree(repo, git)).files.get('both.txt') ?? '';

  expect(indexEntries('both.txt').split(',').map((entry) => entry.split(':')[2])).toEqual(['1', '2', '3']);
  expect(staged.startsWith(`UU:${indexEntries('both.txt')}:`)).toBe(true);
});

it('gives a file that replaced a tracked folder the entries git still holds under it', async () => {
  fs.mkdirSync(path.join(repo, 'folder'));
  fs.writeFileSync(path.join(repo, 'folder', 'inside.txt'), 'inside\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'folder');
  const inside = indexEntries('folder/inside.txt');
  fs.rmSync(path.join(repo, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'folder'), 'now a file\n');

  const { files } = await snapshotWorktree(repo, git);

  expect(files.get('folder')?.startsWith(`??:${inside}:`)).toBe(true);
  expect(files.get('folder/inside.txt')?.startsWith(` D:${inside}:`)).toBe(true);
});

it('reads each path\'s own entry when its name is a glob or starts with a colon', async () => {
  for (const name of ['[ab]', 'a', 'b', ':x']) fs.writeFileSync(path.join(repo, name), 'tracked\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'odd names');
  for (const name of ['[ab]', ':x']) fs.writeFileSync(path.join(repo, name), 'edited\n');

  const { files } = await snapshotWorktree(repo, git);

  expect(files.get('[ab]')?.startsWith(` M:${sh('ls-files', '-s', '--', ':(literal)[ab]').split('\t')[0]?.split(' ').join(':')}:`)).toBe(true);
  expect(files.get(':x')?.startsWith(` M:${sh('ls-files', '-s', '--', ':(literal):x').split('\t')[0]?.split(' ').join(':')}:`)).toBe(true);
  expect(files.has('a')).toBe(false);
});

it('splits a list of paths too long for one command line, and still reads every entry', async () => {
  const names = Array.from({ length: 300 }, (_, index) => `${'long-name-'.repeat(8)}${index}.txt`);
  for (const name of names) fs.writeFileSync(path.join(repo, name), 'tracked\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'many');
  for (const name of names) fs.writeFileSync(path.join(repo, name), 'edited\n');
  const { run, calls } = counting();

  const { files } = await snapshotWorktree(repo, run);

  const listing = calls.filter((args) => args.includes('ls-files'));
  expect(listing.length).toBeGreaterThan(1);
  expect(listing.length).toBeLessThan(10);
  expect(listing.every((args) => args.join(' ').length < 10_000)).toBe(true);
  for (const name of names) expect(files.get(name)?.startsWith(` M:${indexEntries(name)}:`)).toBe(true);
});

it('sees an edit of a tracked file between two snapshots', async () => {
  const before = await snapshotWorktree(repo, git);
  fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n');

  expect(changedPaths(before, await snapshotWorktree(repo, git))).toEqual(['README.md']);
});

it('gives each path an entry once when the paths that hold it fall in different batches', async () => {
  fs.mkdirSync(path.join(repo, 'folder'));
  fs.writeFileSync(path.join(repo, 'folder', 'inside.txt'), 'inside\n');
  const names = Array.from({ length: 300 }, (_, index) => `${'long-name-'.repeat(8)}${index}.txt`);
  for (const name of names) fs.writeFileSync(path.join(repo, name), 'tracked\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'folder and many');
  const inside = indexEntries('folder/inside.txt');
  for (const name of names) fs.writeFileSync(path.join(repo, name), 'edited\n');
  fs.rmSync(path.join(repo, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'folder'), 'now a file\n');

  const { files } = await snapshotWorktree(repo, git);

  expect(files.get('folder')?.startsWith(`??:${inside}:`)).toBe(true);
  expect(files.get('folder/inside.txt')?.startsWith(` D:${inside}:`)).toBe(true);
});

it('lists only the entry of a path whose name is a glob', async () => {
  for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(repo, `other-${index}.txt`), 'tracked\n');
  fs.writeFileSync(path.join(repo, '*'), 'tracked\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'star');
  fs.writeFileSync(path.join(repo, '*'), 'edited\n');
  const listed: string[] = [];
  const run: Git = async (cwd, args, options) => {
    const read = await git(cwd, args, options);
    if (args.includes('ls-files')) listed.push(read.stdout);
    return read;
  };

  await snapshotWorktree(repo, run);

  expect(listed.join('').split('\0').filter((record) => record !== '').map((record) => record.split('\t')[1])).toEqual(['*']);
});
