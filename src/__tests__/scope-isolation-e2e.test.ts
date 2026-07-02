import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Issue #73 end-to-end: project scope isolates user scope ──────────────
//
// Drives the real CLI binary against two offline git fixture repos (one user,
// one project). No network / token needed. Verifies that, when run inside a
// project-scope install:
//   - `pull` skips the user scope (notice printed, user skills NOT deployed)
//     while still deploying the project scope, and
//   - `recall` only returns project-scope knowledge, and
//   - `uninstall` clearly states it is acting on the project scope.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const PROJECT_TITLE = 'Project Deployment Timeout Fix';
const USER_TITLE = 'User Deployment Timeout Fix';
const SKIP_MSG = 'project scope detected, skipped user scope';

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

function learningDoc(title: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [deployment, timeout]\n---\n\nNotes about deployment timeout handling.\n`;
}

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: demo skill for e2e\n---\n\n# ${name}\n\nDemo.\n`;
}

const TEAM_YAML = [
  'team: e2e-team',
  'repo: https://example.com/e2e.git',
  'provider: tgit',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
].join('\n');

/** Create a git repo fixture with a learning doc + a skill, return its path. */
function makeRemote(dir: string, learningTitle: string, skillName: string): void {
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', skillName), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), TEAM_YAML);
  fs.writeFileSync(
    path.join(dir, 'learnings', `${skillName}-2026-05-01-aaa.md`),
    learningDoc(learningTitle),
  );
  fs.writeFileSync(path.join(dir, 'skills', skillName, 'SKILL.md'), skillDoc(skillName));
  git('init -q', dir);
  git('add -A', dir);
  git('commit -q -m init', dir);
}

describe('scope isolation e2e (issue #73)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let pullOut: RunResult;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-iso-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'proj');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    // Pre-create the claude tool dirs in BOTH scopes so the deploy "is tool
    // installed" gate passes for each. This makes the user-skill absence a
    // genuine isolation signal (not just a missing tool dir).
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    // ── User-scope fixture ──
    const userRemote = path.join(sandbox, 'user-remote');
    makeRemote(userRemote, USER_TITLE, 'user-skill');
    const userLocal = path.join(homeDir, '.teamai', 'team-repo');
    git(`clone -q "${userRemote}" "${userLocal}"`, sandbox);
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${userLocal}`,
        `  remote: ${userRemote}`,
        'username: ci-user',
        'updatePolicy: auto',
        'scope: user',
      ].join('\n'),
    );

    // ── Project-scope fixture ──
    const projectRemote = path.join(sandbox, 'proj-remote');
    makeRemote(projectRemote, PROJECT_TITLE, 'demo-skill');
    const projectLocal = path.join(projectRoot, '.teamai', 'team-repo');
    git(`clone -q "${projectRemote}" "${projectLocal}"`, sandbox);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${projectLocal}`,
        `  remote: ${projectRemote}`,
        'username: ci-proj',
        'updatePolicy: auto',
        'scope: project',
        `projectRoot: ${projectRoot}`,
      ].join('\n'),
    );

    // Run pull once from within the project root.
    pullOut = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pull: prints skip notice and exits cleanly', () => {
    expect(pullOut.code, pullOut.output).toBe(0);
    expect(pullOut.output).toContain(SKIP_MSG);
  });

  it('pull: deploys project skills but NOT user skills', () => {
    const projectSkill = path.join(projectRoot, '.claude', 'skills', 'demo-skill');
    const userSkillInHome = path.join(homeDir, '.claude', 'skills', 'user-skill');
    expect(fs.existsSync(projectSkill)).toBe(true);
    expect(fs.existsSync(userSkillInHome)).toBe(false);
  });

  it('recall: returns project knowledge only', async () => {
    const res = await runCLI(['recall', 'deployment timeout'], { HOME: homeDir }, projectRoot);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain(PROJECT_TITLE);
    expect(res.output).not.toContain(USER_TITLE);
  });

  it('uninstall --dry-run: states it is acting on the project scope', async () => {
    const res = await runCLI(['uninstall', '--dry-run', '--force'], { HOME: homeDir }, projectRoot);
    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain('正在卸载 project scope（项目级）');
  });
});
