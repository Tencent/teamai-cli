import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
let server: Server | undefined;
let sandbox: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
});

describe('GitLab organization API prefix (built CLI)', () => {
  it.each([
    ['api/gitlab', '', 'api/gitlab'],
    [' /api/gitlab/ ', '/gitlab', 'api/gitlab'],
    [undefined, '', 'api/v4'],
    ['', '', 'api/v4'],
    ['   ', '', 'api/v4'],
  ])('imports a paginated whitelist with prefix %j and root %j', async (prefix, root, expected) => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-gitlab-prefix-'));
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.url!);
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname !== `${root}/${expected}/groups/team%2Fsub/projects`) {
        res.writeHead(405).end('Unexpected API prefix');
        return;
      }
      if (req.headers['private-token'] !== 'local-test-token') {
        res.writeHead(401).end('Missing token');
        return;
      }
      const page = Number(url.searchParams.get('page'));
      const projects = Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => {
        const id = (page - 1) * 100 + i;
        return {
          id, name: `repo-${id}`, path_with_namespace: `team/sub/repo-${id}`,
          http_url_to_repo: `https://gitlab.example.com/team/sub/repo-${id}.git`,
        };
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(projects));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const origin = `http://127.0.0.1:${address.port}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: sandbox, TEAMAI_HOME: path.join(sandbox, '.teamai'),
      GITLAB_URL: `${origin}${root}/`, GITLAB_TOKEN: 'local-test-token',
    };
    delete env.TEAMAI_GITLAB_HOST;
    delete env.GITLAB_API_PREFIX;
    if (prefix !== undefined) env.GITLAB_API_PREFIX = prefix;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'import', '--from-org', `${origin}/team/sub`, '--skip-import'], {
        cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Fetched 101 repos');
    expect(seen).toEqual([1, 2].map(page =>
      `${root}/${expected}/groups/team%2Fsub/projects?per_page=100&page=${page}&include_subgroups=true`,
    ));
    const draft = parse(await fs.readFile(path.join(sandbox, '.teamai/repo-whitelist.draft.yaml'), 'utf8'));
    expect(draft.repos).toHaveLength(101);
    expect(draft.repos[100].url).toBe('https://gitlab.example.com/team/sub/repo-100.git');
  });
});
