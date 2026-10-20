import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

describe('import --from-mr with a stalled GitLab response body', () => {
  it('times out at the real deadline, processes the next MR and exits nonzero without extracting a learning', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitlab-timeout-'));
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url!);
      if (req.url!.endsWith('/41')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"title":"Stalled MR"');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"Not Found"}');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const urls = [41, 42].map((n) => `${origin}/group/repo/-/merge_requests/${n}`);
      const repo = path.join(sandbox, 'repo');
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: timeout-test\nrepo: https://example.com/team.git\nprovider: git\n');
      fs.mkdirSync(path.join(sandbox, '.teamai'));
      fs.writeFileSync(path.join(sandbox, '.teamai/config.yaml'), [
        'repo:', `  localPath: ${JSON.stringify(repo)}`, '  remote: https://example.com/team.git',
        'username: test-user', 'scope: user', '',
      ].join('\n'));
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, 'import', '--from-mr', ...urls,
          '--all', '--output', path.join(sandbox, 'output')], {
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
      expect(result.output).toContain('Import from MR complete: 0 succeeded, 2 failed');
      for (const url of urls) expect(result.output).toContain(`import from MR failed: ${url}`);
      expect(seen).toEqual([
        '/api/v4/projects/group%2Frepo/merge_requests/41',
        '/api/v4/projects/group%2Frepo/merge_requests/42',
      ]);
      expect(result.output).not.toContain('AI analysis in progress');
      expect(fs.existsSync(path.join(sandbox, 'output'))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
