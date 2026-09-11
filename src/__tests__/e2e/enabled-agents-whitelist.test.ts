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

function runCLI(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
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

describe('enabledAgents whitelist on real CLI pull (#510)', () => {
  let sandbox: string;
  let homeDir: string;
  let localRepo: string;
  let configPath: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue510-e2e-'));
    homeDir = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'team-remote');
    localRepo = path.join(homeDir, '.teamai', 'team-repo');
    configPath = path.join(homeDir, '.teamai', 'config.yaml');

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(remote, 'skills', 'team-skill'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'claudemd', 'common'), { recursive: true });

    fs.writeFileSync(
      path.join(remote, 'teamai.yaml'),
      [
        'team: issue-510-e2e',
        `repo: ${remote}`,
        'provider: git',
        'sharing:',
        '  recall:',
        '    enabled: true',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(remote, 'skills', 'team-skill', 'SKILL.md'),
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n',
    );
    fs.writeFileSync(
      path.join(remote, 'culture.md'),
      '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n',
    );
    fs.writeFileSync(
      path.join(remote, 'claudemd', 'common', 'note.md'),
      'Shared team instructions.\n',
    );

    git(['init', '-q'], remote);
    git(['add', '-A'], remote);
    git(['commit', '-q', '-m', 'fixture'], remote);

    git(['clone', '-q', remote, localRepo], sandbox);

    fs.mkdirSync(path.join(homeDir, '.workbuddy'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.hermes'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.codebuddy'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), '# User notes\n');

    fs.writeFileSync(
      configPath,
      [
        'repo:',
        `  localPath: ${localRepo}`,
        `  remote: ${remote}`,
        'username: ci-user',
        'updatePolicy: auto',
        'scope: user',
        'recallEnabled: true',
        'enabledAgents:',
        '  - workbuddy',
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('does not write builtins, team skills, or CLAUDE.md injects outside the whitelist', async () => {
    const env = { HOME: homeDir };
    const first = await runCLI(['pull'], env, sandbox);
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toContain('Already synced');

    expect(fs.existsSync(path.join(homeDir, '.workbuddy', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.workbuddy', 'skills', 'team-wiki-codebase', 'SKILL.md'))).toBe(true);

    expect(fs.existsSync(path.join(homeDir, '.hermes', 'skills', 'team-skill'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.hermes', 'skills', 'team-wiki-codebase'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.codebuddy', 'skills', 'team-skill'))).toBe(false);

    const codebuddyMd = fs.readFileSync(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), 'utf8');
    expect(codebuddyMd).toBe('# User notes\n');
    expect(codebuddyMd).not.toContain('[teamai:culture:start]');
    expect(codebuddyMd).not.toContain('[teamai:claudemd:start]');
    expect(codebuddyMd).not.toContain('[teamai:recall-rules:start]');

    expect(JSON.parse(
      fs.readFileSync(path.join(homeDir, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['workbuddy']);

    fs.writeFileSync(
      configPath,
      [
        'repo:',
        `  localPath: ${localRepo}`,
        `  remote: ${path.join(sandbox, 'team-remote')}`,
        'username: ci-user',
        'updatePolicy: auto',
        'scope: user',
        'recallEnabled: true',
        'enabledAgents:',
        '  - workbuddy',
        '  - claude',
      ].join('\n'),
    );

    const second = await runCLI(['pull'], env, sandbox);
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('Already synced');
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(
      fs.readFileSync(path.join(homeDir, '.teamai', 'state.json'), 'utf8'),
    ).lastPullTargets).toEqual(['claude', 'workbuddy']);

    const third = await runCLI(['pull'], env, sandbox);
    expect(third.code, third.output).toBe(0);
    expect(third.output).toContain('Already synced');
  }, 60_000);
});
