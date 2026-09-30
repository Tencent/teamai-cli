import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

// Real-git test (#808): self and git mode keep the reports checkout at the
// same partition path, so after a mode switch the checkout there can belong to
// another repository. `teamai stats` must read neither that team's totals nor
// its stats file's mtime, which would date this scope's last report.

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

const { showStats } = await import('../stats.js');
const { resolveAnchors } = await import('../utils/git.js');
const { resolvePartitionDir } = await import('../utils/partition.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('stats with another repository\'s reports checkout in the partition (#808)', () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stats-foreign-808-')));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(testRoot, 'home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('reads neither that checkout\'s totals nor its stats file\'s mtime', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => { out.push(String(line)); });

    const businessRoot = path.join(testRoot, 'business');
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
    const partition = await resolvePartitionDir(anchors.projectAnchor);
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
    // The scope's own snapshot: with it, snapshotWrittenAt reads the reports
    // checkout's stats file too.
    fs.mkdirSync(path.join(partition, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(partition, 'dashboard', 'reported-prompt-tokens.json'), '{}');

    // The other team's repository, with its checkout of teamai-reports where
    // this project's would be, holding totals for the same username.
    const teamRemote = path.join(testRoot, 'team.git');
    const teamSeed = path.join(testRoot, 'team-seed');
    git(['init', '-q', '--bare', teamRemote], testRoot);
    git(['init', '-q', '-b', 'teamai-reports', teamSeed], testRoot);
    fs.mkdirSync(path.join(teamSeed, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'stats', 'test.yaml'), YAML.stringify({
      username: 'test',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 3,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      interventions: { sessions: 3, interrupt: 0, toolReject: 0, correction: 0 },
    }));
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'reports'], teamSeed);
    git(['remote', 'add', 'origin', teamRemote], teamSeed);
    git(['push', '-q', 'origin', 'teamai-reports'], teamSeed);
    const teamClone = path.join(partition, 'team-repo');
    git(['clone', '-q', teamRemote, teamClone], testRoot);
    const foreignCheckout = path.join(partition, 'reports-wt');
    git(['worktree', 'add', '-q', foreignCheckout, 'teamai-reports'], teamClone);

    const stat = vi.spyOn(fs.promises, 'stat');
    const cwd = process.cwd();
    process.chdir(businessRoot);
    try {
      await showStats();
    } finally {
      process.chdir(cwd);
    }

    expect(stat.mock.calls.map(([file]) => String(file))).not.toContain(path.join(foreignCheckout, 'stats', 'test.yaml'));
    expect(out.join('\n')).not.toMatch(/Sessions:\s+3/);
  });
});
