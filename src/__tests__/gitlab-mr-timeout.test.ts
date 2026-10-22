import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { warn: vi.fn(), debug: vi.fn() },
}));

const MR = { title: 'Retry uploads', description: 'Keep the batch moving', author: { username: 'alice' } };
const timeout = AbortSignal.timeout.bind(AbortSignal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GitLab MR request deadlines', () => {
  it.each(['metadata', 'commits', 'changes', 'discussions', 'discussions-page-2'])(
    'bounds a stalled %s request before headers and during its body', async (endpoint) => {
      for (const bodyStarted of [false, true]) {
        const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(500));
        const seen: string[] = [];
        const server = http.createServer((req, res) => {
          const stage = req.url!.includes('/commits?') ? 'commits'
            : req.url!.endsWith('/changes') ? 'changes'
            : req.url!.includes('/discussions?') ? (req.url!.endsWith('page=2') ? 'discussions-page-2' : 'discussions')
            : 'metadata';
          seen.push(stage);
          if (stage === endpoint) {
            if (bodyStarted) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.write('{');
            }
            return;
          }
          if (stage === 'discussions' && endpoint === 'discussions-page-2') res.setHeader('x-next-page', '2');
          res.end(JSON.stringify(stage === 'metadata' ? MR
            : stage === 'commits' ? [{ id: 'abc', title: 'Fix uploads' }]
            : stage === 'changes' ? { changes: [{ diff: '+retry' }] } : []));
        });
        await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
          const origin = `http://127.0.0.1:${address.port}`;
          vi.stubEnv('GITLAB_URL', origin);
          vi.stubEnv('TEAMAI_GITLAB_HOST', `127.0.0.1:${address.port}`);
          vi.stubEnv('GITLAB_API_PREFIX', 'api/v4');
          vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
          vi.resetModules();
          const { fetchGitLabMR } = await import('../providers/gitlab/mr-fetch.js');
          const result = await Promise.race([
            fetchGitLabMR(`${origin}/group/repo/-/merge_requests/7`).then(
              (mr) => ({ mr }), (error: unknown) => ({ error }),
            ),
            delay(2000, 'request did not settle'),
          ]);
          expect(result).not.toBe('request did not settle');
          if (typeof result === 'string') throw new Error(result);
          expect(seen).toContain(endpoint);
          expect(deadlines.mock.calls.length).toBe(seen.length);
          for (const [ms] of deadlines.mock.calls) expect(ms).toBe(30_000);
          if (endpoint === 'metadata') {
            expect(result).toHaveProperty('error');
            expect(seen).toEqual(['metadata']);
          } else {
            expect(result).toHaveProperty('mr');
            if (!('mr' in result)) throw new Error('Expected optional request failure to be nonfatal');
            expect(result.mr.title).toBe(MR.title);
            expect(result.mr.commits).toEqual(endpoint === 'commits' ? [] : [{ hash: 'abc', message: 'Fix uploads' }]);
            expect(result.mr.diff).toBe(endpoint === 'changes' ? '' : '+retry');
            expect(result.mr.discussions).toEqual(endpoint.startsWith('discussions') ? undefined : []);
            expect(seen).toContain('discussions');
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
          deadlines.mockRestore();
        }
      }
    },
  );
});
