import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'index.js');

describe('update --dry-run (real CLI)', () => {
  let sandbox: string;
  let home: string;
  let registry: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    if (!fs.existsSync(cli)) throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-update-preview-'));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'state.json'), '{"lastUpdateCheck":null,"availableUpdate":null}\n');
    registry = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        name: 'teamai-cli',
        'dist-tags': { latest: '99.0.0' },
        versions: { '99.0.0': { name: 'teamai-cli', version: '99.0.0' } },
      }));
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    if (registry) await new Promise<void>((resolve, reject) => registry.close((err) => err ? reject(err) : resolve()));
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([{ extra: [] }, { extra: ['--check'] }])('checks the registry without saving TeamAI state or taking a lock ($extra)', async ({ extra }) => {
    const statePath = path.join(home, '.teamai', 'state.json');
    const before = fs.readFileSync(statePath);
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'update', '--dry-run', ...extra], {
        cwd: home,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
          TEAMAI_NPM_REGISTRY: registryUrl,
          npm_config_cache: path.join(sandbox, 'npm-cache'),
        },
        windowsHide: true,
        timeout: 15_000,
      });
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, text }));
    });

    expect(output.code).toBe(0);
    expect(output.text).toContain('Update available:');
    expect(output.text).toContain('99.0.0');
    expect(output.text).not.toContain('Updated teamai');
    expect(fs.readFileSync(statePath)).toEqual(before);
    // Startup diagnostics and npm's own cache are not TeamAI update state.
    expect(fs.readdirSync(path.join(home, '.teamai')).filter((name) => name !== 'debug.log')).toEqual(['state.json']);
  });
});
