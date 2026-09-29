import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real-git test (#808): self and git mode keep the learnings checkout at the
// same partition path, so after a mode switch the checkout there can belong to
// another repository. The knowledge dashboard must not build its index or its
// promotion candidates from that team's learnings.

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  isSilent: () => false,
}));

const { resolveVizRoot, buildVizData } = await import('../viz.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
}

describe('viz with another repository\'s learnings checkout in the partition (#808)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-viz-808-')));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('leaves that checkout out of the dashboard\'s learnings roots', async () => {
    const businessRoot = path.join(testRoot, 'business');
    const remote = path.join(testRoot, 'remote.git');
    const dataHome = path.join(testRoot, 'partition');
    fs.mkdirSync(path.join(businessRoot, '.teamai', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(businessRoot, '.teamai', 'learnings', 'own-2026-01-01-aaaaaa.md'), '# Own learning\n');
    git(['init', '-q', '--bare', remote], testRoot);
    git(['init', '-q', '-b', 'main'], businessRoot);
    // The reports checkout commits in-process, with the repo's identity: a CI
    // runner has no global one.
    git(['config', 'user.email', 't@t.co'], businessRoot);
    git(['config', 'user.name', 't'], businessRoot);
    git(['add', '-A'], businessRoot);
    git(['commit', '-q', '-m', 'init'], businessRoot);
    git(['remote', 'add', 'origin', remote], businessRoot);
    git(['push', '-q', '-u', 'origin', 'main'], businessRoot);

    // The other team's repository, with its checkout of teamai-learnings where
    // this project's would be.
    const teamRemote = path.join(testRoot, 'team.git');
    const teamSeed = path.join(testRoot, 'team-seed');
    git(['init', '-q', '--bare', teamRemote], testRoot);
    git(['init', '-q', '-b', 'teamai-learnings', teamSeed], testRoot);
    fs.mkdirSync(path.join(teamSeed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'learnings', 'foreign-2026-01-01-bbbbbb.md'), '# Foreign learning\n');
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'learnings'], teamSeed);
    git(['remote', 'add', 'origin', teamRemote], teamSeed);
    git(['push', '-q', 'origin', 'teamai-learnings'], teamSeed);
    const teamClone = path.join(dataHome, 'team-repo');
    git(['clone', '-q', teamRemote, teamClone], testRoot);
    const foreignCheckout = path.join(dataHome, 'learnings-wt');
    git(['worktree', 'add', '-q', foreignCheckout, 'teamai-learnings'], teamClone);

    const config = {
      repo: { localPath: path.join(businessRoot, '.teamai'), kind: 'self' as const, businessRepoRoot: businessRoot, remote },
      username: 'test',
      additionalRoles: [],
      scope: 'project' as const,
      projectRoot: businessRoot,
      dataHome,
    };

    const paths = await resolveVizRoot({ config });

    expect(paths.learningsDirs).not.toContain(path.join(foreignCheckout, 'learnings'));
    // This project's own learnings stay.
    expect(paths.learningsDirs).toContain(path.join(businessRoot, '.teamai', 'learnings'));
  });

  it('leaves it out in user scope too, where the machine\'s own learnings stay (#823 item 16)', async () => {
    const home = path.join(testRoot, 'home');
    const realHome = process.env.HOME;
    process.env.HOME = home;
    const own = path.join(home, '.teamai', 'learnings');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'own-2026-01-01-aaaaaa.md'), '---\ntitle: Own learning\n---\n');

    // This machine's team repository, and another one whose checkout of
    // teamai-learnings sits where this team's would.
    const remote = path.join(testRoot, 'team.git');
    const seed = path.join(testRoot, 'seed');
    git(['init', '-q', '--bare', remote], testRoot);
    git(['init', '-q', '-b', 'main', seed], testRoot);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: t\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'init'], seed);
    git(['remote', 'add', 'origin', remote], seed);
    git(['push', '-q', 'origin', 'main'], seed);
    const dataHome = path.join(home, '.teamai');
    const teamClone = path.join(dataHome, 'team-repo');
    // `git init --bare` leaves HEAD on the runner's default branch. Coding CI's
    // git 2.39 defaults to master, so a plain clone has no commit at HEAD and
    // `worktree add` then dies with "invalid reference: HEAD". Check out main.
    git(['clone', '-q', '-b', 'main', remote, teamClone], testRoot);
    // The reports checkout commits in-process. A CI runner has no global identity.
    git(['config', 'user.email', 't@t.co'], teamClone);
    git(['config', 'user.name', 't'], teamClone);
    const otherSeed = path.join(testRoot, 'other-seed');
    git(['init', '-q', '-b', 'main', otherSeed], testRoot);
    fs.mkdirSync(path.join(otherSeed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(otherSeed, 'learnings', 'foreign-2026-01-01-bbbbbb.md'), '---\ntitle: Foreign learning\n---\n');
    git(['add', '-A'], otherSeed);
    git(['commit', '-q', '-m', 'learnings'], otherSeed);
    git(['branch', 'teamai-learnings'], otherSeed);
    const foreignCheckout = path.join(dataHome, 'learnings-wt');
    git(['worktree', 'add', '-q', foreignCheckout, 'teamai-learnings'], otherSeed);

    const config = {
      repo: { localPath: teamClone, kind: 'git' as const, remote },
      username: 'test',
      additionalRoles: [],
      scope: 'user' as const,
      dataHome,
    };

    try {
      const data = await buildVizData(await resolveVizRoot({ config }));
      const titles = [...data.topRecalled, ...data.silent].map((entry) => entry.title);
      expect(titles).toContain('Own learning');
      expect(titles).not.toContain('Foreign learning');
    } finally {
      process.env.HOME = realHome;
    }
  });
});
