import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import YAML from 'yaml';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
const roots: string[] = [];
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('shares the registry version between different CLI versions and refreshes a legacy null once', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-cache-1751-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const data = path.join(home, '.teamai');
  const team = path.join(root, 'team');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  write(path.join(data, 'config.yaml'), YAML.stringify({
    scope: 'user', username: 'fixture', updatePolicy: 'skip',
    repo: { localPath: team, remote: 'https://example.invalid/team.git' },
  }));
  write(path.join(team, 'teamai.yaml'), 'team: fixture\nrepo: https://example.invalid/team.git\nprovider: git\nusageReport: false\n');

  // Identical build, separate package metadata: each CLI reads its own installed version.
  const entry = (version: string) => {
    const pkg = path.join(root, version);
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    for (const file of ['index.js', 'cli.js']) fs.copyFileSync(path.join(path.dirname(CLI), file), path.join(pkg, 'dist', file));
    write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'teamai-cli', version, type: 'module' }));
    fs.symlinkSync(path.resolve(path.dirname(CLI), '../node_modules'), path.join(pkg, 'node_modules'), 'junction');
    return path.join(pkg, 'dist/index.js');
  };
  const newer = entry('0.29.0');
  const older = entry('0.28.1');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify({ name: 'teamai-cli', 'dist-tags': { latest: '0.29.0' }, versions: {
      '0.29.0': { name: 'teamai-cli', version: '0.29.0' },
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    TEAMAI_NPM_REGISTRY: `http://127.0.0.1:${port}`, npm_config_cache: path.join(root, 'npm-cache'),
  };
  const run = (script: string, args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: app, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject).on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
    child.stdin.end(JSON.stringify({ cwd: app, session_id: 'cache-fixture' }));
  });
  const stateFile = path.join(data, 'state.json');
  const state = () => z.object({ availableUpdate: z.string().nullable() }).parse(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  const stop = ['hook-dispatch', 'stop', '--tool', 'claude', '--bg-only'];

  try {
    expect(await run(newer, ['update', '--check'])).toContain('Already up to date (v0.29.0)');
    expect(state().availableUpdate).toBe('0.29.0');
    const afterCheck = requests;
    expect(afterCheck).toBeGreaterThan(0);
    await run(older, stop);
    expect(requests).toBe(afterCheck);
    const debug = fs.readFileSync(path.join(data, 'debug.log'), 'utf8');
    expect(debug).toContain('Auto-update skipped: local updatePolicy: skip');
    expect(debug).not.toContain('Already up to date (v0.28.1)');

    write(stateFile, JSON.stringify({ lastUpdateCheck: new Date().toISOString(), availableUpdate: null }));
    await run(older, stop);
    expect(requests).toBeGreaterThan(afterCheck);
    expect(state().availableUpdate).toBe('0.29.0');
    const afterMigration = requests;
    await run(older, stop);
    expect(requests).toBe(afterMigration);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
