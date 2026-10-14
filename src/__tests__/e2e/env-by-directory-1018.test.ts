import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── team env by directory (#1018), through the compiled CLI ────────────────
//
// Two projects from two team repos, each pulled in its own directory, as two
// agent windows open at once leave them. A shell started in either directory
// gets that project's env whichever pulled last, and `doctor` passes in both.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;

describe.skipIf(!hasZsh)('team env by directory through the real CLI (#1018)', () => {
  let sandbox: string;
  let home: string;
  const projects: Record<'a' | 'b', string> = { a: '', b: '' };

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: '/bin/zsh', FORCE_COLOR: '0' };
    for (const key of Object.keys(e)) if (key.startsWith('__TEAMAI_ENV_') || key === 'ZDOTDIR' || key === 'BASH_ENV') delete e[key];
    return e;
  };
  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, {
      cwd,
      env: { ...env(), GIT_AUTHOR_NAME: 'TeamAI E2E', GIT_AUTHOR_EMAIL: 'e2e@teamai.test', GIT_COMMITTER_NAME: 'TeamAI E2E', GIT_COMMITTER_EMAIL: 'e2e@teamai.test' },
      stdio: 'pipe',
    });
  };
  const teamai = (args: string[], cwd: string): { code: number | null; output: string } => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
    return { code: run.status, output: `${run.stdout}${run.stderr}` };
  };
  const shellSees = (dir: string, key = 'MARKER'): string =>
    spawnSync('zsh', ['-c', `printenv ${key} || true`], { cwd: dir, env: env(), encoding: 'utf-8' }).stdout.trim();

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-env-1018-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
    git(['config', '--global', 'protocol.file.allow', 'always'], sandbox);

    for (const name of ['a', 'b'] as const) {
      const url = `https://git.example.com/team/${name}.git`;
      const seed = path.join(sandbox, `seed-${name}`);
      fs.mkdirSync(path.join(seed, 'env'), { recursive: true });
      fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: team-${name}\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
      fs.writeFileSync(path.join(seed, 'env', 'env.yaml'), `variables:\n  - key: MARKER\n    value: from-${name}\n`);
      git(['init', '-q', '-b', 'main'], seed);
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'seed'], seed);
      const remote = path.join(sandbox, `${name}.git`);
      git(['clone', '-q', '--bare', seed, remote], sandbox);
      git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

      projects[name] = path.join(sandbox, 'work', name);
      fs.mkdirSync(projects[name], { recursive: true });
      git(['init', '-q', '-b', 'main'], projects[name]);
      const init = teamai(['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], projects[name]);
      expect(init.code, init.output).toBe(0);
      // init does not pull: the first pull registers the project.
      const pull = teamai(['pull'], projects[name]);
      expect(pull.code, pull.output).toBe(0);
    }
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('gives a shell in each project its own env, whichever pulled last', () => {
    for (const last of ['a', 'b', 'a'] as const) {
      expect(teamai(['pull'], projects[last]).code).toBe(0);
      expect(shellSees(projects.a)).toBe('from-a');
      expect(shellSees(projects.b)).toBe('from-b');
    }
  });

  it('passes the env checks of doctor in each project', () => {
    for (const name of ['a', 'b'] as const) {
      const { output } = teamai(['doctor'], projects[name]);
      expect(output).toContain('✔ Env variables injected in shell profile');
      expect(output).toContain('✔ This directory resolves its team env');
    }
  });

  it('registers a first-pulled project with no env when env.yaml is malformed', () => {
    const userUrl = 'https://git.example.com/team/user.git';
    const userSeed = path.join(sandbox, 'seed-user');
    fs.mkdirSync(path.join(userSeed, 'env'), { recursive: true });
    fs.writeFileSync(path.join(userSeed, 'teamai.yaml'), `team: team-user\nrepo: ${userUrl}\nprovider: git\nreviewers: []\n`);
    fs.writeFileSync(path.join(userSeed, 'env', 'env.yaml'), 'variables:\n  - key: USER_TOKEN\n    value: user-secret\n  - key: TOKEN\n    value: inherited-secret\n');
    git(['init', '-q', '-b', 'main'], userSeed);
    git(['add', '-A'], userSeed);
    git(['commit', '-q', '-m', 'seed'], userSeed);
    const userRemote = path.join(sandbox, 'user.git');
    git(['clone', '-q', '--bare', userSeed, userRemote], sandbox);
    git(['config', '--global', `url.${userRemote}.insteadOf`, userUrl], sandbox);
    const userRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.dirname(userRepo), { recursive: true });
    git(['clone', '-q', userUrl, userRepo], sandbox);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${userRepo}`, `  remote: ${userUrl}`, 'username: member', 'scope: user', '',
    ].join('\n'));

    const userPull = teamai(['pull'], sandbox);
    expect(userPull.code, userPull.output).toBe(0);
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    expect(shellSees(outside, 'USER_TOKEN'), userPull.output).toBe('user-secret');

    const badUrl = 'https://git.example.com/team/bad-env.git';
    const badSeed = path.join(sandbox, 'seed-bad-env');
    fs.mkdirSync(path.join(badSeed, 'env'), { recursive: true });
    fs.writeFileSync(path.join(badSeed, 'teamai.yaml'), `team: team-bad-env\nrepo: ${badUrl}\nprovider: git\nreviewers: []\n`);
    fs.writeFileSync(path.join(badSeed, 'env', 'env.yaml'), 'variables: [\n');
    git(['init', '-q', '-b', 'main'], badSeed);
    git(['add', '-A'], badSeed);
    git(['commit', '-q', '-m', 'seed'], badSeed);
    const badRemote = path.join(sandbox, 'bad-env.git');
    git(['clone', '-q', '--bare', badSeed, badRemote], sandbox);
    git(['config', '--global', `url.${badRemote}.insteadOf`, badUrl], sandbox);

    const badProject = path.join(sandbox, 'work', 'bad-env');
    fs.mkdirSync(path.join(badProject, '.teamai'), { recursive: true });
    git(['init', '-q', '-b', 'main'], badProject);
    const badRepo = path.join(badProject, '.teamai', 'team-repo');
    git(['clone', '-q', badUrl, badRepo], badProject);
    fs.writeFileSync(path.join(badProject, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${badRepo}`, `  remote: ${badUrl}`, 'username: member', 'scope: project',
      `projectRoot: ${badProject}`, '',
    ].join('\n'));

    const badPull = teamai(['pull'], badProject);
    expect(badPull.code, badPull.output).toBe(0);
    expect(badPull.output).toMatch(/env\/env\.yaml is not valid YAML/);
    expect(shellSees(badProject, 'USER_TOKEN')).toBe('');
    expect(shellSees(outside, 'USER_TOKEN')).toBe('user-secret');

    const inheritedUrl = 'https://git.example.com/team/inherited.git';
    const inheritedSeed = path.join(sandbox, 'seed-inherited');
    fs.mkdirSync(path.join(inheritedSeed, 'env'), { recursive: true });
    fs.writeFileSync(path.join(inheritedSeed, 'teamai.yaml'), `team: team-inherited\nrepo: ${inheritedUrl}\nprovider: git\nreviewers: []\n`);
    fs.writeFileSync(path.join(inheritedSeed, 'env', 'env.yaml'), 'variables:\n  - key: OTHER\n    value: project-value\n');
    fs.writeFileSync(path.join(inheritedSeed, 'env', 'secrets.yaml'), 'secrets:\n  - key: TOKEN\n');
    git(['init', '-q', '-b', 'main'], inheritedSeed);
    git(['add', '-A'], inheritedSeed);
    git(['commit', '-q', '-m', 'seed'], inheritedSeed);
    const inheritedRemote = path.join(sandbox, 'inherited.git');
    git(['clone', '-q', '--bare', inheritedSeed, inheritedRemote], sandbox);
    git(['config', '--global', `url.${inheritedRemote}.insteadOf`, inheritedUrl], sandbox);

    const inheritedProject = path.join(sandbox, 'work', 'inherited');
    fs.mkdirSync(path.join(inheritedProject, '.teamai'), { recursive: true });
    git(['init', '-q', '-b', 'main'], inheritedProject);
    const inheritedRepo = path.join(inheritedProject, '.teamai', 'team-repo');
    git(['clone', '-q', inheritedUrl, inheritedRepo], inheritedProject);
    fs.writeFileSync(path.join(inheritedProject, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${inheritedRepo}`, `  remote: ${inheritedUrl}`, 'username: member', 'scope: project',
      `projectRoot: ${inheritedProject}`, 'inheritUserScope: true', '',
    ].join('\n'));

    const inheritedPull = teamai(['pull'], inheritedProject);
    expect(inheritedPull.code, inheritedPull.output).toBe(0);
    expect(shellSees(inheritedProject, 'TOKEN')).toBe('');
    const inheritedRow = fs.readFileSync(path.join(home, '.teamai', 'env-scopes'), 'utf-8').split('\n')
      .find((line) => line.split('\t')[1]?.startsWith(inheritedProject));
    expect(inheritedRow, inheritedPull.output).toBeDefined();
    fs.rmSync(inheritedRow!.split('\t')[2], { force: true });
    expect(shellSees(inheritedProject, 'TOKEN')).toBe('');
  });
});
