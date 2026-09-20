import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const LOCAL_SERVER = 'team-local';
const HTTP_SERVER = 'team-http';
const USER_SERVER = 'my-own';
const COMMAND_TIMEOUT_MS = 60_000;
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
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end();
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

describe('Copilot MCP lifecycle (built CLI e2e)', () => {
  let sandbox: string;
  let homeDir: string;
  let copilotHome: string;
  let seedRepo: string;
  let localRepo: string;
  let remoteRepo: string;
  let settingsFile: string;
  let configFile: string;
  let env: Record<string, string>;

  const writeMcpYaml = (includeHttp: boolean): void => {
    const lines = [
      'servers:',
      `  - name: ${LOCAL_SERVER}`,
      '    transport: stdio',
      '    command: node',
      '    args: ["server.mjs"]',
      '    tools: [copilot]',
    ];
    if (includeHttp) {
      lines.push(
        `  - name: ${HTTP_SERVER}`,
        '    transport: http',
        '    url: https://example.com/mcp',
        '    tools: [copilot]',
      );
    }
    fs.writeFileSync(path.join(seedRepo, 'mcp', 'mcp.yaml'), lines.join('\n'));
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run npm run build first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-copilot-mcp-e2e-'));
    homeDir = path.join(sandbox, 'home');
    copilotHome = path.join(sandbox, 'copilot-home');
    seedRepo = path.join(sandbox, 'seed');
    localRepo = path.join(homeDir, '.teamai', 'team-repo');
    remoteRepo = path.join(sandbox, 'team-origin.git');
    settingsFile = path.join(copilotHome, 'settings.json');
    configFile = path.join(copilotHome, 'mcp-config.json');
    env = { HOME: homeDir, USERPROFILE: homeDir, COPILOT_HOME: copilotHome };

    fs.mkdirSync(path.join(copilotHome, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(seedRepo, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(seedRepo, 'teamai.yaml'), [
      'team: copilot-mcp-e2e',
      `repo: ${remoteRepo}`,
      'provider: git',
      'usageReport: false',
      'sharing:',
      '  env:',
      '    injectShellProfile: false',
    ].join('\n'));
    writeMcpYaml(true);
    git(['init', '--initial-branch=main'], seedRepo);
    git(['add', '.'], seedRepo);
    git(['commit', '-m', 'seed Copilot MCP fixture'], seedRepo);
    git(['init', '--bare', remoteRepo], sandbox);
    git(['remote', 'add', 'origin', remoteRepo], seedRepo);
    git(['push', '-u', 'origin', 'main'], seedRepo);
    fs.mkdirSync(path.dirname(localRepo), { recursive: true });
    git(['clone', '--branch', 'main', remoteRepo, localRepo], sandbox);
    fs.writeFileSync(path.join(homeDir, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
      'enabledAgents:',
      '  - copilot',
    ].join('\n'));
    fs.writeFileSync(settingsFile, '{"theme":"dark","telemetry":false}\n');
    fs.writeFileSync(configFile, JSON.stringify({
      custom: { keep: true },
      mcpServers: {
        [USER_SERVER]: { type: 'local', command: 'personal-server', tools: ['*'] },
      },
    }, null, 2));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('covers inject, pull reconciliation, remove, doctor, and uninstall without touching user config', async () => {
    const settingsHash = hash(settingsFile);
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

    const inject = await runCLI(['mcp', 'inject'], env, homeDir);
    expect(inject.code, inject.stdout + inject.stderr).toBe(0);
    expect(inject.stdout + inject.stderr).toMatch(/added\s+copilot\/team-local/);
    expect(readConfig().mcpServers[LOCAL_SERVER]).toEqual({
      type: 'local', command: 'node', args: ['server.mjs'], tools: ['*'],
    });
    expect(readConfig().mcpServers[HTTP_SERVER]).toEqual({
      type: 'http', url: 'https://example.com/mcp', tools: ['*'],
    });
    expect(hash(settingsFile)).toBe(settingsHash);

    const repeat = await runCLI(['mcp', 'inject'], env, homeDir);
    expect(repeat.code, repeat.stdout + repeat.stderr).toBe(0);
    expect(repeat.stdout + repeat.stderr).toContain('Already up to date.');

    const remove = await runCLI(['mcp', 'remove'], env, homeDir);
    expect(remove.code, remove.stdout + remove.stderr).toBe(0);
    expect(readConfig().mcpServers[LOCAL_SERVER]).toBeUndefined();
    expect(readConfig().mcpServers[HTTP_SERVER]).toBeUndefined();
    expect(readConfig().mcpServers[USER_SERVER]).toBeDefined();

    const pull = await runCLI(['pull', '--force'], env, homeDir);
    expect(pull.code, pull.stdout + pull.stderr).toBe(0);
    expect(readConfig().mcpServers[LOCAL_SERVER]).toBeDefined();
    expect(readConfig().mcpServers[HTTP_SERVER]).toBeDefined();

    writeMcpYaml(false);
    git(['add', 'mcp/mcp.yaml'], seedRepo);
    git(['commit', '-m', 'drop HTTP fixture'], seedRepo);
    git(['push', 'origin', 'main'], seedRepo);
    const reconcile = await runCLI(['pull', '--force'], env, homeDir);
    expect(reconcile.code, reconcile.stdout + reconcile.stderr).toBe(0);
    expect(readConfig().mcpServers[LOCAL_SERVER]).toBeDefined();
    expect(readConfig().mcpServers[HTTP_SERVER]).toBeUndefined();
    expect(readConfig().mcpServers[USER_SERVER]).toBeDefined();

    const manifest = JSON.parse(fs.readFileSync(path.join(homeDir, '.teamai', 'managed-mcp.json'), 'utf8'));
    expect(manifest.copilot).toEqual([expect.objectContaining({ name: LOCAL_SERVER })]);
    const doctor = await runCLI(['doctor', '--json'], env, homeDir);
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout).ok).toBe(true);
    expect(hash(settingsFile)).toBe(settingsHash);

    const uninstall = await runCLI(['uninstall', '--force'], env, homeDir);
    expect(uninstall.code, uninstall.stdout + uninstall.stderr).toBe(0);
    expect(readConfig().mcpServers[LOCAL_SERVER]).toBeUndefined();
    expect(readConfig().mcpServers[USER_SERVER]).toEqual({
      type: 'local', command: 'personal-server', tools: ['*'],
    });
    expect(hash(settingsFile)).toBe(settingsHash);
    expect(fs.existsSync(path.join(homeDir, '.teamai'))).toBe(false);
  }, 180_000);
});
