import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEAMAI_CLI = path.join(ROOT, 'dist', 'index.js');
const OPENCODE_INSTALL = path.join(ROOT, 'node_modules', 'opencode-ai', 'postinstall.mjs');
const OPENCODE_CLI = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
);

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

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
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

describe('OpenCode recall startup (#332)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;

  beforeAll(() => {
    if (!fs.existsSync(TEAMAI_CLI)) {
      throw new Error(`TeamAI CLI not found at ${TEAMAI_CLI}. Run "npm run build" first.`);
    }
    execFileSync(process.execPath, [OPENCODE_INSTALL], { cwd: ROOT, stdio: 'pipe' });
    if (!fs.existsSync(OPENCODE_CLI)) {
      throw new Error(`OpenCode CLI not found at ${OPENCODE_CLI}. Run "npm ci" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue332-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const remote = path.join(sandbox, 'team-remote');
    const localRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    fs.writeFileSync(
      path.join(remote, 'teamai.yaml'),
      [
        'team: issue-332-e2e',
        'description: OpenCode recall E2E fixture',
        `repo: ${remote}`,
        'provider: tgit',
        'sharing:',
        '  recall:',
        '    enabled: true',
        'toolPaths:',
        '  opencode:',
        '    skills: .opencode/skills',
        '    rules: .opencode/rules',
        '    agents: .opencode/agents',
      ].join('\n'),
    );

    git(['init', '-q'], remote);
    git(['add', '-A'], remote);
    git(['commit', '-q', '-m', 'fixture'], remote);

    fs.mkdirSync(projectRoot, { recursive: true });
    git(['clone', '-q', remote, localRepo], sandbox);
    fs.mkdirSync(path.join(projectRoot, '.opencode'), { recursive: true });
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
        '  - opencode',
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects the old artifact, then starts with every generated agent', async () => {
    const env = { HOME: homeDir };
    const agentsDir = path.join(projectRoot, '.opencode', 'agents');

    fs.mkdirSync(agentsDir, { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'agents', 'teamai-recall.md'),
      path.join(agentsDir, 'teamai-recall.md'),
    );
    const brokenStartup = await run(OPENCODE_CLI, ['debug', 'config', '--pure'], env, projectRoot);
    expect(brokenStartup.code, brokenStartup.output).not.toBe(0);
    expect(brokenStartup.output).toContain('tools');
    fs.rmSync(path.join(agentsDir, 'teamai-recall.md'));

    const enable = await run('node', [TEAMAI_CLI, 'recall', 'enable'], env, projectRoot);
    expect(enable.code, enable.output).toBe(0);

    const pull = await run('node', [TEAMAI_CLI, 'pull', '--force'], env, projectRoot);
    expect(pull.code, pull.output).toBe(0);

    const agentFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md'));
    expect(agentFiles).toContain('teamai-recall.md');

    for (const file of agentFiles) {
      const agentName = path.basename(file, '.md');
      const validation = await run(
        OPENCODE_CLI,
        ['debug', 'agent', agentName, '--pure'],
        env,
        projectRoot,
      );
      expect(validation.code, `${file}:\n${validation.output}`).toBe(0);
    }

    const startup = await run(OPENCODE_CLI, ['debug', 'config', '--pure'], env, projectRoot);
    expect(startup.code, startup.output).toBe(0);
  }, 30_000);
});
