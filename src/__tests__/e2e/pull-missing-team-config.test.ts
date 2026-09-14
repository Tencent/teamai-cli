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

describe('real CLI: pull self-heals a clone missing teamai.yaml', () => {
  let sandbox: string;
  let homeDir: string;
  let localRepo: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-missing-config-e2e-'));
    homeDir = path.join(sandbox, 'home');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');
    localRepo = path.join(homeDir, '.teamai', 'team-repo');

    // Remote main: first commit has only a skill, second adds teamai.yaml
    // (e.g. an admin merged it after the member's copy was lost).
    fs.mkdirSync(path.join(seed, 'skills', 'team-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(seed, 'skills', 'team-skill', 'SKILL.md'),
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n',
    );
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'skills only'], seed);
    fs.writeFileSync(
      path.join(seed, 'teamai.yaml'),
      ['team: missing-config-e2e', `repo: ${remote}`, 'provider: git', ''].join('\n'),
    );
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'add teamai.yaml'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    // Local clone is one commit behind: no teamai.yaml on disk.
    git(['clone', '-q', remote, localRepo], sandbox);
    git(['reset', '-q', '--hard', 'HEAD~1'], localRepo);

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

  it('pull --force fetches the missing teamai.yaml and syncs to every installed agent', async () => {
    expect(fs.existsSync(path.join(localRepo, 'teamai.yaml'))).toBe(false);

    const result = await runCLI(['pull', '--force'], homeDir, sandbox);

    expect(result.output).not.toContain('teamai.yaml) not found');
    expect(fs.existsSync(path.join(localRepo, 'teamai.yaml'))).toBe(true);
    for (const skillsDir of ['.claude/skills', '.codex/skills', '.codebuddy/skills', '.config/opencode/skills']) {
      expect(
        fs.existsSync(path.join(homeDir, skillsDir, 'team-skill', 'SKILL.md')),
        `${skillsDir}\n${result.output}`,
      ).toBe(true);
    }
  }, 60_000);
});
