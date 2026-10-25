import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const timeout = AbortSignal.timeout.bind(AbortSignal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([
  ['GitLab', () => import('../providers/gitlab/org.js').then((m) => m.gitlabListOrgRepos('g'))],
  ['GitHub', (origin: string) => import('../providers/github/gh-org.js').then((m) => m.ghListOrgRepos('g', { apiBaseUrl: origin }))],
] as const)('%s organization request deadlines', (_label, listOrgRepos) => {
  it.each([
    [1, 'headers'], [1, 'body'], [1, 'error-body'],
    [2, 'headers'], [2, 'body'], [2, 'error-body'],
  ] as const)('rejects a stalled page %i %s without returning a partial list', async (page, stage) => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(300));
    const seen: number[] = [];
    const server = http.createServer((req, res) => {
      const requested = Number(new URL(req.url!, 'http://localhost').searchParams.get('page'));
      seen.push(requested);
      if (requested === page) {
        if (stage !== 'headers') {
          res.writeHead(stage === 'error-body' ? 500 : 200, { 'Content-Type': 'application/json' });
          res.write('[');
        }
        return;
      }
      res.end(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({
        id, name: `repo-${id}`, path_with_namespace: `g/repo-${id}`, http_url_to_repo: `https://example.com/g/repo-${id}.git`,
        full_name: `g/repo-${id}`, clone_url: `https://example.com/g/repo-${id}.git`, archived: false,
      }))));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      vi.stubEnv('GITLAB_URL', origin);
      vi.stubEnv('TEAMAI_GITLAB_HOST', `127.0.0.1:${address.port}`);
      vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
      vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
      vi.resetModules();
      const result = await Promise.race([
        listOrgRepos(origin).then((repos) => ({ repos }), (error: unknown) => ({ error })),
        delay(1500, 'request did not settle'),
      ]);
      expect(result).not.toBe('request did not settle');
      expect(result).toHaveProperty('error');
      expect(seen).toEqual(page === 1 ? [1] : [1, 2]);
      expect(deadlines.mock.calls).toEqual(Array.from({ length: page }, () => [30_000]));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });
});
