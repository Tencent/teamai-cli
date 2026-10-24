import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it('runs the CLI-generated OpenClaw handler with an empty service PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-launch-'));
  try {
    const home = path.join(root, 'home with spaces');
    const state = path.join(home, '.openclaw');
    const workspace = path.join(state, 'workspace');
    const repo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace } } }));
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: openclaw-launch\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'tester', scope: 'user', enabledAgents: ['openclaw'], updatePolicy: 'skip' }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCLAW_STATE_DIR: state, FORCE_COLOR: '0' };
    const inject = spawnSync(process.execPath, [cli, 'hooks', 'inject'], { cwd: home, env, encoding: 'utf8' });
    expect(inject.status, inject.stdout + inject.stderr).toBe(0);
    const dir = path.join(workspace, 'hooks', 'teamai-status-report');
    const generated = fs.readFileSync(path.join(dir, 'handler.ts'), 'utf8');
    const compiled = path.join(dir, 'handler.test.mjs');
    fs.writeFileSync(compiled, transformSync(generated, { loader: 'ts', format: 'esm' }).code);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: handler } = await import(${JSON.stringify(pathToFileURL(compiled).href)});
      await handler({ type: 'command', action: 'new', sessionKey: 'openclaw-launch-e2e', context: { workspaceDir: ${JSON.stringify(home)} } });
    `], { cwd: home, env: { ...env, PATH: '' }, encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, '.teamai', 'debug.log'), 'utf8')).toContain('[hook-dispatch] session-start/openclaw');
    expect(generated).toContain('windowsHide: true');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
