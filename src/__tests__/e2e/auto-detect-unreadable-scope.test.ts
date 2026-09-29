import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end();
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function setup(): { sandbox: string; home: string; project: string; partitionConfig: string; userConfigPath: string; userRepo: string } {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-unreadable-scope-e2e-')));
  const home = path.join(sandbox, 'home');
  const project = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team-remote.git');
  const userRepo = path.join(home, '.teamai', 'team-repo');
  fs.mkdirSync(home);

  git(sandbox, 'init', '--bare', remote);
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'TeamAI CI');
  git(seed, 'config', 'user.email', 'ci@teamai.test');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'user-team', repo: remote, provider: 'git' }));
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  fs.mkdirSync(path.dirname(userRepo), { recursive: true });
  git(sandbox, 'clone', remote, userRepo);

  const userConfigPath = path.join(home, '.teamai', 'config.yaml');
  fs.writeFileSync(userConfigPath, YAML.stringify({
    repo: { kind: 'git', localPath: userRepo, remote },
    username: 'fixture',
    scope: 'user',
  }));

  fs.mkdirSync(project);
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'TeamAI CI');
  git(project, 'config', 'user.email', 'ci@teamai.test');
  fs.writeFileSync(path.join(project, 'README.md'), '# project\n');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'fixture');

  const partitionConfig = path.join(home, '.teamai', 'projects', projectSlug(fs.realpathSync(project)), 'config.yaml');
  fs.mkdirSync(path.dirname(partitionConfig), { recursive: true });
  fs.writeFileSync(partitionConfig, 'repo: [unclosed\n');
  return { sandbox, home, project, partitionConfig, userConfigPath, userRepo };
}

let sandbox = '';
afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = '';
});

describe('unreadable project config scope isolation', () => {
  it.each([
    ['push', ['--dry-run', 'push']],
    ['status', ['status']],
    ['uninstall', ['uninstall', '--dry-run', '--force']],
  ])('makes %s fail with the project config path instead of using user scope', async (_name, args) => {
    const fixture = setup();
    sandbox = fixture.sandbox;
    const userConfigBefore = fs.readFileSync(fixture.userConfigPath, 'utf8');
    const userRepoStatusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.userRepo, encoding: 'utf8' });

    const result = await runCLI(args, fixture.project, fixture.home);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(fixture.partitionConfig);
    expect(result.output).not.toContain('Scope: user');
    expect(fs.readFileSync(fixture.userConfigPath, 'utf8')).toBe(userConfigBefore);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fixture.userRepo, encoding: 'utf8' })).toBe(userRepoStatusBefore);
  });
});
