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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });
}

describe('project-scope sequential agent cold start (#342)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue342-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const remote = path.join(sandbox, 'team-remote');
    const localRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    fs.mkdirSync(path.join(remote, 'skills', 'team-skill'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'agents'), { recursive: true });

    fs.writeFileSync(
      path.join(remote, 'teamai.yaml'),
      [
        'team: issue-342-e2e',
        'repo: https://example.com/team.git',
        'provider: tgit',
        'toolPaths:',
        '  claude:',
        '    skills: .claude/skills',
        '    rules: .claude/rules',
        '    agents: .claude/agents',
        '  cursor:',
        '    skills: .cursor/skills',
        '    rules: .cursor/rules',
        '    agents: .cursor/agents',
        '  codex:',
        '    skills: .codex/skills',
        '    rules: .codex/rules',
        '    agents: .codex/agents',
        '  codebuddy:',
        '    skills: .codebuddy/skills',
        '    rules: .codebuddy/rules',
        '    agents: .codebuddy/agents',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(remote, 'skills', 'team-skill', 'SKILL.md'),
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n',
    );
    fs.writeFileSync(path.join(remote, 'rules', 'team-rule.md'), '# Team rule\n');
    fs.writeFileSync(
      path.join(remote, 'agents', 'team-helper.yaml'),
      [
        'name: team-helper',
        'description: Team helper fixture',
        'targets:',
        '  - claude',
        '  - cursor',
        'instructions: |',
        '  Help with team tasks.',
      ].join('\n'),
    );

    git(['init', '-q'], remote);
    git(['add', '-A'], remote);
    git(['commit', '-q', '-m', 'fixture'], remote);

    fs.mkdirSync(projectRoot, { recursive: true });
    git(['clone', '-q', remote, localRepo], sandbox);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${localRepo}`,
        `  remote: ${remote}`,
        'username: ci-project',
        'updatePolicy: auto',
        'scope: project',
        `projectRoot: ${projectRoot}`,
        'enabledAgents:',
        '  - claude',
        '  - cursor',
        'disabledAgents:',
        '  - codebuddy',
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('tracks the exact target set across sequential and recreated agent roots', async () => {
    for (const agentRoot of ['.claude', '.cursor', '.codex', '.codebuddy']) {
      fs.rmSync(path.join(projectRoot, agentRoot), { recursive: true, force: true });
    }
    fs.rmSync(path.join(projectRoot, '.teamai', 'state.json'), { force: true });
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.codebuddy'), { recursive: true });

    const firstPull = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
    expect(firstPull.code, firstPull.output).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'rules', 'team-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'agents', 'team-helper.md'))).toBe(true);
    expect(JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['claude']);

    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });

    const secondPull = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
    expect(secondPull.code, secondPull.output).toBe(0);
    expect(secondPull.output).not.toContain('Already synced');
    expect(fs.existsSync(path.join(projectRoot, '.cursor', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.cursor', 'rules', 'team-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.cursor', 'agents', 'team-helper.md'))).toBe(true);
    expect(JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['claude', 'cursor']);

    const thirdPull = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
    expect(thirdPull.code, thirdPull.output).toBe(0);
    expect(thirdPull.output).toContain('Already synced');

    fs.rmSync(path.join(projectRoot, '.cursor'), { recursive: true, force: true });
    const fourthPull = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
    expect(fourthPull.code, fourthPull.output).toBe(0);
    expect(fourthPull.output).not.toContain('Already synced');
    expect(JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['claude']);

    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });
    const fifthPull = await runCLI(['pull'], { HOME: homeDir }, projectRoot);
    expect(fifthPull.code, fifthPull.output).toBe(0);
    expect(fifthPull.output).not.toContain('Already synced');
    expect(fs.existsSync(path.join(projectRoot, '.cursor', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['claude', 'cursor']);

    expect(fs.existsSync(path.join(projectRoot, '.codex'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy', 'rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy', 'agents'))).toBe(false);
  }, 30_000);
});
