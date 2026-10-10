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
  const git = (args: string[], cwd: string): void => { execFileSync('git', args, { cwd, env: env(), stdio: 'pipe' }); };
  const teamai = (args: string[], cwd: string): { code: number | null; output: string } => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
    return { code: run.status, output: `${run.stdout}${run.stderr}` };
  };
  const shellSees = (dir: string): string =>
    spawnSync('zsh', ['-c', 'printenv MARKER || true'], { cwd: dir, env: env(), encoding: 'utf-8' }).stdout.trim();

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
});
