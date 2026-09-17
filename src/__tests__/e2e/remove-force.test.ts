import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Issue #591: `teamai remove` must be runnable unattended ───────────
//
// `askConfirmation` returns false without a TTY, and the command had no flag
// to skip the prompt, so every scripted run printed "Cancelled" and exited 0.
// That is why no end-to-end test covered `teamai remove` at all, and why the
// two defects in #576 survived. These tests drive the real CLI binary:
//   1. `--force` removes without a prompt.
//   2. Without `--force`, a non-interactive run still cancels and deletes
//      nothing, so the flag is the only way past the confirmation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const TEAM_YAML = [
  'team: e2e-team',
  'repo: https://example.com/e2e.git',
  'provider: git',
  'usageReport: false',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
].join('\n');

describe('teamai remove --force (e2e, issue #591)', () => {
  let sandbox: string;
  let homeDir: string;
  let clone: string;
  let remote: string;
  let env: Record<string, string>;

  beforeEach(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-remove-force-e2e-'));
    homeDir = path.join(sandbox, 'home');
    clone = path.join(homeDir, '.teamai', 'team-repo');
    remote = path.join(sandbox, 'remote.git');

    // A real remote, so the run reaches `pushRepoBranch` rather than dying at
    // the push. Without it the command stops after the local delete and the
    // assertions below would pass on a half-finished run.
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), TEAM_YAML);
    fs.writeFileSync(path.join(seed, 'rules', 'doomed.md'), '# Doomed\n');
    fs.writeFileSync(path.join(seed, 'rules', 'keeper.md'), '# Keeper\n');
    git('init -q -b main', seed);
    git('add -A', seed);
    git('commit -q -m fixture', seed);
    git(`init -q --bare ${remote}`, sandbox);
    git(`remote add origin ${remote}`, seed);
    git('push -q origin main', seed);

    fs.mkdirSync(path.join(homeDir, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(`clone -q -b main ${remote} ${clone}`, sandbox);

    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${clone}`,
        '  remote: https://example.com/e2e.git',
        'username: e2e',
        'updatePolicy: skip',
        'scope: user',
        '',
      ].join('\n'),
    );

    // The deployed copy the removal must clear.
    fs.writeFileSync(path.join(homeDir, '.claude', 'rules', 'doomed.md'), '# Doomed\n');
    fs.writeFileSync(path.join(homeDir, '.claude', 'rules', 'keeper.md'), '# Keeper\n');

    env = { HOME: homeDir, ...GIT_ENV };
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('removes without a prompt when --force is passed', async () => {
    const result = await runCLI(['remove', 'rules', 'doomed', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Cancelled');
    // The run must reach the push, not stop at the local delete.
    expect(result.output).not.toContain('Git push failed');

    // Local effect: the deployed copy goes immediately, unrelated rules stay.
    expect(fs.existsSync(path.join(homeDir, '.claude', 'rules', 'doomed.md'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'rules', 'keeper.md'))).toBe(true);

    // Team effect: the deletion and its tombstone are published as a branch for
    // review. `checkoutMaster` returns the clone to the default branch, so the
    // clone's own working tree still holds the file until that branch merges.
    const branch = execSync("git for-each-ref --format='%(refname:short)' refs/heads/teamai", {
      cwd: remote, encoding: 'utf8',
    }).trim();
    expect(branch, result.output).toMatch(/^teamai\/push\//);
    const onBranch = execSync(`git ls-tree --name-only ${branch} rules/`, {
      cwd: remote, encoding: 'utf8',
    });
    expect(onBranch).not.toContain('rules/doomed.md');
    expect(onBranch).toContain('rules/.removed');
    const tombstone = execSync(`git show ${branch}:rules/.removed`, { cwd: remote, encoding: 'utf8' });
    expect(tombstone).toContain('doomed');
  });

  it('still cancels a non-interactive run without --force', async () => {
    const result = await runCLI(['remove', 'rules', 'keeper'], env, homeDir);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Cancelled');
    expect(fs.existsSync(path.join(clone, 'rules', 'keeper.md'))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'rules', 'keeper.md'))).toBe(true);
  });
});
