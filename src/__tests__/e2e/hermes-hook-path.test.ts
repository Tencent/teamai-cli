import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it.runIf(process.platform !== 'win32')('injects and runs the Hermes hook in a quoted home through the real CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-path-'));
  try {
    const home = path.join(root, 'home');
    const hermes = path.join(home, "member's Hermes home");
    const repo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(hermes, { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: hook-path\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'tester', scope: 'user', enabledAgents: ['hermes'], updatePolicy: 'skip' }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: hermes, FORCE_COLOR: '0' };
    const inject = spawnSync(process.execPath, [cli, 'hooks', 'inject'], { cwd: home, env, encoding: 'utf8' });
    expect(inject.status, inject.stdout + inject.stderr).toBe(0);
    const config = YAML.parse(fs.readFileSync(path.join(hermes, 'config.yaml'), 'utf8'));
    const command = config.hooks.on_session_start[0].command;
    const approved = JSON.parse(fs.readFileSync(path.join(hermes, 'shell-hooks-allowlist.json'), 'utf8'));
    expect(approved.approvals).toContainEqual({ event: 'on_session_start', command });
    const run = spawnSync('sh', ['-c', command], { cwd: home, env, input: JSON.stringify({ cwd: home, session_id: 'hermes-path-e2e' }), encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, '.teamai', 'debug.log'), 'utf8')).toContain('[hook-dispatch] session-start/hermes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
