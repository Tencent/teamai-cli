/**
 * Real-git coverage for independent clones writing reports to teamai-reports.
 * No mocks of the units under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { getReportsDir, REPORTS_WORKTREE_DIRNAME, type LocalConfig } from '../types.js';
import { commitAndPushReports, ensureReportsWorktree } from '../utils/reports-branch.js';
import { pushRepoDirectly } from '../utils/git.js';
import { reportUsageToTeam } from '../team-push.js';

let tmp: string;
let originalHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-reports-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function configureGit(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig('user.email', 't@t.com');
  await git.addConfig('user.name', 't');
}

async function seedBareOrigin(): Promise<{ origin: string; clone: string }> {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await configureGit(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  fs.mkdirSync(path.join(seed, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'skills', '.gitkeep'), '');
  await seedGit.add(['.']);
  await seedGit.commit('init knowledge');

  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const hook = path.join(origin, 'hooks', 'update');
  fs.writeFileSync(
    hook,
    `#!/bin/sh
ref="$1"
if [ "$ref" = "refs/heads/main" ] || [ "$ref" = "refs/heads/master" ]; then
  echo "default branch is protected" >&2
  exit 1
fi
exit 0
`,
  );
  fs.chmodSync(hook, 0o755);

  const clone = path.join(tmp, 'team-repo');
  await simpleGit().clone(origin, clone);
  await configureGit(clone);
  return { origin, clone };
}

function gitConfig(clone: string, origin: string): LocalConfig {
  return {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'alice',
    scope: 'user',
    additionalRoles: [],
  };
}

describe('git-kind reports branch', () => {
  it('places the reports dir as a sibling of the clone', () => {
    const clone = '/home/alice/.teamai/team-repo';
    const cfg = gitConfig(clone, 'https://example.com/team.git');
    expect(getReportsDir(cfg)).toBe(path.join('/home/alice/.teamai', REPORTS_WORKTREE_DIRNAME));
    expect(getReportsDir(cfg)).not.toContain(`${path.sep}team-repo${path.sep}`);
  });

  it('publishes member + stats files on origin/teamai-reports, not on main', async () => {
    const { origin, clone } = await seedBareOrigin();
    const cfg = gitConfig(clone, origin);

    const wt = await ensureReportsWorktree(cfg);
    expect(wt).toBe(path.join(tmp, REPORTS_WORKTREE_DIRNAME));
    expect(path.dirname(wt)).toBe(path.dirname(clone));

    const memberDir = path.join(wt, 'members');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'alice.yaml'), 'username: alice\n');
    const pushed = await commitAndPushReports(cfg, '[teamai] Register member: alice', ['members/']);
    expect(pushed).toBe(true);

    const ts = new Date().toISOString();
    const eventsDir = path.join(process.env.HOME!, '.teamai', 'dashboard');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(
      path.join(eventsDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' })}\n` +
      `${JSON.stringify({ type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', interventions: { interrupt: 1, toolReject: 0 } })}\n`,
    );
    await reportUsageToTeam(clone, 'alice', { skipTruncate: true, selfConfig: cfg });

    const originGit = simpleGit(origin);
    const reportsTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'teamai-reports']);
    expect(reportsTree).toContain('members/alice.yaml');
    expect(reportsTree).toContain('stats/alice.yaml');

    const mainTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'main']);
    expect(mainTree).not.toContain('members/alice.yaml');
    expect(mainTree).not.toContain('stats/alice.yaml');
    expect(mainTree).toContain('teamai.yaml');

    expect(fs.existsSync(path.join(clone, 'members', 'alice.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(clone, 'stats', 'alice.yaml'))).toBe(false);
  });

  it('ignores leftover default-branch members after the switch and does not copy or delete them', async () => {
    const { origin, clone } = await seedBareOrigin();
    const leftover = path.join(clone, 'members', 'stale.yaml');
    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    fs.writeFileSync(leftover, 'username: stale\n');

    const cfg = gitConfig(clone, origin);
    const wt = await ensureReportsWorktree(cfg);
    fs.mkdirSync(path.join(wt, 'members'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'members', 'alice.yaml'), 'username: alice\n');
    await commitAndPushReports(cfg, '[teamai] Register member: alice', ['members/']);

    expect(fs.readFileSync(leftover, 'utf-8')).toContain('username: stale');
    expect(fs.existsSync(path.join(wt, 'members', 'stale.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'members', 'alice.yaml'), 'utf-8')).toContain('username: alice');

    const originGit = simpleGit(origin);
    const reportsTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'teamai-reports']);
    expect(reportsTree).toContain('members/alice.yaml');
    expect(reportsTree).not.toContain('members/stale.yaml');
  });

  it('still allows an empty-repo skeleton push to the default branch, separate from members', async () => {
    const origin = path.join(tmp, 'empty.git');
    await simpleGit().init(['--bare', '--initial-branch=main', origin]);

    const clone = path.join(tmp, 'team-repo');
    fs.mkdirSync(clone, { recursive: true });
    const git = simpleGit(clone);
    await git.init(['--initial-branch=main']);
    await configureGit(clone);
    await git.addRemote('origin', origin);

    fs.writeFileSync(path.join(clone, 'teamai.yaml'), 'team: acme\n');
    for (const dir of ['skills', 'rules', 'docs', 'env', 'members']) {
      fs.mkdirSync(path.join(clone, dir), { recursive: true });
      fs.writeFileSync(path.join(clone, dir, '.gitkeep'), '');
    }
    await pushRepoDirectly(clone, '[teamai] Initialize team repo skeleton', [
      'teamai.yaml',
      'skills/.gitkeep',
      'rules/.gitkeep',
      'docs/.gitkeep',
      'env/.gitkeep',
      'members/.gitkeep',
    ]);

    const cfg = gitConfig(clone, origin);
    const wt = await ensureReportsWorktree(cfg);
    fs.mkdirSync(path.join(wt, 'members'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'members', 'alice.yaml'), 'username: alice\n');
    const pushed = await commitAndPushReports(cfg, '[teamai] Register member: alice', ['members/']);
    expect(pushed).toBe(true);

    const originGit = simpleGit(origin);
    const mainTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'main']);
    expect(mainTree).toContain('teamai.yaml');
    expect(mainTree).toContain('skills/.gitkeep');
    expect(mainTree).not.toContain('members/alice.yaml');

    const reportsTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'teamai-reports']);
    expect(reportsTree).toContain('members/alice.yaml');
  });

  it('refuses to create a reports worktree on a non-clone path inside a business repo', async () => {
    const business = path.join(tmp, 'business');
    fs.mkdirSync(business, { recursive: true });
    const git = simpleGit(business);
    await git.init(['--initial-branch=main']);
    await configureGit(business);
    fs.writeFileSync(path.join(business, 'app.js'), 'console.log(1)\n');
    await git.add('.');
    await git.commit('init');

    const nested = path.join(business, '.teamai', 'team-repo');
    fs.mkdirSync(nested, { recursive: true });
    const cfg = gitConfig(nested, 'https://example.com/team.git');

    await expect(ensureReportsWorktree(cfg)).rejects.toThrow(/not a dedicated team-repo clone root/);
    const logBefore = await git.log();
    expect(fs.existsSync(path.join(path.dirname(nested), REPORTS_WORKTREE_DIRNAME))).toBe(false);
    const logAfter = await git.log();
    expect(logAfter.total).toBe(logBefore.total);
  });

  it('rebuilds a dangling sibling reports worktree after the clone is removed and re-cloned', async () => {
    const { origin, clone } = await seedBareOrigin();
    const cfg = gitConfig(clone, origin);

    const wt = await ensureReportsWorktree(cfg);
    fs.mkdirSync(path.join(wt, 'members'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'members', 'alice.yaml'), 'username: alice\n');
    expect(await commitAndPushReports(cfg, '[teamai] Register member: alice', ['members/'])).toBe(true);

    fs.rmSync(clone, { recursive: true, force: true });
    await simpleGit().clone(origin, clone);
    await configureGit(clone);

    // The sibling husk is still on disk; isGitRepo would return true, but the
    // gitdir under the old clone is gone. ensureReportsWorktree must recreate.
    expect(fs.existsSync(wt)).toBe(true);
    const rebuilt = await ensureReportsWorktree(cfg);
    expect(rebuilt).toBe(wt);

    fs.mkdirSync(path.join(wt, 'members'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'members', 'bob.yaml'), 'username: bob\n');
    expect(await commitAndPushReports(cfg, '[teamai] Register member: bob', ['members/'])).toBe(true);

    const originGit = simpleGit(origin);
    const reportsTree = await originGit.raw(['ls-tree', '-r', '--name-only', 'teamai-reports']);
    expect(reportsTree).toContain('members/alice.yaml');
    expect(reportsTree).toContain('members/bob.yaml');
  });
});
