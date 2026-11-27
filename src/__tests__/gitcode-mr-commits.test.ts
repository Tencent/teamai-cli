import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchGitCodeMR } from '../providers/gitcode/mr-fetch.js';

const PR_URL = 'https://gitcode.com/owner/repo/pull/7';
const OLD_ENV = process.env;

function commits(count: number, start = 1) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => ({
    sha: `hash${start + i}`,
    commit: { message: `commit ${start + i}\nbody` },
  })));
}

describe('fetchGitCodeMR commit pagination', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, GITCODE_TOKEN: 'test-token' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('fetches every page of commits, not just the first 50', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith('/pulls/7')) {
        return new Response(JSON.stringify({ title: 'PR', body: '', user: { login: 'u' } }), { status: 200 });
      }
      if (url.includes('/commits?')) {
        const page = Number(new URL(url).searchParams.get('page'));

        return new Response(page === 1 ? commits(50, 1) : commits(3, 51), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    });

    const mr = await fetchGitCodeMR(PR_URL);

    expect(mr.commits).toHaveLength(53);
    expect(mr.commits[0].hash).toBe('hash1');
    expect(mr.commits[52].hash).toBe('hash53');
    expect(mr.commits[0].message).toBe('commit 1');
    const commitUrls = fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('/commits?'));
    expect(commitUrls).toHaveLength(2);
    expect(commitUrls[1]).toContain('page=2');
  });

  it('keeps the single-page result for short PRs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith('/pulls/7')) {
        return new Response(JSON.stringify({ title: 'PR', body: '' }), { status: 200 });
      }
      if (url.includes('/commits?')) return new Response(commits(3), { status: 200 });

      return new Response(JSON.stringify([]), { status: 200 });
    });

    const mr = await fetchGitCodeMR(PR_URL);

    expect(mr.commits).toHaveLength(3);
    const commitUrls = fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('/commits?'));
    expect(commitUrls).toHaveLength(1);
  });
});
