import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
it('self init and hooks inject use the HOME config seen by hooks list and doctor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-self-e2e-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid', FORCE_COLOR: '0' };
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8', timeout: 45000 });
  try {
    git(['init', '-q', '-b', 'main']); git(['commit', '-qm', 'fixture', '--allow-empty']);
    git(['remote', 'add', 'origin', 'https://127.0.0.1:9/team/test.git']);
    const init = run(['init', '.', '--provider', 'git', '--agent', 'zcode', '--force']);
    expect(init.status, init.stdout + init.stderr).toBe(0);
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    expect(fs.readFileSync(file, 'utf8')).toContain('teamai hook-dispatch session-start --tool zcode');
    expect(fs.existsSync(path.join(project, '.zcode', 'cli', 'config.json'))).toBe(false);
    const teamFile = path.join(project, '.teamai', 'teamai.yaml');
    const team = YAML.parse(fs.readFileSync(teamFile, 'utf8'));
    team.sharing = { ...team.sharing, hooks: { requireTeamScripts: false, autoApply: true } };
    fs.writeFileSync(teamFile, YAML.stringify(team));
    fs.mkdirSync(path.join(project, '.teamai', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai', 'hooks', 'hooks.yaml'), 'hooks:\n  - id: fixture-stop\n    description: Self test hook\n    event: Stop\n    command: echo self-team-fixture\n');
    const inject = run(['hooks', 'inject']);
    expect(inject.status, inject.stdout + inject.stderr).toBe(0);
    const list = run(['hooks', 'list']);
    expect(list.stdout).toContain('installed');
    const report = JSON.parse(run(['doctor', '--json']).stdout) as { checks: { name: string; ok: boolean }[] };
    expect(report.checks.find(check => check.name === 'teamai hooks in zcode settings')?.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('self-team-fixture');
    const removed = run(['hooks', 'remove']);
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('self-team-fixture');
    expect(fs.readFileSync(file, 'utf8')).toContain('teamai hook-dispatch session-start');
    expect(run(['hooks', 'inject']).status).toBe(0);
    const uninstall = run(['uninstall', '--agent', 'zcode', '--force']);
    expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('self-team-fixture');
    expect(fs.readFileSync(file, 'utf8')).toContain('teamai hook-dispatch session-start');
    const pulled = run(['pull']);
    expect(pulled.status, pulled.stdout + pulled.stderr).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('self-team-fixture');

  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
