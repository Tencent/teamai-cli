import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/** The team repo URL; git's insteadOf in the sandbox HOME points it at a local bare repo. */
const TEAM_URL = 'https://git.example.com/team/team.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

// Promotion used to publish only the learning's marker: the artifact stayed
// untracked in the member's checkout while the learning left the candidates.
describe('recall promote publishes the artifact before the marker', () => {
  let sandbox: string;
  let home: string;
  let project: string;
  let remote: string;
  let dashboard: ChildProcess | undefined;

  function cliEnv() {
    const env: Record<string, string | undefined> = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1',
      // An AI CLI that always fails: promotion falls back to the learning's own content.
      PATH: `${path.join(sandbox, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    return env;
  }

  function cli(args: string[]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project, env: cliEnv(), encoding: 'utf8', input: '', timeout: 30_000,
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  /** What the dashboard serves as its knowledge-base context. */
  async function dashboardContext(): Promise<unknown> {
    const server = net.createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error(`No TCP port to start the dashboard on: ${address}`);
    const { port } = address;
    await new Promise((resolve) => server.close(resolve));
    dashboard = spawn(process.execPath, [CLI, 'dashboard', '--port', String(port)], { cwd: project, env: cliEnv(), stdio: 'pipe' });
    let output = '';
    dashboard.stdout?.on('data', (chunk) => { output += chunk; });
    dashboard.stderr?.on('data', (chunk) => { output += chunk; });
    const deadline = Date.now() + 15_000;
    while (!output.includes('Dashboard running')) {
      if (dashboard.exitCode !== null || Date.now() > deadline) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/context`);
    expect(response.status).toBe(200);
    return response.json();
  }

  const git = (args: string[], cwd = remote) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const localPushBranches = () => git(['branch', '--list', 'teamai/push/*'], path.join(home, '.teamai', 'team-repo'));
  const remotePushBranches = () => git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/']).trim();
  const fetchedLearnings = () => git(['rev-parse', 'refs/remotes/origin/teamai-learnings'], path.join(home, '.teamai', 'team-repo')).trim();

  /** A live process other than the CLI holds the sync lock, as a running `teamai pull` does. */
  function holdSyncLock() {
    fs.writeFileSync(
      path.join(home, '.teamai', '.sync-lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'another-pull' }),
    );
  }

  function publishTeammateLearning() {
    const work = path.join(sandbox, 'teammate');
    const env = { ...process.env, ...GIT_ENV };
    execFileSync('git', ['clone', '-q', '-b', 'teamai-learnings', remote, work], { env });
    fs.writeFileSync(path.join(work, 'learnings', 'later.md'), '---\ntitle: later\n---\nA teammate learned this.\n');
    execFileSync('git', ['add', '-A'], { cwd: work, env });
    execFileSync('git', ['commit', '-qm', 'later'], { cwd: work, env });
    execFileSync('git', ['push', '-q', 'origin', 'teamai-learnings'], { cwd: work, env });
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-promote-publish-')));
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    remote = path.join(sandbox, 'team.git');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(sandbox, 'bin'));
    fs.writeFileSync(path.join(sandbox, 'bin', 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, ...GIT_ENV };
    const seed = path.join(sandbox, 'seed');
    const run = (args: string[]) => execFileSync('git', args, { cwd: seed, env });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), ['team: team', `repo: ${TEAM_URL}`, 'provider: git', ''].join('\n'));
    run(['add', '-A']);
    run(['commit', '-qm', 'team']);
    run(['push', '-q', remote, 'main']);

    // A learning old enough, and upvoted by enough members, to be promoted.
    run(['checkout', '-q', '--orphan', 'teamai-learnings']);
    run(['rm', '-rqf', '.']);
    fs.mkdirSync(path.join(seed, 'learnings'));
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(seed, 'learnings', 'ready.md'), `---\ntitle: ready\ndate: ${date}\n---\nHow to do it step by step.\n`);
    run(['add', '-A']);
    run(['commit', '-qm', 'learnings']);
    run(['push', '-q', remote, 'teamai-learnings']);
    run(['checkout', '-q', '--orphan', 'teamai-reports']);
    run(['rm', '-rqf', '.']);
    fs.mkdirSync(path.join(seed, 'votes'));
    const now = new Date().toISOString();
    for (const user of ['alice', 'bob', 'carol']) {
      fs.writeFileSync(path.join(seed, 'votes', `${user}.yaml`), [
        'version: 2',
        'votes:',
        `  ready: { recalled_count: 5, upvoted_count: 4, last_recalled_at: "${now}", last_upvoted_at: "${now}" }`,
        'deltas: {}',
        '',
      ].join('\n'));
    }
    run(['add', '-A']);
    run(['commit', '-qm', 'votes']);
    run(['push', '-q', remote, 'teamai-reports']);

    execFileSync('git', ['config', '--global', `url.${remote}.insteadOf`, TEAM_URL], { env: { ...env, HOME: home, USERPROFILE: home } });
    execFileSync('git', ['init', '-q', '-b', 'main', project], { env });
    const init = cli(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--force', '--scope', 'user']);
    expect(init.code, init.output).toBe(0);
  });

  afterEach(async () => {
    if (dashboard && dashboard.exitCode === null) {
      const exited = once(dashboard, 'exit');
      dashboard.kill('SIGTERM');
      await exited;
    }
    dashboard = undefined;
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('leaves the learning unmarked and eligible when the review branch is rejected', () => {
    fs.writeFileSync(
      path.join(remote, 'hooks', 'pre-receive'),
      '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/teamai/push/*) exit 1;; esac; done\n',
      { mode: 0o755 },
    );

    const result = cli(['recall', 'promote', 'ready', '--category', 'docs']);

    expect(result.code, result.output).toBe(1);
    expect(git(['show', 'teamai-learnings:learnings/ready.md'])).not.toContain('promoted_to');
    expect(remotePushBranches()).toBe('');
    expect(localPushBranches()).toBe('');
    expect(cli(['recall', 'promote']).output).toContain('- ready');
  });

  it('pushes the artifact on a review branch, then publishes the marker', () => {
    const result = cli(['recall', 'promote', 'ready', '--category', 'docs']);

    expect(result.code, result.output).toBe(0);
    const branch = remotePushBranches();
    expect(git(['diff', '--name-only', `main...${branch}`]).trim()).toBe('docs/ready.md');
    expect(git(['show', 'teamai-learnings:learnings/ready.md'])).toContain('promoted_to: docs/ready.md');
    expect(localPushBranches()).toBe('');
  });

  it('keeps the learning out of the candidates while its review branch is open', () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);

    expect(cli(['recall', 'promote']).output).not.toContain('- ready');
  });

  it('keeps the learning out once its review is merged and the branch deleted', () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);
    const branch = remotePushBranches();
    git(['update-ref', 'refs/heads/main', branch]);
    git(['branch', '-D', branch]);

    expect(cli(['recall', 'promote']).output).not.toContain('- ready');
  });

  it('keeps the learning out after the team renames its merged entry on main', () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);
    const branch = remotePushBranches();
    git(['update-ref', 'refs/heads/main', branch]);
    git(['branch', '-D', branch]);
    const work = path.join(sandbox, 'work');
    const env = { ...process.env, ...GIT_ENV };
    execFileSync('git', ['clone', '-q', remote, work], { env });
    execFileSync('git', ['mv', 'docs/ready.md', 'docs/ready-flow.md'], { cwd: work, env });
    execFileSync('git', ['commit', '-qm', 'rename'], { cwd: work, env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work, env });

    expect(cli(['recall', 'promote']).output).not.toContain('- ready');
  });

  it('offers the learning again once its review branch is deleted unmerged', () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);
    git(['branch', '-D', remotePushBranches()]);

    expect(cli(['recall', 'promote']).output).toContain('- ready');
    const again = cli(['recall', 'promote', 'ready', '--category', 'rules']);
    expect(again.code, again.output).toBe(0);
    expect(git(['show', 'teamai-learnings:learnings/ready.md'])).toContain('promoted_to: rules/ready.md');
  });

  it('counts the learning as a dashboard candidate once the listing offers it again', async () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);
    git(['branch', '-D', remotePushBranches()]);
    expect(cli(['recall', 'promote']).output).toContain('- ready');

    expect(await dashboardContext()).toMatchObject({ maintenanceCounts: { promote: 1 } });
  }, 60_000);

  it('lists from the last fetch while another sync holds the lock', () => {
    expect(cli(['recall', 'promote', 'ready', '--category', 'docs']).code).toBe(0);
    git(['branch', '-D', remotePushBranches()]);
    holdSyncLock();

    const listing = cli(['recall', 'promote']);

    expect(listing.code, listing.output).toBe(0);
    expect(listing.output).toContain('Another teamai pull/push is in progress');
    expect(listing.output).not.toContain('- ready');
  });

  it('lists from the learnings as last fetched while another sync holds the lock', () => {
    expect(cli(['recall', 'promote']).output).toContain('- ready');
    const fetched = fetchedLearnings();
    publishTeammateLearning();
    holdSyncLock();

    const listing = cli(['recall', 'promote']);

    expect(listing.code, listing.output).toBe(0);
    expect(listing.output).toContain('Another teamai pull/push is in progress');
    expect(listing.output).toContain('- ready');
    expect(fetchedLearnings()).toBe(fetched);
  });

  it('stops recall maintenance before it fetches while another sync holds the lock', () => {
    expect(cli(['recall', 'promote']).output).toContain('- ready');
    const fetched = fetchedLearnings();
    publishTeammateLearning();
    holdSyncLock();

    const maintenance = cli(['recall', 'maintenance', '--confidence-writeback']);

    expect(maintenance.code, maintenance.output).toBe(1);
    expect(maintenance.output).toContain('Another teamai pull/push is in progress');
    expect(fetchedLearnings()).toBe(fetched);
    expect(git(['show', 'teamai-learnings:learnings/ready.md'])).not.toContain('confidence');
  });
});
