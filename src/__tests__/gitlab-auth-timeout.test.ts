import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitlabWhoami } from '../providers/gitlab/gitlab-api.js';

const timeout = AbortSignal.timeout.bind(AbortSignal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GitLab identity request deadline', () => {
  it.each(['headers', 'body'])('returns null when the response stalls during %s', async (stage) => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(500));
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url!);
      if (stage === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"username":');
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      vi.stubEnv('GITLAB_URL', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('TEAMAI_GITLAB_HOST', `127.0.0.1:${address.port}`);
      vi.stubEnv('GITLAB_API_PREFIX', 'api/v4');
      vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
      const result = await Promise.race([gitlabWhoami(), delay(2000, 'request did not settle')]);
      expect(result).toBeNull();
      expect(seen).toEqual(['/api/v4/user']);
      expect(deadlines.mock.calls).toEqual([[30_000]]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); });
    }
  });
});
