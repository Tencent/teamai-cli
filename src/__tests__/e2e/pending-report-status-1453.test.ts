/**
 * E2E (#1453): a failed auto-report push stays invisible today. `pull` keeps
 * the usage local and exits 0, and `status` has no line for it, so events can
 * sit for days without a signal.
 *
 * This drives the real CLI: a self-mode team whose origin rejects pushes, one
 * usage event, `pull`, then `status`. After the origin accepts pushes again the
 * next `pull` publishes and `status` drops the line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

const sandboxes: string[] = [];

function setUpProject(): { sandbox: string; home: string; remote: string; projectRoot: string } {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue1453-e2e-')));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'origin.git');
  const projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${GIT_ENV.GIT_AUTHOR_NAME}\n\temail = ${GIT_ENV.GIT_AUTHOR_EMAIL}\n`);

  git(['init', '-q', '--bare', remote], sandbox);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  const knowledge = path.join(projectRoot, '.teamai');
  fs.mkdirSync(path.join(knowledge, 'skills', 'tdd'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'skills', 'tdd', 'SKILL.md'), '# tdd\n');
  fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), [
    'team: issue-1453-e2e',
    'mode: self',
    'repo: https://git.example.com/team/project.git',
    'provider: git',
    'usageReport: true',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(knowledge, '.gitignore'), 'config.yaml\nstate.json\n');
  git(['init', '-q', '-b', 'main'], projectRoot);
  git(['add', '-A'], projectRoot);
  git(['commit', '-qm', 'project'], projectRoot);
  git(['remote', 'add', 'origin', remote], projectRoot);
  git(['push', '-q', '-u', 'origin', 'main'], projectRoot);

  fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${projectRoot}`,
    'username: ci-1453',
    'updatePolicy: skip',
    'scope: project',
    `projectRoot: ${projectRoot}`,
    '',
  ].join('\n'));
  return { sandbox, home, remote, projectRoot };
}

/** The project partition: exactly one exists under the sandbox HOME. */
function partitionOf(home: string): string {
  const projects = path.join(home, '.teamai', 'projects');
  const [partition] = fs.readdirSync(projects);
  return path.join(projects, partition);
}

/** Reject every push to origin while `fn` runs. */
async function withPushesRejected<T>(remote: string, fn: () => Promise<T>): Promise<T> {
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by the #1453 test" >&2\nexit 1\n', { mode: 0o755 });
  try {
    return await fn();
  } finally {
    fs.rmSync(hook, { force: true });
  }
}

describe('pending auto-report in status (#1453)', () => {
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows an unconfirmed report, then clears it once the push lands', async () => {
    const { home, remote, projectRoot } = setUpProject();
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(home);

    // One usage event the scope has not reported yet.
    fs.appendFileSync(path.join(partition, 'usage.jsonl'), JSON.stringify({
      skill: 'tdd', timestamp: new Date().toISOString(), tool: 'claude',
    }) + '\n');

    const blocked = await withPushesRejected(remote, () => runCLI(['pull'], projectRoot, home));
    expect(blocked.code, blocked.output).toBe(0);

    const pending = await runCLI(['status'], projectRoot, home);
    expect(pending.code, pending.output).toBe(0);
    expect(pending.output).toContain('pending report: since ');
    expect(pending.output).toContain('teamai pull --verbose');

    const reported = await runCLI(['pull'], projectRoot, home);
    expect(reported.code, reported.output).toBe(0);

    const clean = await runCLI(['status'], projectRoot, home);
    expect(clean.code, clean.output).toBe(0);
    expect(clean.output).not.toContain('pending report');
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-reports'], remote)).toContain('stats/ci-1453.yaml');
  });
});
