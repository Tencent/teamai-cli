import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

describe('init with a stalled GitLab identity response', () => {
  it('times out the body at the real deadline and exits before cloning or saving an install', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitlab-auth-'));
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url!);
      if (seen.length === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"username":');
        return;
      }
      // authenticate retries an unavailable identity once; reject that retry immediately.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"message":"Unauthorized"}');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, 'init', `${origin}/group/repo`,
          '--provider', 'gitlab', '--scope', 'user', '--agent', 'claude'], {
          cwd: sandbox,
          env: {
            ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0',
            GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`,
            GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not finish: ${output}`)); }, 45_000);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
      });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('Authentication failed: GitLab authentication failed.');
      expect(seen).toEqual(['/api/v4/user', '/api/v4/user']);
      expect(result.output).not.toContain('Cloning');
      expect(fs.existsSync(path.join(sandbox, '.teamai/config.yaml'))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
