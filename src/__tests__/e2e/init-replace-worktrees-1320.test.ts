import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const URL_A = 'https://git.example.test/team/a.git';
const URL_B = 'https://git.example.test/team/b.git';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function makeRemote(sandbox: string, name: string, url: string): string {
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`,
    `repo: ${url}`,
    'provider: git',
    'reviewers: []',
    '',
  ].join('\n'));
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  return remote;
}

function runCLI(args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
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

describe('init replaces a clone without orphaning its side worktrees (#1320)', () => {
  let sandbox: string;
  let home: string;
  let cwd: string;
  let remoteA: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-replace-'));
    home = path.join(sandbox, 'home');
    cwd = path.join(sandbox, 'cwd');
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(home, '.claude'));
    remoteA = makeRemote(sandbox, 'a', URL_A);
    const remoteB = makeRemote(sandbox, 'b', URL_B);
    git(['config', '--global', `url.${remoteA}.insteadOf`, URL_A], sandbox, home);
    git(['config', '--global', `url.${remoteB}.insteadOf`, URL_B], sandbox, home);
  });

  afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('pushes and removes the old worktrees before --force clones the new repo', async () => {
    const first = await runCLI(['init', URL_A, '--provider', 'git', '--scope', 'user', '--agent', 'claude', '--force'], cwd, home);
    expect(first.code, first.output).toBe(0);

    const clone = path.join(home, '.teamai', 'team-repo');
    const other = path.join(sandbox, 'other-member');
    git(['clone', '-q', '-b', 'teamai-reports', remoteA, other], sandbox);
    fs.writeFileSync(path.join(other, 'published-report.txt'), 'already preserved\n');
    git(['add', 'published-report.txt'], other);
    git(['commit', '-qm', 'publish report'], other);
    git(['push', '-q', 'origin', 'teamai-reports'], other);
    const reportsRemoteHead = git(['rev-parse', 'refs/heads/teamai-reports'], remoteA);

    const learnings = path.join(home, '.teamai', 'learnings-wt');
    git(['branch', 'teamai-learnings'], clone);
    git(['worktree', 'add', '-q', learnings, 'teamai-learnings'], clone);
    fs.writeFileSync(path.join(learnings, 'pending.md'), 'preserve me\n');
    git(['add', 'pending.md'], learnings);
    git(['commit', '-qm', 'pending learning'], learnings);

    const second = await runCLI(['init', URL_B, '--provider', 'git', '--scope', 'user', '--agent', 'claude', '--force'], cwd, home);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('Retired teamai-learnings checkout');
    expect(second.output).toMatch(/teamai initialized successfully/i);
    expect(git(['remote', 'get-url', 'origin'], clone)).toContain('b.git');
    expect(git(['rev-parse', 'refs/heads/teamai-reports'], remoteA)).toBe(reportsRemoteHead);
    expect(fs.existsSync(learnings)).toBe(false);
  }, 120_000);

  it('keeps the backing clone when a side checkout has uncommitted work', async () => {
    const dirtyHome = path.join(sandbox, 'dirty-home');
    fs.mkdirSync(dirtyHome);
    fs.mkdirSync(path.join(dirtyHome, '.claude'));
    git(['config', '--global', `url.${remoteA}.insteadOf`, URL_A], sandbox, dirtyHome);
    const remoteB = path.join(sandbox, 'b.git');
    git(['config', '--global', `url.${remoteB}.insteadOf`, URL_B], sandbox, dirtyHome);

    const first = await runCLI(['init', URL_A, '--provider', 'git', '--scope', 'user', '--agent', 'claude', '--force'], cwd, dirtyHome);
    expect(first.code, first.output).toBe(0);

    const clone = path.join(dirtyHome, '.teamai', 'team-repo');
    const learnings = path.join(dirtyHome, '.teamai', 'learnings-wt');
    git(['branch', 'teamai-learnings'], clone);
    git(['worktree', 'add', '-q', learnings, 'teamai-learnings'], clone);
    fs.writeFileSync(path.join(learnings, 'committed.md'), 'unpushed commit\n');
    git(['add', 'committed.md'], learnings);
    git(['commit', '-qm', 'local learning'], learnings);
    const localHead = git(['rev-parse', 'HEAD'], learnings);
    fs.writeFileSync(path.join(learnings, 'dirty.md'), 'uncommitted work\n');

    const second = await runCLI(['init', URL_B, '--provider', 'git', '--scope', 'user', '--agent', 'claude', '--force'], cwd, dirtyHome);

    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('Kept the old clone and its uncommitted side checkout(s)');
    expect(git(['remote', 'get-url', 'origin'], clone)).toContain('b.git');
    expect(fs.existsSync(path.join(clone + '.previous', '.git'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], learnings)).toBe(localHead);
    expect(git(['status', '--porcelain'], learnings)).toContain('?? dirty.md');
  }, 120_000);
});
