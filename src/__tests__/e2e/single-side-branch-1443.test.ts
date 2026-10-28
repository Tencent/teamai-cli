/**
 * E2E (#1443): a `kind: self` team installed at user scope and its project
 * partition keep ONE side-branch checkout per branch, in the partition. The
 * first upgraded pull takes over a checkout an older install left in
 * `~/.teamai/`; after that, alternating pulls inside and outside the repo never
 * move it again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_BRANCH_HOME_DIRNAME } from '../../types.js';

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
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue1443-e2e-')));
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
  fs.mkdirSync(path.join(knowledge, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'learnings', '.gitkeep'), '');
  fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), [
    'team: issue-1443-e2e',
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

  // Both side branches on origin, as an older install left them.
  const seed = path.join(sandbox, 'seed');
  git(['clone', '-q', remote, seed], sandbox);
  for (const branch of ['teamai-reports', 'teamai-learnings']) {
    git(['checkout', '-q', '--orphan', branch], seed);
    git(['rm', '-qrf', '.'], seed);
    fs.writeFileSync(path.join(seed, '.gitignore'), `${branch.replace('teamai-', '')}-wt/\n`);
    git(['add', '.gitignore'], seed);
    git(['commit', '-qm', branch], seed);
    git(['push', '-q', 'origin', branch], seed);
  }
  git(['fetch', '-q', 'origin', 'teamai-reports:teamai-reports'], projectRoot);
  git(['fetch', '-q', 'origin', 'teamai-learnings:teamai-learnings'], projectRoot);

  // The old user-scope layout: both checkouts in `~/.teamai/`.
  git(['worktree', 'add', '-q', path.join(home, '.teamai', 'reports-wt'), 'teamai-reports'], projectRoot);
  git(['worktree', 'add', '-q', path.join(home, '.teamai', 'learnings-wt'), 'teamai-learnings'], projectRoot);

  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${projectRoot}`,
    'username: verify-member',
    'updatePolicy: skip',
    'scope: user',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${projectRoot}`,
    'username: verify-member',
    'updatePolicy: skip',
    'scope: project',
    `projectRoot: ${projectRoot}`,
    '',
  ].join('\n'));

  fs.appendFileSync(path.join(home, '.teamai', 'user-usage.jsonl'), JSON.stringify({
    skill: 'tdd', timestamp: new Date().toISOString(), tool: 'claude',
  }) + '\n');
  fs.mkdirSync(path.join(home, '.teamai', 'pending-learnings'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.teamai', 'pending-learnings', 'user-note-2026-01-01-aaaaaa.md'),
    '# Queued from the user scope\n',
  );
  return { sandbox, home, remote, projectRoot };
}

function partitionOf(home: string): string {
  const projects = path.join(home, '.teamai', 'projects');
  const [partition] = fs.readdirSync(projects);
  return path.join(projects, partition);
}

describe('one side-branch checkout per self-mode repository (#1443)', () => {
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes the old checkouts over once, then alternating pulls move nothing', async () => {
    const { home, remote, projectRoot } = setUpProject();

    const first = await runCLI(['pull', '--verbose'], path.dirname(home), home);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('removed the old checkout');
    const partition = partitionOf(home);
    const shared = path.join(partition, SELF_BRANCH_HOME_DIRNAME);
    expect(fs.existsSync(path.join(home, '.teamai', 'reports-wt'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.teamai', 'learnings-wt'))).toBe(false);
    for (const dirname of ['reports-wt', 'learnings-wt']) {
      expect(fs.existsSync(path.join(shared, dirname)), dirname).toBe(true);
    }

    // A git-mode teammate's checkouts in this partition are siblings of its
    // clone (directly under the partition). Self mode must leave them alone.
    const gitModeCheckout = path.join(partition, 'reports-wt');
    fs.mkdirSync(gitModeCheckout, { recursive: true });
    fs.writeFileSync(path.join(gitModeCheckout, 'owned-by-another-team'), '');

    // The user scope's usage and its queued learning went through the shared
    // checkouts.
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-reports'], remote)).toContain('stats/verify-member.yaml');
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], remote)).toContain('learnings/user-note-2026-01-01-aaaaaa.md');

    // A pull inside the repo and another outside never move the checkouts again.
    const projectPull = await runCLI(['pull', '--verbose'], projectRoot, home);
    expect(projectPull.code, projectPull.output).toBe(0);
    expect(projectPull.output).not.toContain('removed the old checkout');

    fs.appendFileSync(path.join(partition, 'usage.jsonl'), JSON.stringify({
      skill: 'tdd', timestamp: new Date().toISOString(), tool: 'claude',
    }) + '\n');
    const projectReport = await runCLI(['pull'], projectRoot, home);
    expect(projectReport.code, projectReport.output).toBe(0);
    // The project scope's own event reached the same reports branch.
    expect(git(['show', 'teamai-reports:stats/verify-member.yaml'], remote)).toContain('count: 2');

    const userAgain = await runCLI(['pull', '--verbose'], path.dirname(home), home);
    expect(userAgain.code, userAgain.output).toBe(0);
    expect(userAgain.output).not.toContain('removed the old checkout');

    // Each scope keeps its own config, state and usage; doctor is clean.
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.teamai', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.teamai', 'user-usage.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(partition, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(partition, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(partition, 'usage.jsonl'))).toBe(true);

    expect(fs.existsSync(path.join(gitModeCheckout, 'owned-by-another-team'))).toBe(true);

    const doctor = await runCLI(['doctor'], projectRoot, home);
    expect(doctor.code, doctor.output).toBe(0);
  }, 120_000);

  it('takes over a checkout an older project partition left at its root', async () => {
    const { home, remote, projectRoot } = setUpProject();
    // Start from the project scope: its first pull creates the partition.
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(home);
    const shared = path.join(partition, SELF_BRANCH_HOME_DIRNAME);

    // The pre-#1443 layout kept both checkouts directly in the partition.
    for (const dirname of ['reports-wt', 'learnings-wt']) {
      git(['worktree', 'move', path.join(shared, dirname), path.join(partition, dirname)], projectRoot);
      expect(fs.existsSync(path.join(partition, dirname)), dirname).toBe(true);
    }

    fs.appendFileSync(path.join(home, '.teamai', 'user-usage.jsonl'), JSON.stringify({
      skill: 'tdd', timestamp: new Date().toISOString(), tool: 'claude',
    }) + '\n');
    const second = await runCLI(['pull', '--verbose'], path.dirname(home), home);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('removed the old checkout');

    for (const dirname of ['reports-wt', 'learnings-wt']) {
      expect(fs.existsSync(path.join(partition, dirname)), dirname).toBe(false);
      expect(fs.existsSync(path.join(shared, dirname)), dirname).toBe(true);
    }
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-reports'], remote)).toContain('stats/verify-member.yaml');
  }, 120_000);
});
