import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('managed agents and OpenClaw skills uninstall (dist CLI e2e)', () => {
  let sandbox: string;
  let projectRoot: string;
  let teamaiHome: string;
  let managedAgentPaths: string[];
  let managedOpenclawSkill: string;
  let userAgent: string;
  let userOpenclawSkill: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-managed-uninstall-e2e-'));
    projectRoot = path.join(sandbox, 'project');
    teamaiHome = path.join(projectRoot, '.teamai');
    const seedRepo = path.join(sandbox, 'seed');
    const remoteRepo = path.join(sandbox, 'team-origin.git');
    const repoLocal = path.join(teamaiHome, 'team-repo');

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(seedRepo, { recursive: true });
    git(['init', '--initial-branch=main'], seedRepo);
    git(['config', 'user.email', 'e2e@example.com'], seedRepo);
    git(['config', 'user.name', 'TeamAI E2E'], seedRepo);

    fs.mkdirSync(path.join(seedRepo, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(seedRepo, 'agents', 'beta-proof-agent.yaml'),
      [
        'name: beta-proof-agent',
        'description: Proves managed agents are removed',
        'instructions: Help the team',
        'targets:',
        '  - claude',
        '  - codex',
        '  - cursor',
        '  - codebuddy',
        '  - opencode',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(seedRepo, 'skills', 'beta-proof'), { recursive: true });
    fs.writeFileSync(
      path.join(seedRepo, 'skills', 'beta-proof', 'SKILL.md'),
      '---\nname: beta-proof\ndescription: Managed test skill\n---\n',
    );
    fs.writeFileSync(
      path.join(seedRepo, 'teamai.yaml'),
      [
        'team: managed-uninstall-e2e',
        `repo: ${remoteRepo}`,
        'provider: github',
        'toolPaths:',
        '  claude:',
        '    agents: .claude/agents',
        '  codex:',
        '    agents: .codex/agents',
        '  cursor:',
        '    agents: .cursor/agents',
        '  codebuddy:',
        '    agents: .codebuddy/agents',
        '  opencode:',
        '    agents: .opencode/agents',
        '  openclaw:',
        '    skills: .openclaw/skills',
      ].join('\n'),
    );
    git(['add', '.'], seedRepo);
    git(['commit', '-m', 'seed managed resources'], seedRepo);
    git(['init', '--bare', remoteRepo], sandbox);
    git(['remote', 'add', 'origin', remoteRepo], seedRepo);
    git(['push', '-u', 'origin', 'main'], seedRepo);

    fs.mkdirSync(teamaiHome, { recursive: true });
    git(['clone', '--branch', 'main', remoteRepo, repoLocal], sandbox);
    fs.writeFileSync(
      path.join(teamaiHome, 'config.yaml'),
      [
        'repo:',
        `  localPath: ${repoLocal}`,
        `  remote: ${remoteRepo}`,
        'username: e2e-user',
        'updatePolicy: skip',
        'scope: project',
        `projectRoot: ${projectRoot}`,
      ].join('\n'),
    );

    for (const toolRoot of ['.claude', '.codex', '.cursor', '.codebuddy', '.opencode']) {
      fs.mkdirSync(path.join(projectRoot, toolRoot), { recursive: true });
    }
    fs.mkdirSync(path.join(projectRoot, '.openclaw', 'workspace'), { recursive: true });

    managedAgentPaths = [
      path.join(projectRoot, '.claude', 'agents', 'beta-proof-agent.md'),
      path.join(projectRoot, '.codex', 'agents', 'beta-proof-agent.toml'),
      path.join(projectRoot, '.cursor', 'agents', 'beta-proof-agent.md'),
      path.join(projectRoot, '.codebuddy', 'agents', 'beta-proof-agent.md'),
      path.join(projectRoot, '.opencode', 'agents', 'beta-proof-agent.md'),
    ];
    managedOpenclawSkill = path.join(
      projectRoot,
      '.openclaw',
      'workspace',
      'skills',
      'beta-proof',
    );
    userAgent = path.join(projectRoot, '.claude', 'agents', 'my-own-agent.md');
    userOpenclawSkill = path.join(
      projectRoot,
      '.openclaw',
      'workspace',
      'skills',
      'my-own-skill',
    );
    fs.mkdirSync(path.dirname(userAgent), { recursive: true });
    fs.writeFileSync(userAgent, '# User-owned agent');
    fs.mkdirSync(userOpenclawSkill, { recursive: true });
    fs.writeFileSync(path.join(userOpenclawSkill, 'SKILL.md'), '# User-owned skill');
  }, 30_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pulls managed resources, lists them in dry-run, and removes only managed artifacts', async () => {
    const env = { HOME: projectRoot };

    const pull = await runCLI(['pull', '--force'], env, projectRoot);
    expect(pull.code, pull.output).toBe(0);
    for (const agentPath of managedAgentPaths) {
      expect(fs.existsSync(agentPath), `${agentPath}\n${pull.output}`).toBe(true);
    }
    expect(fs.existsSync(managedOpenclawSkill)).toBe(true);

    const dryRun = await runCLI(['uninstall', '--dry-run', '--force'], env, projectRoot);
    expect(dryRun.code, dryRun.output).toBe(0);
    for (const agentPath of managedAgentPaths) {
      expect(dryRun.output).toContain(agentPath);
    }
    expect(dryRun.output).toContain(managedOpenclawSkill);

    const uninstall = await runCLI(['uninstall', '--force'], env, projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    for (const agentPath of managedAgentPaths) {
      expect(fs.existsSync(agentPath), agentPath).toBe(false);
    }
    expect(fs.existsSync(managedOpenclawSkill)).toBe(false);
    expect(fs.existsSync(userAgent)).toBe(true);
    expect(fs.existsSync(userOpenclawSkill)).toBe(true);
  }, 60_000);
});
