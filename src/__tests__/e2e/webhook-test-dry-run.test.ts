import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'index.js');

describe('webhook test --dry-run (real CLI)', () => {
  let sandbox: string;
  let home: string;

  beforeAll(() => {
    if (!fs.existsSync(cli)) throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-webhook-preview-'));
    home = path.join(sandbox, 'home');
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(teamRepo, { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), [
      'team: webhook-preview-e2e',
      'repo: https://example.com/team.git',
      'provider: git',
      'sharing:',
      '  webhooks:',
      '    enabled: true',
      '    endpoints:',
      '      - url: http://127.0.0.1:9/hook',
      '        type: json',
      '        events: ["*"]',
      '        timeout: 500',
      '        retries: 0',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      '  remote: https://example.com/team.git',
      'username: e2e-user',
      'updatePolicy: auto',
      'scope: user',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    { url: undefined, count: 1 },
    { url: 'http://127.0.0.1:9/unmatched', count: 0 },
  ])('previews $count endpoint(s) without sending a request or rewriting config', ({ url, count }) => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    const before = fs.readFileSync(configPath);
    const args = [cli, 'webhook', 'test', '--dry-run'];
    if (url) args.push('--url', url);
    const result = spawnSync(process.execPath, args, {
      cwd: home,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain(`[dry-run] Would send a test webhook to ${count} endpoint(s).`);
    expect(result.stdout + result.stderr).not.toContain('No webhook endpoints configured.');
    expect(result.stdout + result.stderr).not.toContain('Webhook test failed');
    expect(fs.readFileSync(configPath)).toEqual(before);
  });
});
