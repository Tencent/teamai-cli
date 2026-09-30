import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real-git test (#808): every checkout of a self-mode repo shares the reports
// checkout in the partition, so a reader must not create it while a write
// holds the reports lock: the holder may be creating it right now.

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

const { showStats } = await import('../stats.js');
const { resolveVizRoot } = await import('../viz.js');
const { resolveAnchors } = await import('../utils/git.js');
const { resolvePartitionDir } = await import('../utils/partition.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('stats and viz while a write holds the reports lock (#808)', () => {
  let testRoot: string;
  let originalHome: string | undefined;
  let businessRoot: string;
  let partition: string;

  beforeEach(async () => {
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reports-busy-808-')));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(testRoot, 'home');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    businessRoot = path.join(testRoot, 'business');
    const remote = path.join(testRoot, 'remote.git');
    fs.mkdirSync(path.join(businessRoot, '.teamai', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(businessRoot, '.teamai', 'learnings', '.gitkeep'), '');
    git(['init', '-q', '--bare', remote], testRoot);
    git(['init', '-q', '-b', 'main'], businessRoot);
    git(['config', 'user.email', 't@t.co'], businessRoot);
    git(['config', 'user.name', 't'], businessRoot);
    git(['add', '-A'], businessRoot);
    git(['commit', '-q', '-m', 'init'], businessRoot);
    git(['remote', 'add', 'origin', remote], businessRoot);
    git(['push', '-q', '-u', 'origin', 'main'], businessRoot);

    const anchors = await resolveAnchors(businessRoot);
    if (!anchors) throw new Error('expected the business repo to have git anchors');
    partition = await resolvePartitionDir(anchors.projectAnchor);
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(businessRoot, '.teamai')}`,
      `  remote: ${remote}`,
      '  kind: self',
      `  businessRepoRoot: ${businessRoot}`,
      'username: test',
      'scope: project',
      `projectRoot: ${businessRoot}`,
      'additionalRoles: []',
      '',
    ].join('\n'));
    // A live holder: this test's own process, as another teamai command would be.
    fs.writeFileSync(
      path.join(partition, '.reports-lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'issue-808-test' }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('stats leaves the missing reports checkout to the lock holder', async () => {
    const cwd = process.cwd();
    process.chdir(businessRoot);
    try {
      await showStats();
    } finally {
      process.chdir(cwd);
    }

    expect(fs.existsSync(path.join(partition, 'reports-wt'))).toBe(false);
  });

  it('viz leaves the missing reports checkout to the lock holder', async () => {
    const config = {
      repo: {
        localPath: path.join(businessRoot, '.teamai'),
        kind: 'self' as const,
        businessRepoRoot: businessRoot,
        remote: path.join(testRoot, 'remote.git'),
      },
      username: 'test',
      additionalRoles: [],
      scope: 'project' as const,
      projectRoot: businessRoot,
      dataHome: partition,
    };

    await resolveVizRoot({ config });

    expect(fs.existsSync(path.join(partition, 'reports-wt'))).toBe(false);
  });
});
