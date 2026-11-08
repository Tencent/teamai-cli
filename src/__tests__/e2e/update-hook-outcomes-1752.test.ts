import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const roots: string[] = [];
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('records repeated unsupported Stop updates as skipped and retains explicit manual advice', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-outcome-1752-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const data = path.join(home, '.teamai');
  const team = path.join(root, 'team');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  write(path.join(data, 'config.yaml'), YAML.stringify({
    scope: 'user', username: 'fixture', updatePolicy: 'auto',
    repo: { localPath: team, remote: 'https://example.invalid/team.git' },
  }));
  write(path.join(team, 'teamai.yaml'), 'team: fixture\nrepo: https://example.invalid/team.git\nprovider: git\nusageReport: false\n');
  write(path.join(data, 'state.json'), JSON.stringify({ lastUpdateCheck: new Date().toISOString(), availableUpdate: '99.0.0' }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    TEAMAI_NPM_REGISTRY: 'http://127.0.0.1:1', npm_config_fetch_retries: '0',
  };

  // The built CLI lives in a source checkout, so no real package installation can run.
  for (let i = 0; i < 3; i++) {
    const result = spawnSync(process.execPath, [CLI, 'hook-dispatch', 'stop', '--tool', 'claude', '--bg-only'], {
      cwd: app, env, input: JSON.stringify({ cwd: app, session_id: `update-fixture-${i}` }), encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain('Self-update');
  }
  const debugFile = path.join(data, 'debug.log');
  const debug = fs.readFileSync(debugFile, 'utf8');
  expect(debug.match(/update=\d+ms\(skipped\)/g)).toHaveLength(3);
  expect(debug).not.toMatch(/\[WARN\].*Self-update/);
  expect(debug).not.toContain('Updated teamai to');

  const manual = spawnSync(process.execPath, [CLI, 'update'], { cwd: app, env, encoding: 'utf8', timeout: 30_000 });
  expect(manual.status, manual.stdout + manual.stderr).toBe(0);
  expect(fs.readFileSync(debugFile, 'utf8')).toContain('Self-update skipped');
});
