import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportsBranch } from '../utils/reports-branch.js';
import { learningsBranch } from '../utils/learnings-branch.js';
import { acquireLock, releaseLock } from '../update.js';
import { LEARNINGS_LOCK_FILENAME, REPORTS_LOCK_FILENAME, type LocalConfig } from '../types.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

describe('retiring a branch worktree before replacing its clone', () => {
  let sandbox: string;
  let remote: string;
  let clone: string;
  let checkout: string;
  let config: LocalConfig;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-retire-wt-'));
    remote = path.join(sandbox, 'remote.git');
    clone = path.join(sandbox, 'team-repo');
    checkout = path.join(sandbox, 'reports-wt');
    const seed = path.join(sandbox, 'seed');

    fs.mkdirSync(seed);
    git(['init', '-q', '--bare', remote], sandbox);
    git(['init', '-q', '-b', 'main'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), 'fixture\n');
    git(['add', '.'], seed);
    git(['commit', '-qm', 'seed'], seed);
    git(['remote', 'add', 'origin', remote], seed);
    git(['push', '-q', '-u', 'origin', 'main'], seed);
    git(['checkout', '-q', '--orphan', 'teamai-reports'], seed);
    git(['rm', '-qrf', '.'], seed);
    fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\n');
    git(['add', '.gitignore'], seed);
    git(['commit', '-qm', 'reports'], seed);
    git(['push', '-q', '-u', 'origin', 'teamai-reports'], seed);

    git(['clone', '-q', remote, clone], sandbox);
    git(['fetch', '-q', 'origin', 'teamai-reports:teamai-reports'], clone);
    git(['worktree', 'add', '-q', checkout, 'teamai-reports'], clone);
    config = {
      repo: { localPath: clone, remote },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
  });

  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('pushes a local-only commit before removing the owned checkout', async () => {
    fs.writeFileSync(path.join(checkout, 'report.txt'), 'pending\n');
    git(['add', 'report.txt'], checkout);
    git(['commit', '-qm', 'pending report'], checkout);
    const localHead = git(['rev-parse', 'HEAD'], checkout);

    await reportsBranch.retire(config);

    expect(fs.existsSync(checkout)).toBe(false);
    expect(git(['rev-parse', 'refs/heads/teamai-reports'], remote)).toBe(localHead);
  });

  it('removes a clean checkout whose commits are already preserved on origin', async () => {
    const other = path.join(sandbox, 'other');
    git(['clone', '-q', '-b', 'teamai-reports', remote, other], sandbox);
    fs.writeFileSync(path.join(other, 'remote-report.txt'), 'published elsewhere\n');
    git(['add', 'remote-report.txt'], other);
    git(['commit', '-qm', 'remote report'], other);
    git(['push', '-q', 'origin', 'teamai-reports'], other);
    const remoteHead = git(['rev-parse', 'refs/heads/teamai-reports'], remote);

    await reportsBranch.retire(config);

    expect(fs.existsSync(checkout)).toBe(false);
    expect(git(['rev-parse', 'refs/heads/teamai-reports'], remote)).toBe(remoteHead);
  });

  it('recognizes its checkout through a symlinked parent path', async () => {
    const alias = path.join(sandbox, 'alias');
    fs.symlinkSync(sandbox, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await reportsBranch.retire({
      ...config,
      repo: { ...config.repo, localPath: path.join(alias, path.basename(clone)) },
    });

    expect(fs.existsSync(checkout)).toBe(false);
  });

  it('keeps a clean checkout when local and origin have diverged', async () => {
    fs.writeFileSync(path.join(checkout, 'local-report.txt'), 'local only\n');
    git(['add', 'local-report.txt'], checkout);
    git(['commit', '-qm', 'local report'], checkout);

    const other = path.join(sandbox, 'other');
    git(['clone', '-q', '-b', 'teamai-reports', remote, other], sandbox);
    fs.writeFileSync(path.join(other, 'remote-report.txt'), 'remote only\n');
    git(['add', 'remote-report.txt'], other);
    git(['commit', '-qm', 'remote report'], other);
    git(['push', '-q', 'origin', 'teamai-reports'], other);

    await expect(reportsBranch.retire(config)).rejects.toThrow('have diverged');

    expect(fs.existsSync(checkout)).toBe(true);
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('holds both writer locks through replacement even when a checkout does not exist', async () => {
    git(['worktree', 'remove', checkout], clone);
    const reportsLockPath = path.join(path.dirname(checkout), REPORTS_LOCK_FILENAME);
    const learningsLockPath = path.join(path.dirname(checkout), LEARNINGS_LOCK_FILENAME);

    await reportsBranch.retire(config, () =>
      learningsBranch.retire(config, async () => {
        expect(await acquireLock(reportsLockPath)).toBe(false);
        expect(await acquireLock(learningsLockPath)).toBe(false);
        expect(fs.existsSync(clone)).toBe(true);
      }),
    );

    expect(await acquireLock(reportsLockPath)).toBe(true);
    expect(await acquireLock(learningsLockPath)).toBe(true);
    await releaseLock(learningsLockPath);
    await releaseLock(reportsLockPath);
  });

  it('keeps the checkout and clone when it has uncommitted work', async () => {
    fs.writeFileSync(path.join(checkout, 'pending.txt'), 'not committed\n');

    await expect(reportsBranch.retire(config)).rejects.toThrow('has uncommitted changes');

    expect(fs.existsSync(checkout)).toBe(true);
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('reports an owned dirty checkout before replacement', async () => {
    fs.writeFileSync(path.join(checkout, 'pending.txt'), 'not committed\n');

    expect(await reportsBranch.isDirty(config)).toBe(true);
  });

  it('does not remove an unregistered directory at the managed path', async () => {
    git(['worktree', 'remove', checkout], clone);
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, 'keep.txt'), 'unknown owner\n');

    await expect(reportsBranch.retire(config)).rejects.toThrow('is not registered');

    expect(fs.readFileSync(path.join(checkout, 'keep.txt'), 'utf8')).toBe('unknown owner\n');
  });

  it('does not claim an unregistered directory at the managed path', async () => {
    git(['worktree', 'remove', checkout], clone);
    fs.mkdirSync(checkout);

    expect(await reportsBranch.ownsCheckout(config)).toBe(false);
  });
});
