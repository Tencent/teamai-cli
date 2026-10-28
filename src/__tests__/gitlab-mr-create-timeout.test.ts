import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitlabMrCreate } from '../providers/gitlab/gitlab-api.js';

describe('GitLab MR creation deadline', () => {
  let server: http.Server;
  let seen: string[];
  let handle: http.RequestListener;
  const options = { repo: 'group/repo', source: 'fix/x', target: 'main', title: 'Fix x', spawnTimeoutMs: 500 };

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      handle(req, res);
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    vi.stubEnv('GITLAB_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('TEAMAI_GITLAB_HOST', `127.0.0.1:${address.port}`);
    vi.stubEnv('GITLAB_API_PREFIX', 'api/v4');
    vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
    vi.unstubAllEnvs();
  });

  it.each(['headers', 'body'] as const)('aborts a stalled reviewer %s and never posts an MR afterwards', async (phase) => {
    handle = (req, res) => {
      if (req.url?.includes('/users?')) {
        if (phase === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('[{"id":5,');
        }
        // Let an unguarded implementation finish, so the regression fails without hanging the suite.
        const timer = setTimeout(() => res.end(phase === 'body'
          ? '"username":"alice"}]' : '[{"id":5,"username":"alice"}]'), 1000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.end('{"web_url":"https://gitlab.example.com/group/repo/-/merge_requests/1"}');
    };
    await expect(gitlabMrCreate({ ...options, reviewers: ['alice', 'bob'] })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen).toEqual(['GET /api/v4/users?username=alice']);
  });

  it('shares the remaining deadline with the MR POST instead of starting another budget', async () => {
    handle = (req, res) => {
      if (req.url?.includes('/users?')) {
        const timer = setTimeout(() => res.end('[{"id":5,"username":"alice"}]'), 600);
        res.on('close', () => clearTimeout(timer));
      } else {
        const timer = setTimeout(() => res.end('{"web_url":"https://gitlab.example.com/group/repo/-/merge_requests/1"}'), 600);
        res.on('close', () => clearTimeout(timer));
      }
    };
    await expect(gitlabMrCreate({ ...options, spawnTimeoutMs: 1000, reviewers: ['alice'] })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen).toEqual(['GET /api/v4/users?username=alice', 'POST /api/v4/projects/group%2Frepo/merge_requests']);
  });

  it('keeps ordinary reviewer failures best-effort and sends the resolved IDs', async () => {
    let body = '';
    handle = (req, res) => {
      if (req.url?.includes('username=missing')) {
        res.writeHead(503);
        res.end();
      } else if (req.url?.includes('username=broken')) {
        res.end('invalid json');
      } else if (req.url?.includes('/users?')) {
        res.end('[{"id":5,"username":"alice"}]');
      } else {
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => res.end('{"web_url":"https://gitlab.example.com/group/repo/-/merge_requests/1"}'));
      }
    };
    await expect(gitlabMrCreate({ ...options, spawnTimeoutMs: 2000, reviewers: ['missing', 'broken', 'alice'] }))
      .resolves.toBe('https://gitlab.example.com/group/repo/-/merge_requests/1');
    expect(JSON.parse(body).reviewer_ids).toEqual([5]);
  });
});
