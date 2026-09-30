import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real-git test (#808): self and git mode keep teamai-reports' checkout at the
// same partition path, so after a mode switch it may be another repository's.
// Its votes are that team's: nothing that ranks or downvotes may read them.

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  isSilent: () => false,
}));

const { indexableVotesDir } = await import('../utils/reports-branch.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('indexableVotesDir (#808)', () => {
  let testRoot: string;
  let businessRoot: string;
  let dataHome: string;

  beforeEach(() => {
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-votes-808-')));
    businessRoot = path.join(testRoot, 'business');
    dataHome = path.join(testRoot, 'partition');
    fs.mkdirSync(businessRoot, { recursive: true });
    git(['init', '-q', '-b', 'main'], businessRoot);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], businessRoot);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  const config = () => ({
    repo: { localPath: path.join(businessRoot, '.teamai'), kind: 'self' as const, businessRepoRoot: businessRoot, remote: '' },
    username: 'test',
    additionalRoles: [],
    scope: 'project' as const,
    projectRoot: businessRoot,
    dataHome,
  });

  it("is this project's votes dir when no checkout is there yet", async () => {
    expect(await indexableVotesDir(config())).toBe(path.join(dataHome, 'reports-wt', 'votes'));
  });

  it("is undefined when the reports checkout belongs to another repository", async () => {
    const team = path.join(testRoot, 'team');
    git(['init', '-q', '-b', 'teamai-reports', team], testRoot);
    fs.mkdirSync(path.join(team, 'votes'), { recursive: true });
    fs.writeFileSync(path.join(team, 'votes', 'test.yaml'), 'version: 2\nvotes: {}\ndeltas: {}\n');
    git(['add', '-A'], team);
    git(['commit', '-q', '-m', 'reports'], team);
    git(['checkout', '-q', '-b', 'main'], team);
    git(['worktree', 'add', '-q', path.join(dataHome, 'reports-wt'), 'teamai-reports'], team);

    expect(await indexableVotesDir(config())).toBeUndefined();
  });
});
