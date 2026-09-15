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
import { commitAndPushReports, ensureReportsWorktree, refreshReportsWorktree } from '../utils/reports-branch.js';
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

function gitConfig(clone: string, origin: string, username = 'alice'): LocalConfig {
  return {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username,
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

const READ_ONLY = { pushIfCreated: false } as const;

/** Another independent checkout of the same team repo (a second member or machine). */
async function cloneCheckout(origin: string, name: string, username = 'alice'): Promise<LocalConfig> {
  const clone = path.join(tmp, name, 'team-repo');
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  await simpleGit().clone(origin, clone);
  await configureGit(clone);
  return gitConfig(clone, origin, username);
}

/** Write one report file into the reports worktree and publish it. */
async function publish(cfg: LocalConfig, relPath: string, content: string): Promise<boolean> {
  const wt = await ensureReportsWorktree(cfg);
  fs.mkdirSync(path.dirname(path.join(wt, relPath)), { recursive: true });
  fs.writeFileSync(path.join(wt, relPath), content);
  return commitAndPushReports(cfg, `[teamai] Update ${relPath}`, [relPath]);
}

async function originReportsFile(origin: string, relPath: string): Promise<string> {
  return simpleGit(origin).show([`teamai-reports:${relPath}`]);
}

async function originHasReportsBranch(origin: string): Promise<boolean> {
  const heads = await simpleGit(origin).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return heads.split('\n').includes('teamai-reports');
}

describe('git-kind reports: read-only cold start (#558)', () => {
  it('materializes a local reports view without publishing the branch', async () => {
    const { origin, clone } = await seedBareOrigin();
    const cfg = gitConfig(clone, origin);

    await refreshReportsWorktree(cfg, READ_ONLY);
    const wt = await ensureReportsWorktree(cfg, READ_ONLY);

    expect(fs.existsSync(path.join(wt, '.gitignore'))).toBe(true);
    expect(await originHasReportsBranch(origin)).toBe(false);
  });

  it('reuses the unpublished local branch after its worktree is removed, and a writer publishes it', async () => {
    const { origin, clone } = await seedBareOrigin();
    const cfg = gitConfig(clone, origin);

    const wt = await ensureReportsWorktree(cfg, READ_ONLY);
    fs.rmSync(wt, { recursive: true, force: true });

    await expect(ensureReportsWorktree(cfg, READ_ONLY)).resolves.toBe(wt);
    expect(await originHasReportsBranch(origin)).toBe(false);

    expect(await publish(cfg, 'members/alice.yaml', 'username: alice\n')).toBe(true);
    expect(await originReportsFile(origin, 'members/alice.yaml')).toBe('username: alice\n');
  });
});

describe('git-kind reports: refresh before reading (#557)', () => {
  it('picks up report data another member pushed', async () => {
    const { origin, clone } = await seedBareOrigin();
    const alice = gitConfig(clone, origin);
    expect(await publish(alice, 'members/alice.yaml', 'username: alice\n')).toBe(true);

    const bob = await cloneCheckout(origin, 'bob', 'bob');
    expect(await publish(bob, 'votes/bob.yaml', 'version: 2\n')).toBe(true);

    const wt = await ensureReportsWorktree(alice, READ_ONLY);
    expect(fs.existsSync(path.join(wt, 'votes', 'bob.yaml'))).toBe(false);

    await refreshReportsWorktree(alice, READ_ONLY);
    expect(fs.readFileSync(path.join(wt, 'votes', 'bob.yaml'), 'utf-8')).toBe('version: 2\n');
  });

  it('keeps an unpushed report commit that rebases cleanly, so the next push delivers it', async () => {
    const { origin, clone } = await seedBareOrigin();
    const alice = gitConfig(clone, origin);
    const wt = await ensureReportsWorktree(alice);

    // A report committed while the push failed (e.g. offline).
    fs.mkdirSync(path.join(wt, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'stats', 'alice.yaml'), 'n: 1\n');
    const wtGit = simpleGit(wt);
    await wtGit.add(['stats/alice.yaml']);
    await wtGit.commit('offline stats');

    const bob = await cloneCheckout(origin, 'bob', 'bob');
    expect(await publish(bob, 'votes/bob.yaml', 'version: 2\n')).toBe(true);

    await refreshReportsWorktree(alice, READ_ONLY);
    expect(fs.existsSync(path.join(wt, 'votes', 'bob.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'stats', 'alice.yaml'), 'utf-8')).toBe('n: 1\n');

    expect(await publish(alice, 'members/alice.yaml', 'username: alice\n')).toBe(true);
    expect(await originReportsFile(origin, 'stats/alice.yaml')).toBe('n: 1\n');
    expect(await originReportsFile(origin, 'votes/bob.yaml')).toBe('version: 2\n');
  });

  it('keeps uncommitted report files while updating to origin', async () => {
    const { origin, clone } = await seedBareOrigin();
    const alice = gitConfig(clone, origin);
    const wt = await ensureReportsWorktree(alice);

    // A writer has written its file but not committed it yet.
    fs.mkdirSync(path.join(wt, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'stats', 'alice.yaml'), 'n: 1\n');

    const bob = await cloneCheckout(origin, 'bob', 'bob');
    expect(await publish(bob, 'votes/bob.yaml', 'version: 2\n')).toBe(true);

    await refreshReportsWorktree(alice, READ_ONLY);
    expect(fs.existsSync(path.join(wt, 'votes', 'bob.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'stats', 'alice.yaml'), 'utf-8')).toBe('n: 1\n');

    expect(await commitAndPushReports(alice, '[teamai] Update usage stats for alice', ['stats/alice.yaml'])).toBe(true);
    expect(await originReportsFile(origin, 'stats/alice.yaml')).toBe('n: 1\n');
  });

  it('does not leave autostash conflict markers when an unpushed commit, a dirty report, and origin all touch the same file', async () => {
    const { origin, clone } = await seedBareOrigin();
    const machineA = gitConfig(clone, origin);
    const machineB = await cloneCheckout(origin, 'machine-b');

    expect(await publish(machineA, 'stats/alice.yaml', 'n: 1\n')).toBe(true);
    const wtA = await ensureReportsWorktree(machineA);

    // Unpushed local commit (e.g. a session report written while offline).
    fs.mkdirSync(path.join(wtA, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(wtA, 'sessions', 'alice.yaml'), 'session: a1\n');
    const wtGit = simpleGit(wtA);
    await wtGit.add(['sessions/alice.yaml']);
    await wtGit.commit('offline session');

    // Dirty tracked stats, plus a newer copy of the same file on origin.
    fs.writeFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'n: 3\n');
    expect(await publish(machineB, 'stats/alice.yaml', 'n: 2\n')).toBe(true);

    await refreshReportsWorktree(machineA, READ_ONLY);

    const stats = fs.readFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'utf-8');
    expect(stats).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(stats).toBe('n: 3\n');
    expect(fs.readFileSync(path.join(wtA, 'sessions', 'alice.yaml'), 'utf-8')).toBe('session: a1\n');

    const status = await wtGit.status();
    expect(status.conflicted).toEqual([]);
    expect((await wtGit.raw(['stash', 'list'])).trim()).toBe('');
  });

  it('drops an unpushed commit that conflicts with newer origin data so the checkout never stays diverged', async () => {
    const { origin, clone } = await seedBareOrigin();
    const machineA = gitConfig(clone, origin);
    const machineB = await cloneCheckout(origin, 'machine-b');

    expect(await publish(machineA, 'stats/alice.yaml', 'n: 1\n')).toBe(true);
    const wtB = await ensureReportsWorktree(machineB);

    // Machine B commits a merge from its stale copy but never pushes it...
    fs.writeFileSync(path.join(wtB, 'stats', 'alice.yaml'), 'n: 100\n');
    const wtGit = simpleGit(wtB);
    await wtGit.add(['stats/alice.yaml']);
    await wtGit.commit('stale stats');
    // ...while machine A publishes a newer copy of the same file.
    expect(await publish(machineA, 'stats/alice.yaml', 'n: 2\n')).toBe(true);

    await refreshReportsWorktree(machineB, READ_ONLY);
    expect(fs.readFileSync(path.join(wtB, 'stats', 'alice.yaml'), 'utf-8')).toBe('n: 2\n');
    const ahead = await wtGit.raw(['rev-list', '--count', 'origin/teamai-reports..HEAD']);
    expect(ahead.trim()).toBe('0');

    expect(await publish(machineB, 'members/alice.yaml', 'username: alice\n')).toBe(true);
    expect(await originReportsFile(origin, 'members/alice.yaml')).toBe('username: alice\n');
  });
});

describe('self-mode reports: shared stash', () => {
  it('does not drop a pre-existing business-worktree stash whose message contains autostash', async () => {
    const { origin, clone } = await seedBareOrigin();
    const teamaiDir = path.join(clone, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    const alice: LocalConfig = {
      repo: { localPath: teamaiDir, remote: origin, kind: 'self', businessRepoRoot: clone },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };
    const machineB = await cloneCheckout(origin, 'machine-b');

    expect(await publish(alice, 'stats/alice.yaml', 'n: 1\n')).toBe(true);
    const wtA = await ensureReportsWorktree(alice);

    fs.mkdirSync(path.join(wtA, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(wtA, 'sessions', 'alice.yaml'), 'session: a1\n');
    const wtGit = simpleGit(wtA);
    await wtGit.add(['sessions/alice.yaml']);
    await wtGit.commit('offline session');

    const businessGit = simpleGit(clone);
    fs.writeFileSync(path.join(clone, 'app.txt'), 'committed\n');
    await businessGit.add(['app.txt']);
    await businessGit.commit('app');
    fs.writeFileSync(path.join(clone, 'app.txt'), 'wip\n');
    await businessGit.stash(['push', '-m', 'autostash']);
    const stashBefore = (await businessGit.raw(['stash', 'list'])).trim();
    expect(stashBefore).toMatch(/autostash/);

    fs.writeFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'n: 3\n');
    expect(await publish(machineB, 'stats/alice.yaml', 'n: 2\n')).toBe(true);

    await refreshReportsWorktree(alice, READ_ONLY);

    const stats = fs.readFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'utf-8');
    expect(stats).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(stats).toBe('n: 3\n');
    expect((await wtGit.status()).conflicted).toEqual([]);

    const stashAfter = (await businessGit.raw(['stash', 'list'])).trim();
    expect(stashAfter).toBe(stashBefore);
    expect(fs.readFileSync(path.join(clone, 'app.txt'), 'utf-8')).toBe('committed\n');
  });

  it('does not drop a business-worktree stash created while reports rebase is running', async () => {
    const { origin, clone } = await seedBareOrigin();
    const teamaiDir = path.join(clone, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    const alice: LocalConfig = {
      repo: { localPath: teamaiDir, remote: origin, kind: 'self', businessRepoRoot: clone },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };
    const machineB = await cloneCheckout(origin, 'machine-b');

    expect(await publish(alice, 'stats/alice.yaml', 'n: 1\n')).toBe(true);
    const wtA = await ensureReportsWorktree(alice);

    fs.mkdirSync(path.join(wtA, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(wtA, 'sessions', 'alice.yaml'), 'session: a1\n');
    const wtGit = simpleGit(wtA);
    await wtGit.add(['sessions/alice.yaml']);
    await wtGit.commit('offline session');

    const businessGit = simpleGit(clone);
    fs.writeFileSync(path.join(clone, 'app.txt'), 'committed\n');
    await businessGit.add(['app.txt']);
    await businessGit.commit('app');

    const marker = path.join(tmp, 'rebase-started');
    const release = path.join(tmp, 'rebase-continue');
    const hookDir = path.join(clone, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, 'pre-rebase'),
      `#!/bin/sh\nprintf 'ready\\n' > ${JSON.stringify(marker)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\n`,
    );
    fs.chmodSync(path.join(hookDir, 'pre-rebase'), 0o755);

    fs.writeFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'n: 3\n');
    expect(await publish(machineB, 'stats/alice.yaml', 'n: 2\n')).toBe(true);

    const refreshing = refreshReportsWorktree(alice, READ_ONLY);
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.existsSync(marker)).toBe(true);

    fs.writeFileSync(path.join(clone, 'app.txt'), 'wip-during-rebase\n');
    await businessGit.stash(['push', '-m', 'business-wip']);
    const stashDuring = (await businessGit.raw(['stash', 'list'])).trim();
    expect(stashDuring).toMatch(/business-wip/);

    fs.writeFileSync(release, 'go\n');
    await refreshing;

    const stats = fs.readFileSync(path.join(wtA, 'stats', 'alice.yaml'), 'utf-8');
    expect(stats).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(stats).toBe('n: 3\n');
    expect((await wtGit.status()).conflicted).toEqual([]);
    expect((await businessGit.raw(['stash', 'list'])).trim()).toBe(stashDuring);
    expect(fs.readFileSync(path.join(clone, 'app.txt'), 'utf-8')).toBe('committed\n');
  });
});
