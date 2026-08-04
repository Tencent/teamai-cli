import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const PROJECT_TITLE = 'Java Project Review Workflow';
const USER_TITLE = 'Organization Review Workflow';
const PROJECT_COLLISION_TITLE = 'Project Shared Collision Policy';
const USER_COLLISION_TITLE = 'Organization Shared Collision Policy';
const INHERIT_MSG = 'project scope detected, inheriting user-scope resources and knowledge';

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
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });
}

function learningDoc(title: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-08-04\ntags: [review, workflow]\n---\n\nUse an independent reviewer after implementation.\n`;
}

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: review workflow\n---\n\n# ${name}\n\nReview independently.\n`;
}

const TEAM_YAML = [
  'team: e2e-team',
  'repo: https://example.com/e2e.git',
  'provider: tgit',
  'sharing:',
  '  env:',
  '    injectShellProfile: true',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
].join('\n');

function makeRemote(
  dir: string,
  learningTitle: string,
  skillName: string,
  collisionTitle: string,
  includeEnv = false,
): void {
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', skillName), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), TEAM_YAML);
  fs.writeFileSync(path.join(dir, 'learnings', `${skillName}.md`), learningDoc(learningTitle));
  fs.writeFileSync(path.join(dir, 'learnings', 'shared-policy.md'), learningDoc(collisionTitle));
  fs.writeFileSync(path.join(dir, 'skills', skillName, 'SKILL.md'), skillDoc(skillName));
  if (includeEnv) {
    fs.mkdirSync(path.join(dir, 'env'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'env', 'env.yaml'),
      'variables:\n  - key: ORG_ONLY_SECRET\n    value: should-not-load-in-project\n',
    );
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'hooks', 'hooks.yaml'),
      'hooks:\n  SessionStart:\n    - command: echo inherited-hook-must-not-run\n',
    );
    fs.writeFileSync(
      path.join(dir, 'mcp.yaml'),
      'servers:\n  inherited-user-server:\n    command: node\n    args: [server.js]\n',
    );
  }
  git(['init', '-q'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

describe('opt-in user-scope inheritance (e2e)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let pullResult: RunResult;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-inherit-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'java-project');
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    const userRemote = path.join(sandbox, 'org-remote');
    makeRemote(userRemote, USER_TITLE, 'org-review', USER_COLLISION_TITLE, true);
    const userLocal = path.join(homeDir, '.teamai', 'team-repo');
    git(['clone', '-q', userRemote, userLocal], sandbox);
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${userLocal}`,
        `  remote: ${userRemote}`,
        'username: ci-user',
        'scope: user',
      ].join('\n'),
    );

    const projectRemote = path.join(sandbox, 'java-remote');
    makeRemote(projectRemote, PROJECT_TITLE, 'java-review', PROJECT_COLLISION_TITLE);
    const projectLocal = path.join(projectRoot, '.teamai', 'team-repo');
    git(['clone', '-q', projectRemote, projectLocal], sandbox);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${projectLocal}`,
        `  remote: ${projectRemote}`,
        'username: ci-project',
        'scope: project',
        `projectRoot: ${projectRoot}`,
        'inheritUserScope: true',
      ].join('\n'),
    );

    pullResult = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pulls safe resources into both scope-specific locations', () => {
    expect(pullResult.code, pullResult.output).toBe(0);
    expect(pullResult.output).toContain(INHERIT_MSG);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'org-review'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'java-review'))).toBe(true);
  });

  it('does not inherit user-scope environment configuration', () => {
    expect(fs.existsSync(path.join(homeDir, '.teamai', 'env.sh'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.teamai', 'env'))).toBe(false);
  });

  it('does not apply inherited user hooks or MCP configuration', () => {
    expect(fs.existsSync(path.join(homeDir, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.teamai', 'managed-mcp.json'))).toBe(false);
  });

  it('recalls organization and project knowledge together', async () => {
    const result = await runCLI(['recall', 'review workflow'], { HOME: homeDir }, projectRoot);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(PROJECT_TITLE);
    expect(result.output).toContain(USER_TITLE);
    expect(result.output).toContain('[project]');
    expect(result.output).toContain('[user]');
  });

  it('lets the project entry shadow the same inherited type and filename', async () => {
    const result = await runCLI(['recall', 'shared collision policy'], { HOME: homeDir }, projectRoot);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(PROJECT_COLLISION_TITLE);
    expect(result.output).not.toContain(USER_COLLISION_TITLE);
  });

  it('keeps full user sync pending so a later user pull still applies env', async () => {
    const inheritedState = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.teamai', 'state.json'), 'utf8'),
    ) as { lastPullRev?: string | null; lastInheritedPullRev?: string | null };
    expect(inheritedState.lastInheritedPullRev).toBeTruthy();
    expect(inheritedState.lastPullRev).toBeNull();

    const result = await runCLI(['pull'], { HOME: homeDir }, homeDir);
    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(path.join(homeDir, '.teamai', 'env.sh'), 'utf8'))
      .toContain('ORG_ONLY_SECRET');
  });
});
