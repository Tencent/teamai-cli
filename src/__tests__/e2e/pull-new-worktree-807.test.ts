/**
 * E2E (#807): a linked worktree created after the project was pulled gets the
 * team's resources on its first pull.
 *
 * state.json lives in the project partition, shared by every worktree, while
 * skills, rules, agents and docs are written into each worktree's own root.
 * A pull in a fresh worktree used to match the main checkout's recorded
 * revision, print "Already synced" and deliver nothing. And because the tool
 * targets were shared too, two checkouts with different tool directories
 * forced a full sync on each other on every pull.
 */
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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

describe('pull in a new linked worktree (#807)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let sameTargets: string;
  let fewerTargets: string;

  const delivered = (root: string) => ({
    skill: fs.existsSync(path.join(root, '.claude', 'skills', 'team-skill', 'SKILL.md')),
    rule: fs.existsSync(path.join(root, '.claude', 'rules', 'team-rule.md')),
    agent: fs.existsSync(path.join(root, '.claude', 'agents', 'team-helper.md')),
    doc: fs.existsSync(path.join(root, '.teamai', 'docs', 'guide.md')),
  });

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue807-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    sameTargets = path.join(sandbox, 'wt-same');
    fewerTargets = path.join(sandbox, 'wt-fewer');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'team-skill'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-807-e2e',
      'repo: https://example.com/team.git',
      'provider: tgit',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(seed, 'skills', 'team-skill', 'SKILL.md'),
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n',
    );
    fs.writeFileSync(path.join(seed, 'rules', 'team-rule.md'), '# Team rule\n');
    fs.writeFileSync(path.join(seed, 'docs', 'guide.md'), '# Team guide\n');
    fs.writeFileSync(path.join(seed, 'agents', 'team-helper.yaml'), [
      'name: team-helper',
      'description: Team helper fixture',
      'targets:',
      '  - claude',
      'instructions: |',
      '  Help with team tasks.',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    // The business repo is a real git repo, so it can have linked worktrees.
    // Its .claude/ is tracked, as in a repo that commits its settings, so every
    // worktree starts with .claude/. .cursor/ is untracked: the main checkout
    // has it, and each test decides whether its worktree gets one.
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '.teamai/\n.cursor/\n.claude/skills/\n.claude/rules/\n.claude/agents/\n',
    );
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });

    fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-807',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude, cursor]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const pull = async (cwd: string): Promise<string> => {
    const r = await runCLI(['pull'], cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };
  const all = { skill: true, rule: true, agent: true, doc: true };

  it('delivers skills, rules, agents and docs to a new worktree with the same tool targets', async () => {
    const first = await pull(projectRoot);
    expect(delivered(projectRoot), first).toEqual(all);

    git(['worktree', 'add', '-q', sameTargets, '-b', 'wt-same'], projectRoot);
    fs.mkdirSync(path.join(sameTargets, '.cursor'), { recursive: true });

    const inWorktree = await pull(sameTargets);
    expect(inWorktree).not.toContain('Already synced');
    expect(delivered(sameTargets), inWorktree).toEqual(all);

    // Once the worktree has synced this revision, its next pull takes the fast path.
    expect(await pull(sameTargets)).toContain('Already synced');
  });

  it('keeps each checkout\'s own targets, so different tool directories do not force full syncs', async () => {
    git(['worktree', 'add', '-q', fewerTargets, '-b', 'wt-fewer'], projectRoot);

    const inWorktree = await pull(fewerTargets);
    expect(delivered(fewerTargets), inWorktree).toEqual(all);
    expect(await pull(fewerTargets)).toContain('Already synced');

    // The main checkout (claude + cursor) still matches its own record after a
    // pull in a checkout that syncs claude only.
    expect(await pull(projectRoot)).toContain('Already synced');
    expect(await pull(sameTargets)).toContain('Already synced');
  });

  it('delivers to a worktree re-created at the same path', async () => {
    git(['worktree', 'remove', '--force', sameTargets], projectRoot);
    git(['worktree', 'add', '-q', sameTargets, '-b', 'wt-same-again'], projectRoot);
    fs.mkdirSync(path.join(sameTargets, '.cursor'), { recursive: true });

    const recreated = await pull(sameTargets);
    expect(recreated).not.toContain('Already synced');
    expect(delivered(sameTargets), recreated).toEqual(all);
  });

  it('still applies a skill exclusion on the next pull, although the team repo has not moved', async () => {
    // exclude (like tags, roles, projects, init) forces the next full sync by
    // clearing the shared lastPullRev; the per-checkout record must not hide it.
    const exclude = await runCLI(['skill', 'exclude', 'add', 'team-skill'], projectRoot, home);
    expect(exclude.code, exclude.output).toBe(0);

    const after = await pull(projectRoot);
    expect(after).not.toContain('Already synced');
    expect(delivered(projectRoot).skill, after).toBe(false);

    // The exclusion reaches every checkout, not only the first to pull after it.
    const otherCheckout = await pull(fewerTargets);
    expect(otherCheckout).not.toContain('Already synced');
    expect(delivered(fewerTargets).skill, otherCheckout).toBe(false);
  });
});
