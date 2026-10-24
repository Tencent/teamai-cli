import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it('runs the CLI-generated OpenCode plugin with an empty service PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-opencode-launch-'));
  try {
    const home = path.join(root, 'home with spaces');
    const repo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: opencode-launch\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: 'https://example.invalid/team.git' },
      username: 'tester', scope: 'user', enabledAgents: ['opencode'], updatePolicy: 'skip',
    }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' };
    const inject = spawnSync(process.execPath, [cli, 'hooks', 'inject'], { cwd: home, env, encoding: 'utf8' });
    expect(inject.status, inject.stdout + inject.stderr).toBe(0);
    const plugin = path.join(home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts');
    const compiled = plugin.replace(/\.ts$/, '.test.mjs');
    fs.copyFileSync(plugin, compiled);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: plugin } = await import(${JSON.stringify(pathToFileURL(compiled).href)});
      const hooks = await plugin.server({ directory: ${JSON.stringify(home)} });
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: 'opencode-launch-e2e' } } });
    `], { cwd: home, env: { ...env, PATH: '' }, encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, '.teamai', 'debug.log'), 'utf8')).toContain('[hook-dispatch] session-start/opencode');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
