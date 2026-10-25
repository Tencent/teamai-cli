import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('import --from-org with a stalled GitLab response body', () => {
  it('fails at the real deadline without replacing the whitelist, then succeeds on retry', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-gitlab-org-timeout-'));
    const draft = path.join(sandbox, '.teamai', 'repo-whitelist.draft.yaml');
    const original = 'version: 1\nrepos: []\n';
    await fs.mkdir(path.dirname(draft));
    await fs.writeFile(draft, original);
    let stalled = true;
    const seen: number[] = [];
    const server = http.createServer((req, res) => {
      const page = Number(new URL(req.url!, 'http://localhost').searchParams.get('page'));
      seen.push(page);
      if (page === 2 && stalled) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        return;
      }
      res.end(JSON.stringify(Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => {
        const id = (page - 1) * 100 + index;
        return { id, name: `repo-${id}`, path_with_namespace: `g/repo-${id}`, http_url_to_repo: `https://example.com/g/repo-${id}.git` };
      })));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      const run = (): Promise<{ code: number | null; output: string }> => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, 'import', '--from-org', `${origin}/g`, '--skip-import'], {
          cwd: sandbox,
          env: {
            ...process.env, HOME: sandbox, USERPROFILE: sandbox, TEAMAI_HOME: path.join(sandbox, '.teamai'), FORCE_COLOR: '0',
            GITLAB_URL: origin, TEAMAI_GITLAB_HOST: `127.0.0.1:${address.port}`, GITLAB_API_PREFIX: 'api/v4', GITLAB_TOKEN: 'fixture-token',
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
      const result = await run();
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('listOrgRepos failed');
      expect(result.output).not.toContain('Whitelist written');
      expect(seen).toEqual([1, 2]);
      expect(await fs.readFile(draft, 'utf8')).toBe(original);

      stalled = false;
      const retried = await run();
      expect(retried.code, retried.output).toBe(0);
      expect(retried.output).toContain('Fetched 101 repos');
      expect(seen).toEqual([1, 2, 1, 2]);
      const whitelist = parse(await fs.readFile(draft, 'utf8'));
      expect(whitelist.repos).toHaveLength(101);
      expect(whitelist.repos[100].url).toBe('https://example.com/g/repo-100.git');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
      await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
