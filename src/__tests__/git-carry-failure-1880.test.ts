import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1880: a failure while the changes are copied must not report that the copies
// are the only source, and must not leave the temp folder behind — the reset
// has not run, so the originals are still in the working tree.
vi.mock('@teamai/shared/regular-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@teamai/shared/regular-file')>();

  return {
    ...actual,
    copyRegularTree: vi.fn(() => Promise.reject(new Error('Cannot copy a FIFO pipe'))),
  };
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('prepareExplicitBranch when the changes cannot be set aside (#1880)', () => {
  it('removes the temp folder and says nothing was reset, since the copies are only waste', async () => {
    const { prepareExplicitBranch } = await import('../utils/git.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-carry-fail-'));
    dirs.push(dir);
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');

    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(dir, 'clone', '-q', remote, repo);
    git(repo, 'config', 'user.email', 't@teamai.test');
    git(repo, 'config', 'user.name', 'TeamAI');
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: t\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    // A pending edit, which is what carryWorkingTree sets aside.
    fs.appendFileSync(path.join(repo, 'teamai.yaml'), 'autoUpdate: false\n');

    const before = fs.readFileSync(path.join(repo, 'teamai.yaml'), 'utf8');
    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('teamai-push-carry-')));

    await expect(prepareExplicitBranch(repo, 'review/carry')).rejects.toThrow(/nothing was reset, so they are where they were/);

    // The edit is untouched: the reset never ran.
    expect(fs.readFileSync(path.join(repo, 'teamai.yaml'), 'utf8')).toBe(before);
    // And no temp folder was left for a failure that copied nothing useful.
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('teamai-push-carry-'));
    expect(tmpAfter.filter((name) => !tmpBefore.has(name))).toEqual([]);
  });
});
