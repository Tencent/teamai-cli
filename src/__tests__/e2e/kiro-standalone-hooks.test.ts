import { expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { getDispatchCommand } from '../../builtin-hooks.js';
import { commitTeamRepo } from '../helpers/team-repo-history.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it('manages a Kiro default-agent lifecycle hook without any team agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kiro-standalone-'));
  try {
    const home = path.join(root, 'home');
    const seed = path.join(root, 'seed');
    const repo = path.join(home, '.teamai/team-repo');
    for (const dir of [seed, path.dirname(repo), path.join(home, '.kiro/hooks')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'kiro-hooks', repo: seed, provider: 'git', usageReport: false }));
    commitTeamRepo(seed);
    execFileSync('git', ['clone', '-q', seed, repo]);
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: seed }, username: 'tester', scope: 'user', enabledAgents: ['kiro'], updatePolicy: 'skip' }));
    const personal = path.join(home, '.kiro/hooks/personal.json');
    fs.writeFileSync(personal, '{"version":"v1","hooks":[]}\n');
    const file = path.join(home, '.kiro/hooks/teamai.json');
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 30_000 });
    const edited = path.join(home, '.kiro/agents/reviewer.json');
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.writeFileSync(edited, JSON.stringify({ name: 'reviewer', prompt: 'Member-edited prompt', hooks: { agentSpawn: [{ command: getDispatchCommand('session-start', 'kiro') }, { command: 'echo personal' }] } }));
    const otherRoot = path.join(root, 'project-b');
    const otherAgent = path.join(otherRoot, '.kiro/agents/reviewer.json');
    const otherPartition = path.join(home, '.teamai/projects/project-b');
    fs.mkdirSync(path.dirname(otherAgent), { recursive: true });
    fs.mkdirSync(otherPartition, { recursive: true });
    fs.writeFileSync(path.join(otherPartition, 'anchor'), otherRoot + '\n');
    fs.writeFileSync(otherAgent, fs.readFileSync(edited));
    const pull = run(['pull', '--force']);
    expect(pull.status, pull.stdout + pull.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(edited, 'utf8'))).toEqual({ name: 'reviewer', prompt: 'Member-edited prompt', hooks: { agentSpawn: [{ command: 'echo personal' }] } });
    expect(JSON.parse(fs.readFileSync(otherAgent, 'utf8'))).toEqual(JSON.parse(fs.readFileSync(edited, 'utf8')));
    expect(fs.existsSync(path.join(otherPartition, 'config.yaml'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 'v1', hooks: [{ trigger: 'SessionStart', action: { type: 'command' } }] });
    const list = run(['hooks', 'list']);
    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(list.stdout).toContain('~/.kiro/hooks/teamai.json');
    expect(list.stdout).toContain('teamai hook-dispatch session-start');
    const doctor = () => {
      const result = run(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
      return report.checks.find(check => check.name === 'teamai hooks in Kiro standalone hook file (requires Kiro CLI V3)');
    };
    expect(doctor()?.ok).toBe(true);
    expect(run(['hooks', 'remove']).status).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(doctor()?.ok).toBe(false);
    expect(run(['hooks', 'inject']).status).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    const uninstall = run(['uninstall', '--force']);
    expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(personal, 'utf8')).toBe('{"version":"v1","hooks":[]}\n');
    fs.writeFileSync(file, '{"version":"v1","hooks":[{"name":"personal"}]}\n');
    const refused = run(['hooks', 'inject']);
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).not.toContain('Hooks injected into all');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
