import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/github/gh-cli.js', () => ({
  isGhInstalled: vi.fn(),
  getGitHubToken: vi.fn().mockReturnValue('test-token'),
  ghExec: vi.fn(),
}));

import { ghListOrgRepos } from '../providers/github/gh-org.js';
import { ghExec, isGhInstalled } from '../providers/github/gh-cli.js';

describe.each(['gh', 'fetch'] as const)('GitHub repo listing errors (%s)', (transport) => {
  let requests: string[];

  function pages(responses: Array<{ status: number; body: string }>): void {
    let index = 0;
    if (transport === 'gh') {
      vi.mocked(ghExec).mockImplementation((args) => {
        requests.push(args[args.length - 1]);
        const response = responses[index++];
        return response.status === 200
          ? { status: 0, stdout: response.body, stderr: '' }
          : { status: 1, stdout: '', stderr: `HTTP ${response.status}: ${response.body}` };
      });
    } else {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requests.push(url);
        const response = responses[index++];
        return new Response(response.body, { status: response.status });
      }));
    }
  }

  beforeEach(() => {
    requests = [];
    vi.mocked(isGhInstalled).mockReturnValue(transport === 'gh');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([401, 403, 503])('rejects HTTP %s when both endpoints fail', async (status) => {
    pages([{ status, body: 'org failed' }, { status, body: 'user failed' }]);

    await expect(ghListOrgRepos('example')).rejects.toThrow('user failed');
    expect(requests).toHaveLength(2);
  });

  it('propagates a failed user lookup after the org endpoint returns 404', async () => {
    pages([{ status: 404, body: 'not an org' }, { status: 503, body: 'user unavailable' }]);

    await expect(ghListOrgRepos('example')).rejects.toThrow('user unavailable');
    expect(requests[1]).toContain('/users/example/repos');
  });

  it('rejects a missing org and user instead of returning an empty list', async () => {
    pages([{ status: 404, body: 'org missing' }, { status: 404, body: 'user missing' }]);

    await expect(ghListOrgRepos('example')).rejects.toThrow('user missing');
  });

  it('propagates malformed JSON from the fallback', async () => {
    pages([{ status: 404, body: 'not an org' }, { status: 200, body: 'invalid json' }]);

    await expect(ghListOrgRepos('example')).rejects.toThrow();
  });

  it('keeps a successful empty fallback as an empty list', async () => {
    pages([{ status: 404, body: 'not an org' }, { status: 200, body: '[]' }]);

    await expect(ghListOrgRepos('example')).resolves.toEqual([]);
  });

  it('keeps the existing empty-org fallback', async () => {
    pages([{ status: 200, body: '[]' }, { status: 200, body: '[]' }]);

    await expect(ghListOrgRepos('example')).resolves.toEqual([]);
    expect(requests[1]).toContain('/users/example/repos');
  });
});
