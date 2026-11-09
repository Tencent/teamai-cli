import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Rule and workflow folders are read since #1787, so the rule directory below becomes one; agent folders are still skipped.
const RULE_FOLDER_NOTE = 'rules/api-style/ holds RULE.md, so it is one folder, and checklist.md in it is one of its files, no longer read on its own.';
const AGENT_LINE = 'agents/reviewer/ is an agent folder, which this teamai cannot read yet; it was skipped. Run teamai update.';

function runCLI(args: string[], home: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function write(root: string, relPath: string, content: string): void {
  const file = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every file under `dir`, relative and `/`-separated. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

describe('real CLI: pull skips a folder whose type this teamai cannot read (#1791), and reads a rule folder (#1787)', () => {
  let sandbox: string;
  let homeDir: string;
  let seed: string;
  let remote: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skipped-folders-e2e-'));
    homeDir = path.join(sandbox, 'home');
    seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team-remote.git');
    const localRepo = path.join(homeDir, '.teamai', 'team-repo');

    // First commit: api-style/ is an ordinary directory, so its file is the
    // rule api-style/checklist, delivered like any other.
    write(seed, 'teamai.yaml', ['team: skipped-folders-e2e', `repo: ${remote}`, 'provider: git', ''].join('\n'));
    write(seed, 'rules/style.md', '# Style\n\nUse two spaces.\n');
    write(seed, 'rules/api-style/checklist.md', '# API checklist\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'rules'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, localRepo], sandbox);

    for (const dir of ['.claude', '.codex', '.codebuddy', path.join('.config', 'opencode')]) {
      fs.mkdirSync(path.join(homeDir, dir), { recursive: true });
    }

    fs.writeFileSync(path.join(homeDir, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remote}`,
      'username: ci-user',
      'updatePolicy: auto',
      'scope: user',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the plain directory first', async () => {
    const result = await runCLI(['pull', '--force'], homeDir, sandbox);

    expect(result.code, result.output).toBe(0);
    expect(filesUnder(path.join(homeDir, '.claude', 'rules'))).toEqual(['api-style/checklist.md', 'style.md']);
  }, 60_000);

  it('then reads it as a rule folder once it holds RULE.md, removes what it delivered from it, reads the workflow folder and skips the agent folder', async () => {
    write(seed, 'rules/api-style/RULE.md', '# API style\n');
    write(seed, 'rules/api-style/RULE.zh.md', '# API 风格\n');
    write(seed, 'workflows/release/WORKFLOW.yaml', 'schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n  - id: plan\n    command: echo plan\n');
    write(seed, 'workflows/release/notes.md', '# Release notes\n');
    write(seed, 'agents/reviewer/AGENT.md', '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'rule, workflow and agent folders'], seed);
    git(['push', '-q', remote, 'main'], seed);

    const result = await runCLI(['pull'], homeDir, sandbox);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(RULE_FOLDER_NOTE);
    expect(result.output.split(AGENT_LINE)).toHaveLength(2);
    expect(result.output).not.toContain('workflows/release/ is a workflow folder');
    expect(filesUnder(path.join(homeDir, '.claude', 'rules'))).toEqual(['api-style.md', 'style.md']);
    expect(filesUnder(path.join(homeDir, '.teamai', 'rules'))).toEqual(['api-style/RULE.md', 'api-style/RULE.zh.md', 'api-style/checklist.md']);
  }, 60_000);

  it('writes the line to debug.log on a silent pull', async () => {
    fs.rmSync(path.join(homeDir, '.teamai', 'debug.log'), { force: true });

    const result = await runCLI(['pull', '--silent'], homeDir, sandbox);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain(AGENT_LINE);
    expect(fs.readFileSync(path.join(homeDir, '.teamai', 'debug.log'), 'utf8')).toContain(AGENT_LINE);
  }, 60_000);

  it('lists the skipped folders in status and doctor', async () => {
    const status = await runCLI(['status'], homeDir, sandbox);

    expect(status.output).toContain('Skipped folders:');
    expect(status.output).toContain(`  ${AGENT_LINE}`);
    expect(status.output).toContain('  rules: 2');
    expect(status.output).toContain('  workflows: 1');

    const doctor = await runCLI(['doctor'], homeDir, sandbox);

    expect(doctor.output).toContain('  ⚠ This teamai reads every folder in the team repo');
    expect(doctor.output).toContain(`    → ${AGENT_LINE}`);
  }, 60_000);

  it('pushes nothing into a rule folder, and the rest as before', async () => {
    write(homeDir, '.claude/rules/api-style/extra.md', '# Extra API rule\n');
    write(homeDir, '.claude/rules/naming.md', '# Naming\n\nName things for what they hold.\n');

    const status = await runCLI(['status', '--verbose'], homeDir, sandbox);

    expect(status.output).toContain('  [rules] 1 new\n    - naming\n');
    const pushed = await runCLI(['push', '--all'], homeDir, sandbox);
    const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], { cwd: remote, encoding: 'utf8' })
      .split('\n').filter(Boolean);

    expect(branches, pushed.output).toHaveLength(1);
    const files = execFileSync('git', ['diff', '--name-only', 'main', branches[0]], { cwd: remote, encoding: 'utf8' }).split('\n').filter(Boolean);

    expect(files, pushed.output).toEqual(['rules/naming.md']);
    expect(pushed.output).toContain('rules/api-style/ is a rule folder, so rules/api-style/extra.md would be one of its files, not a rule.');
  }, 60_000);

  it('refuses to place a new rule in a namespace that is a rule folder', async () => {
    write(seed, 'manifest/roles.yaml', 'version: 1\nroles:\n  - id: api\n    resources: { knowledge: [api-style], skills: [] }\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'roles'], seed);
    git(['push', '-q', remote, 'main'], seed);
    write(homeDir, '.claude/rules/tone.md', '# Tone\n');

    const pushed = await runCLI(['push', '--all', '--role', 'api-style'], homeDir, sandbox);
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], { cwd: remote, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const placed = refs.filter((ref) => execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: remote, encoding: 'utf8' }).includes('rules/api-style/tone.md'));

    expect(pushed.code, pushed.output).not.toBe(0);
    expect(pushed.output).toContain('[rules] tone cannot be placed in rules/api-style/tone.md: rules/api-style/ is a rule folder, so the file would be one of its files, not a rule. Push it with --role <another namespace> or --shared.');
    expect(placed).toEqual([]);
  }, 60_000);
});
