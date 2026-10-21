import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import { managedMcpManifestPath, managedMcpWorkspaceId } from '../../types.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

it('real CLI retries a failed migration and updates servers owned by both legacy manifests', async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mcp-migration-cli-')));
  const home = path.join(sandbox, 'home');
  const workspace = path.join(sandbox, 'app');
  const repo = path.join(sandbox, 'team');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'mcp'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace, windowsHide: true });
  const dataHome = await resolveProjectDataHome(workspace);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(dataHome, 'config.yaml'), YAML.stringify({
    repo: { localPath: repo, remote: 'https://example.invalid/team.git', kind: 'git' },
    username: 'tester', scope: 'project', agents: ['claude'], updatePolicy: 'skip',
  }));
  write(path.join(repo, 'teamai.yaml'), YAML.stringify({
    team: 'migration-test', repo: 'https://example.invalid/team.git', provider: 'git', usageReport: false,
  }));
  const names = ['partition-server', 'workspace-server'];
  write(path.join(repo, 'mcp', 'mcp.yaml'), YAML.stringify({
    servers: names.map((name) => ({ name, transport: 'http', url: `https://example.invalid/${name}/v2`, tools: ['claude'] })),
  }));
  const mcp = path.join(workspace, '.mcp.json');
  const member = { type: 'http', url: 'https://example.invalid/member' };
  write(mcp, JSON.stringify({ mcpServers: {
    ...Object.fromEntries(names.map((name) => [name, { type: 'http', url: `https://example.invalid/${name}/v1` }])),
    member,
  } }));
  const partitionManifest = path.join(dataHome, 'managed-mcp.json');
  const localManifest = path.join(workspace, '.teamai', 'managed-mcp.json');
  write(partitionManifest, JSON.stringify({
    [`claude:project:${managedMcpWorkspaceId(workspace)}`]: [{ name: names[0], hash: 'old' }],
    'claude:project:other': [{ name: 'other', hash: 'other' }],
  }));
  write(localManifest, JSON.stringify({ 'claude:project': [{ name: names[1], hash: 'old' }] }));

  const destination = managedMcpManifestPath(dataHome, workspace);
  const preload = path.join(sandbox, 'fail-migration.cjs');
  const marker = path.join(sandbox, 'failure-injected');
  write(preload, `
const fs = require('node:fs');
const rename = fs.rename;
fs.rename = function (from, to, callback) {
  if (to === ${JSON.stringify(destination)} && fs.readFileSync(from, 'utf8').includes('workspace-server')) {
    fs.writeFileSync(${JSON.stringify(marker)}, 'injected');
    const error = Object.assign(new Error('injected migration rename failure'), { code: 'EIO' });
    return process.nextTick(callback, error);
  }
  return rename.call(this, from, to, callback);
};
`);
  const before = [partitionManifest, localManifest].map((file) => fs.readFileSync(file, 'utf8'));
  const failed = spawnSync(process.execPath, ['--require', preload, cli, 'mcp', 'inject'], {
    cwd: workspace, env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  expect(failed.error).toBeUndefined();
  expect(fs.existsSync(marker), `${failed.stdout}${failed.stderr}`).toBe(true);
  expect(fs.existsSync(destination)).toBe(false);
  expect([partitionManifest, localManifest].map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);

  const run = spawnSync(process.execPath, [cli, 'mcp', 'inject'], {
    cwd: workspace, env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  const servers = JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers;
  for (const name of names) expect(servers[name].url).toBe(`https://example.invalid/${name}/v2`);
  expect(servers.member).toEqual(member);
  const manifest = JSON.parse(fs.readFileSync(managedMcpManifestPath(dataHome, workspace), 'utf8'));
  expect(manifest['claude:project'].map((record: { name: string }) => record.name).sort()).toEqual(names.sort());
  expect(JSON.parse(fs.readFileSync(partitionManifest, 'utf8'))).toEqual({
    'claude:project:other': [{ name: 'other', hash: 'other' }],
  });
  expect(JSON.parse(fs.readFileSync(localManifest, 'utf8'))).toEqual({});
}, 45_000);
