import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const COMMAND_TIMEOUT_MS = 120_000;
const TEAM_AGENT = 'frontend-reviewer';
const USER_AGENT = 'personal-agent';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, COMMAND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: 'pipe',
  });
}

function hash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('Copilot custom-agent lifecycle (built CLI E2E)', () => {
  let sandbox: string;
  let homeDir: string;
  let copilotHome: string;
  let seedRepo: string;
  let localRepo: string;
  let remoteRepo: string;
  let settingsFile: string;
  let configFile: string;
  let env: Record<string, string>;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run npm run build first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-copilot-agents-e2e-'));
    homeDir = path.join(sandbox, 'home');
    copilotHome = path.join(sandbox, 'copilot-home');
    seedRepo = path.join(sandbox, 'seed');
    localRepo = path.join(homeDir, '.teamai', 'team-repo');
    remoteRepo = path.join(sandbox, 'team-origin.git');
    settingsFile = path.join(copilotHome, 'settings.json');
    configFile = path.join(homeDir, '.teamai', 'config.yaml');
    env = { HOME: homeDir, USERPROFILE: homeDir, COPILOT_HOME: copilotHome };

    fs.mkdirSync(path.join(copilotHome, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(seedRepo, 'agents', 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(seedRepo, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(seedRepo, 'teamai.yaml'), [
      'team: copilot-agents-e2e',
      `repo: ${remoteRepo}`,
      'provider: git',
      'usageReport: false',
      'sharing:',
      '  recall:',
      '    enabled: true',
      '  env:',
      '    injectShellProfile: false',
    ].join('\n'));
    fs.writeFileSync(path.join(seedRepo, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: frontend',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '      agents: [frontend]',
      '  - id: backend',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '      agents: []',
    ].join('\n'));
    fs.writeFileSync(path.join(seedRepo, 'agents', 'frontend', `${TEAM_AGENT}.yaml`), [
      `name: ${TEAM_AGENT}`,
      'description: Review frontend changes',
      'instructions: Review the frontend change and report defects.',
      'tools: [Read, Grep, Glob]',
      'targets: [copilot]',
    ].join('\n'));
    git(['init', '--initial-branch=main'], seedRepo);
    git(['add', '.'], seedRepo);
    git(['commit', '-m', 'seed Copilot agents fixture'], seedRepo);
    git(['init', '--bare', remoteRepo], sandbox);
    git(['remote', 'add', 'origin', remoteRepo], seedRepo);
    git(['push', '-u', 'origin', 'main'], seedRepo);
    fs.mkdirSync(path.dirname(localRepo), { recursive: true });
    git(['clone', '--branch', 'main', remoteRepo, localRepo], sandbox);
    fs.writeFileSync(configFile, [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
      'primaryRole: frontend',
      'enabledAgents:',
      '  - copilot',
    ].join('\n'));
    fs.writeFileSync(settingsFile, '{"theme":"dark","telemetry":false}\n');
    fs.writeFileSync(
      path.join(copilotHome, 'agents', `${USER_AGENT}.agent.md`),
      '---\ndescription: Personal agent\n---\nKeep this user profile.\n',
    );
    fs.writeFileSync(path.join(copilotHome, 'agents', 'teamai-recall.md'), 'stale TeamAI profile\n');
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pulls, reconciles roles, and uninstalls only TeamAI-owned Copilot profiles', async () => {
    const settingsHash = hash(settingsFile);
    const userAgent = path.join(copilotHome, 'agents', `${USER_AGENT}.agent.md`);
    const userAgentHash = hash(userAgent);
    const teamAgent = path.join(copilotHome, 'agents', `${TEAM_AGENT}.agent.md`);
    const recallAgent = path.join(copilotHome, 'agents', 'teamai-recall.agent.md');

    const pull = await runCLI(['pull', '--force'], env, homeDir);
    expect(pull.code, pull.stdout + pull.stderr).toBe(0);
    expect(fs.existsSync(teamAgent)).toBe(true);
    expect(fs.existsSync(recallAgent)).toBe(true);
    expect(fs.existsSync(path.join(copilotHome, 'agents', 'teamai-recall.md'))).toBe(false);
    expect(fs.readFileSync(teamAgent, 'utf8')).toContain('tools:\n  - read\n  - search');
    expect(fs.readFileSync(recallAgent, 'utf8')).toContain('tools:\n  - execute\n  - read\n  - search');
    const teamAgentHash = hash(teamAgent);
    const recallAgentHash = hash(recallAgent);

    const repeat = await runCLI(['pull', '--force'], env, homeDir);
    expect(repeat.code, repeat.stdout + repeat.stderr).toBe(0);
    expect(hash(teamAgent)).toBe(teamAgentHash);
    expect(hash(recallAgent)).toBe(recallAgentHash);
    expect(hash(userAgent)).toBe(userAgentHash);
    expect(hash(settingsFile)).toBe(settingsHash);

    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('primaryRole: frontend', 'primaryRole: backend'));
    const roleChange = await runCLI(['pull', '--force'], env, homeDir);
    expect(roleChange.code, roleChange.stdout + roleChange.stderr).toBe(0);
    expect(fs.existsSync(teamAgent)).toBe(false);
    expect(fs.existsSync(recallAgent)).toBe(true);
    expect(hash(userAgent)).toBe(userAgentHash);

    const uninstall = await runCLI(['uninstall', '--force'], env, homeDir);
    expect(uninstall.code, uninstall.stdout + uninstall.stderr).toBe(0);
    expect(fs.existsSync(recallAgent)).toBe(false);
    expect(fs.existsSync(userAgent)).toBe(true);
    expect(hash(userAgent)).toBe(userAgentHash);
    expect(hash(settingsFile)).toBe(settingsHash);
  }, 180_000);
});
