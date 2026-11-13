import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const timeout = AbortSignal.timeout.bind(AbortSignal);

async function listTGitOrgRepos(origin: string) {
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => fetch(String(url).replace('https://git.woa.com', origin), init));

  return (await import('../providers/tgit/gf-org.js')).gfListOrgRepos('g');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each([
  ['GitLab', () => import('../providers/gitlab/org.js').then((m) => m.gitlabListOrgRepos('g'))],
  ['GitHub', (origin: string) => import('../providers/github/gh-org.js').then((m) => m.ghListOrgRepos('g', { apiBaseUrl: origin }))],
  ['GitCode', async (origin: string) => {
    const api = await import('../providers/gitcode/gitcode-api.js');
    vi.spyOn(api, 'gitcodeApiBase').mockReturnValue(`${origin}/api/v5`);

    return (await import('../providers/gitcode/org.js')).gitcodeListOrgRepos('g');
  }],
  ['TGit', listTGitOrgRepos],
  ['TGit group fallback', listTGitOrgRepos, true],
] as const)('%s organization request deadlines', (_label, listOrgRepos, fallback?: boolean) => {
  it.each(([
    [1, 'headers'], [1, 'body'], [1, 'error-body'],
    [2, 'headers'], [2, 'body'], [2, 'error-body'],
  ] as const).filter(([page]) => !fallback || page === 1))('rejects a stalled page %i %s without returning a partial list', async (page, stage) => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(300));
    const seen: number[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (fallback && url.pathname.endsWith('/projects')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const requested = fallback ? 1 : Number(url.searchParams.get('page'));
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
      vi.stubEnv('GITCODE_TOKEN', 'fixture-token');
      vi.stubEnv('TGIT_TOKEN', 'fixture-token');
      vi.resetModules();
      const result = await Promise.race([
        listOrgRepos(origin).then((repos) => ({ repos }), (error: unknown) => ({ error })),
        delay(1500, 'request did not settle'),
      ]);
      expect(result).not.toBe('request did not settle');
      expect(result).toHaveProperty('error');
      expect(seen).toEqual(page === 1 ? [1] : [1, 2]);
      expect(deadlines.mock.calls).toEqual(Array.from({ length: page + (fallback ? 1 : 0) }, () => [30_000]));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });
});
