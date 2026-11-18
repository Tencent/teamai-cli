/**
 * `teamai push` against a Gerrit review host, end to end with the built CLI
 * and real git remotes.
 *
 * Gerrit turns a push of a commit to `refs/for/<branch>` into a review
 * (Change) and keeps no branch of ours on the server. These tests drive
 * `dist/index.js` against a local bare remote whose origin URL is a Gerrit
 * host and whose `insteadOf` maps the transport locally, so teamai sees a
 * Gerrit origin while git stays offline. A post-receive hook records each
 * pushed ref and deletes the `refs/for` ref, the way Gerrit does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const GERRIT_REPO_URL = 'ssh://author@gerrit.example.com:29418/team/gerrit-repo.git';

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

interface GerritFixture {
  sandbox: string;
  home: string;
  projectRoot: string;
  remote: string;
  teamRepo: string;
  log: string;
}

function makeGerritFixture(): GerritFixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gerrit-e2e-'));
  const home = path.join(sandbox, 'home');
  const projectRoot = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team.git');
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
  const log = path.join(sandbox, 'received.log');
  const fileRemote = `file:///${remote.split(path.sep).join('/').replace(/^\/+/, '')}`;

  fs.mkdirSync(home, { recursive: true });
  for (const dir of ['skills', 'rules', 'agents']) {
    fs.mkdirSync(path.join(projectRoot, `.claude/${dir}`), { recursive: true });
    fs.mkdirSync(path.join(seed, dir), { recursive: true });
    fs.writeFileSync(path.join(seed, dir, '.gitkeep'), '');
  }
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
    'team: gerrit-e2e',
    `repo: ${GERRIT_REPO_URL}`,
    'provider: git',
    'reviewers: []',
    'toolPaths:',
    '  claude:',
    '    skills: .claude/skills',
    '    rules: .claude/rules',
    '    agents: .claude/agents',
  ].join('\n'));

  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['clone', '-q', remote, teamRepo], sandbox);
  git(['remote', 'set-url', 'origin', GERRIT_REPO_URL], teamRepo);
  git(['config', `url.${fileRemote}.insteadOf`, GERRIT_REPO_URL], teamRepo);

  // Gerrit keeps no `refs/for` ref: record what arrived and drop it again.
  const logPath = log.split(path.sep).join('/');
  fs.writeFileSync(path.join(remote, 'hooks', 'post-receive'), [
    '#!/bin/sh',
    'while read old new ref; do',
    `  echo "$ref $new" >> "${logPath}"`,
    '  case "$ref" in',
    '    refs/for/*) git update-ref -d "$ref" ;;',
    '  esac',
    'done',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(remote, 'hooks', 'post-receive'), 0o755);

  fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${teamRepo}`,
    `  remote: ${GERRIT_REPO_URL}`,
    'username: author-gerrit',
    'updatePolicy: auto',
    'additionalRoles: []',
    'scope: project',
    `projectRoot: ${projectRoot}`,
  ].join('\n'));

  return { sandbox, home, projectRoot, remote, teamRepo, log };
}

function writeRule(fixture: GerritFixture, name: string, body: string): void {
  fs.writeFileSync(path.join(fixture.projectRoot, '.claude/rules', name), body);
}

/** Refs the bare remote accepted, in order, from the post-receive log. */
function received(fixture: GerritFixture): string[] {
  if (!fs.existsSync(fixture.log)) return [];

  return fs.readFileSync(fixture.log, 'utf8').split('\n').filter(Boolean);
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
  }
});

function track(fixture: GerritFixture): GerritFixture {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  cleanups.push(fixture.sandbox);

  return fixture;
}

describe('teamai push on a Gerrit remote (refs/for review)', () => {
  it('pushes to refs/for/<default>, creates no branch, and records the review', async () => {
    const fixture = track(makeGerritFixture());
    writeRule(fixture, 'my-rule.md', '# Rule v1\n');

    const first = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(first.code, first.output).toBe(0);
    expect(first.output, first.output).toContain('Pushed to Gerrit review (refs/for)');
    expect(first.output).not.toContain('Pull Request created');
    expect(first.output).not.toContain('pr-failed');

    const accepted = received(fixture);
    expect(accepted, first.output).toHaveLength(1);
    expect(accepted[0]).toMatch(/^refs\/for\/main [0-9a-f]{40}$/);
    // The commit carries the Change-Id Gerrit needs to track the review.
    const sha = accepted[0]!.split(' ')[1]!;
    expect(git(['log', '-1', '--format=%B', sha], fixture.remote)).toContain('Change-Id: I');

    const state = JSON.parse(fs.readFileSync(path.join(fixture.projectRoot, '.teamai', 'state.json'), 'utf8'));
    expect(state.pendingPushes).toHaveLength(1);
    expect(state.pendingPushes[0].prUrl).toBeNull();

    // A Gerrit review publishes no branch of ours, so the clone keeps only the
    // default one.
    const branches = git(['branch', '--format=%(refname:short)'], fixture.teamRepo).split('\n').filter(Boolean);
    expect(branches).toEqual(['main']);
  }, 90_000);

  it('does not open a second Change for the same resources', async () => {
    const fixture = track(makeGerritFixture());
    writeRule(fixture, 'my-rule.md', '# Rule v1\n');

    await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
    const second = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(second.code, second.output).toBe(0);
    expect(second.output, second.output).not.toContain('Pushed to Gerrit review');
    expect(second.output, second.output).not.toContain('retrying PR creation');
    expect(received(fixture), second.output).toHaveLength(1);
  }, 90_000);

  it('retries a resource whose review push failed', async () => {
    const fixture = track(makeGerritFixture());
    writeRule(fixture, 'my-rule.md', '# Rule v1\n');
    await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    const reject = path.join(fixture.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(reject, '#!/bin/sh\necho "rejected by test" >&2\nexit 1\n');
    fs.chmodSync(reject, 0o755);
    writeRule(fixture, 'my-rule2.md', '# Rule two\n');
    const failed = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);
    expect(failed.code, failed.output).toBe(1);
    expect(received(fixture)).toHaveLength(1);

    fs.rmSync(reject, { force: true });
    const retried = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(retried.code, retried.output).toBe(0);
    expect(retried.output, retried.output).toContain('Pushed to Gerrit review');
    const accepted = received(fixture);
    expect(accepted, retried.output).toHaveLength(2);
    expect(accepted[1]).toMatch(/^refs\/for\/main [0-9a-f]{40}$/);
    const sha = accepted[1]!.split(' ')[1]!;
    expect(git(['show', `${sha}:rules/my-rule2.md`], fixture.remote)).toContain('Rule two');
  }, 120_000);

  it('pushes a teamai.yaml-only change without a pull request', async () => {
    const fixture = track(makeGerritFixture());
    const yamlPath = path.join(fixture.teamRepo, 'teamai.yaml');
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, 'utf8').replace('team: gerrit-e2e', 'team: gerrit-renamed'));

    const result = await runCLI(['push', '--all'], fixture.projectRoot, fixture.home);

    expect(result.code, result.output).toBe(0);
    expect(result.output, result.output).toContain('Pushed to Gerrit review (refs/for)');
    expect(received(fixture), result.output).toHaveLength(1);
  }, 90_000);
});
