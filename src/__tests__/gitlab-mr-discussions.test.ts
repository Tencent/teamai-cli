/**
 * `fetchGitLabMR` reads the MR's review threads from `/discussions` (#1187):
 * every page, without system notes or teamai's own CI comments, with the file
 * and line a diff thread is anchored to and whether it is resolved. An API
 * error there keeps the extraction going without threads, and
 * `discussions: false` does not call the endpoint at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { fetchGitLabMR } from '../providers/gitlab/mr-fetch.js';
import { log } from '../utils/logger.js';

const URL = 'https://gitlab.com/group/repo/-/merge_requests/7';
const API = 'https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests/7';

const MR = { title: 'Retry uploads', description: 'd', author: { username: 'alice' }, merged_at: '2026-09-20T10:00:00Z' };

const note = (author: string, body: string, extra: Record<string, unknown> = {}) => ({ body, author: { username: author }, ...extra });

const PAGE_1 = [
  { notes: [note('gitlab', 'changed the description', { system: true })] },
  {
    notes: [
      note('bob', 'Fail fast on 403.', { resolvable: true, resolved: true, position: { new_path: 'src/up.ts', old_path: 'src/up.ts', new_line: 42, old_line: null } }),
      note('alice', 'Done.', { resolvable: true, resolved: true }),
    ],
  },
  { notes: [note('ci', '<!-- teamai:ci-extract -->\n## TeamAI 知识提炼')] },
];
const PAGE_2 = [
  { notes: [note('carol', 'Deleted line was load-bearing.', { resolvable: true, resolved: false, position: { new_path: null, old_path: 'src/old.ts', new_line: null, old_line: 3 } })] },
  { notes: [note('dave', 'LGTM')] },
];

type Handler = (url: string) => { status?: number; body: unknown; nextPage?: string };

function stubFetch(handler: Handler): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    seen.push(input);
    const { status = 200, body, nextPage } = handler(input);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(nextPage ? { 'x-next-page': nextPage } : {}),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }));
  return seen;
}

const base: Handler = (url) => {
  if (url === `${API}`) return { body: MR };
  if (url.startsWith(`${API}/commits`)) return { body: [{ id: 'abc', title: 'retry' }] };
  if (url.startsWith(`${API}/changes`)) return { body: { changes: [{ diff: '+retry' }] } };
  if (url.endsWith('/discussions?per_page=100&page=1')) return { body: PAGE_1, nextPage: '2' };
  if (url.endsWith('/discussions?per_page=100&page=2')) return { body: PAGE_2 };
  throw new Error(`unexpected ${url}`);
};

beforeEach(() => {
  vi.stubEnv('GITLAB_TOKEN', 'secret');
  vi.mocked(log.warn).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchGitLabMR review threads (#1187)', () => {
  it('reads every page of discussions, mapping anchors and resolution, without system or teamai notes', async () => {
    const seen = stubFetch(base);
    const mr = await fetchGitLabMR(URL);
    expect(seen.filter((u) => u.includes('/discussions'))).toHaveLength(2);
    expect(mr.discussions).toEqual([
      { file: 'src/up.ts', line: 42, resolved: true, notes: [{ author: 'bob', body: 'Fail fast on 403.' }, { author: 'alice', body: 'Done.' }] },
      { file: 'src/old.ts', line: 3, resolved: false, notes: [{ author: 'carol', body: 'Deleted line was load-bearing.' }] },
      { file: undefined, line: undefined, resolved: undefined, notes: [{ author: 'dave', body: 'LGTM' }] },
    ]);
    expect(mr.title).toBe('Retry uploads');
    expect(mr.diff).toBe('+retry');
  });

  it('does not call the endpoint with discussions: false', async () => {
    const seen = stubFetch(base);
    const mr = await fetchGitLabMR(URL, { discussions: false });
    expect(seen.some((u) => u.includes('/discussions'))).toBe(false);
    expect(mr).not.toHaveProperty('discussions');
  });

  it('keeps the extraction going, with a warning, when the discussions call fails', async () => {
    stubFetch((url) => (url.includes('/discussions') ? { status: 403, body: { message: 'Forbidden' } } : base(url)));
    const mr = await fetchGitLabMR(URL);
    expect(mr).not.toHaveProperty('discussions');
    expect(mr.title).toBe('Retry uploads');
    expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringMatching(/Review threads not read \(GitLab API error 403\)/),
    ]);
  });

  it('returns an empty list for an MR without review', async () => {
    stubFetch((url) => (url.includes('/discussions') ? { body: [] } : base(url)));
    const mr = await fetchGitLabMR(URL);
    expect(mr.discussions).toEqual([]);
  });
});
