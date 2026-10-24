import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), warn: vi.fn() },
}));

import { fetchGitLabMR } from '../providers/gitlab/mr-fetch.js';

const MR_URL = 'https://gitlab.com/group/repo/-/merge_requests/7';
const API = 'https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/7';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitLab MR commit pages', () => {
  it.each([0, 1, 49, 50, 51, 101])('includes all %i commits in order', async (count) => {
    vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
    const commits = Array.from({ length: count }, (_, i) => ({ id: `sha-${i + 1}`, title: `Change ${i + 1}` }));
    const pages: number[] = [];
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      seen.push(url);
      if (url === API) return new Response(JSON.stringify({ title: 'T', description: '', author: { username: 'a' } }));
      if (url.startsWith(`${API}/commits?`)) {
        const page = Number(new URL(url).searchParams.get('page') ?? 1);
        pages.push(page);
        const start = (page - 1) * 50;
        const batch = commits.slice(start, start + 50);
        const nextPage = start + 50 < count ? String(page + 1) : '';
        return new Response(JSON.stringify(batch), { headers: nextPage ? { 'x-next-page': nextPage } : {} });
      }
      if (url === `${API}/changes`) return new Response(JSON.stringify({ changes: [] }));
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const mr = await fetchGitLabMR(MR_URL, { discussions: false });
    expect(mr.commits, seen.join('\n')).toEqual(commits.map((c) => ({ hash: c.id, message: c.title })));
    expect(pages).toEqual(Array.from({ length: Math.floor(count / 50) + 1 }, (_, i) => i + 1));
  });

  it('discards partial commits when a later page fails, then continues with the diff', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'fixture-token');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      seen.push(url);
      if (url === API) return new Response(JSON.stringify({ title: 'T', description: '', author: { username: 'a' } }));
      if (url === `${API}/commits?per_page=50`) {
        return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: `sha-${i}`, title: `Change ${i}` }))), {
          headers: { 'x-next-page': '2' },
        });
      }
      if (url === `${API}/commits?per_page=50&page=2`) return new Response('busy', { status: 429 });
      if (url === `${API}/changes`) return new Response(JSON.stringify({ changes: [{ diff: '+kept' }] }));
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const mr = await fetchGitLabMR(MR_URL, { discussions: false });
    expect(mr.commits).toEqual([]);
    expect(mr.diff).toBe('+kept');
    expect(seen).toContain(`${API}/commits?per_page=50&page=2`);
  });
});
