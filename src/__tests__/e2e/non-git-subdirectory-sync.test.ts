import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox = '';

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

it('delivers a session-start pull to the non-git workspace root when Claude or Cursor opens a subdirectory', () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-subdir-sync-')));
  const home = path.join(sandbox, 'home');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'team.git');
  const workspace = path.join(sandbox, 'workspace');
  const sub = path.join(workspace, 'packages', 'app', 'src');
  const data = path.join(workspace, '.teamai');
  const repo = path.join(data, 'team-repo');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  fs.mkdirSync(home);
  fs.mkdirSync(seed);
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(data);
  git(sandbox, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.com');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
    team: 'subdirectory-fixture', repo: remote, provider: 'git', sharing: { gitExclude: { enabled: false } },
  }));
  fs.mkdirSync(path.join(seed, 'env'));
  fs.writeFileSync(path.join(seed, 'env', 'env.yaml'), 'variables:\n  - key: SUBDIR_ENV_PROOF\n    value: workspace-env\n');
  fs.mkdirSync(path.join(seed, 'skills', 'subdir-proof'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'skills', 'subdir-proof', 'SKILL.md'),
    '---\nname: subdir-proof\ndescription: Verify subdirectory delivery\n---\nSUBDIRECTORY_SYNC_PROOF\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(sandbox, 'clone', remote, repo);
  fs.writeFileSync(path.join(data, 'config.yaml'), YAML.stringify({
    repo: { kind: 'git', localPath: repo, remote }, username: 'fixture',
    scope: 'workspace', projectRoot: workspace, enabledAgents: ['claude', 'cursor'],
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };

  for (const tool of ['claude', 'cursor']) {
    const root = path.join(workspace, tool === 'claude' ? '.claude' : '.cursor');
    fs.mkdirSync(root, { recursive: true });
    const payload = tool === 'claude' ? { cwd: sub } : { workspace_roots: [sub] };
    const result = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', tool, '--bg-only'], {
      cwd: tool === 'claude' ? sub : home, env, encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ ...payload, session_id: `subdir-${tool}`, hook_event_name: 'SessionStart' }),
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    const skills = path.join(root, 'skills');
    const proof = fs.readdirSync(skills).find((name) => name.includes('subdir-proof'));

    expect(proof).toBeDefined();
    expect(fs.readFileSync(path.join(skills, proof!, 'SKILL.md'), 'utf8')).toContain('SUBDIRECTORY_SYNC_PROOF');
  }

  const cliEnv = spawnSync(process.execPath, [CLI, 'env', 'exec', '--', 'bash', '-c', 'printf "%s" "$SUBDIR_ENV_PROOF"'], {
    cwd: sub, env, encoding: 'utf8', timeout: 60_000,
  });

  expect(cliEnv.status, cliEnv.stdout + cliEnv.stderr).toBe(0);
  expect(cliEnv.stdout.trim()).toBe('workspace-env');
  const shellEnv = spawnSync('bash', ['-c', 'printf "%s" "$SUBDIR_ENV_PROOF"'], {
    cwd: sub, env: { ...env, BASH_ENV: path.join(home, '.teamai', 'env-loader.sh') }, encoding: 'utf8', timeout: 60_000,
  });

  expect(shellEnv.status, shellEnv.stderr).toBe(0);
  expect(shellEnv.stdout).toBe(cliEnv.stdout.trim());
  expect(fs.existsSync(path.join(sub, '.teamai'))).toBe(false);
  expect(fs.existsSync(path.join(sub, '.claude'))).toBe(false);
  expect(fs.existsSync(path.join(sub, '.cursor'))).toBe(false);
}, 120_000);
