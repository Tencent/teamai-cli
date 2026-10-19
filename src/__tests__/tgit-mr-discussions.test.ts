/**
 * `fetchTGitMR` reads the MR's notes through the endpoint `teamai ci` uses and
 * groups them into threads by `discussion_id` (#1187), without system notes
 * or teamai's own CI comments. A failure there keeps the extraction going.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/tgit/gf-cli.js', () => ({ gfGetOAuthToken: vi.fn(() => null) }));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { fetchTGitMR } from '../providers/tgit/mr-fetch.js';
import { log } from '../utils/logger.js';

const URL = 'https://git.woa.com/group/repo/merge_requests/5';
const API = 'https://git.woa.com/api/v3/projects/group%2Frepo';

const NOTES = [
  { body: 'approved this merge request', author: { username: 'bot' }, system: true },
  { body: 'Fail fast on 403.', author: { username: 'bob' }, discussion_id: 'd1' },
  { body: 'LGTM', author: { username: 'dave' } },
  { body: 'Done.', author: { username: 'alice' }, discussion_id: 'd1' },
  { body: '<!-- teamai:ci-extract -->\n## TeamAI 知识提炼', author: { username: 'ci' } },
];

type Handler = (url: string) => { status?: number; body: unknown };

function stubFetch(handler: Handler): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    seen.push(input);
    const { status = 200, body } = handler(input);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }));
  return seen;
}

const base: Handler = (url) => {
  if (url === `${API}/merge_requests?iid=5`) return { body: [{ id: 99, iid: 5, title: 'Retry uploads', description: 'd', author: { username: 'alice' } }] };
  if (url === `${API}/merge_request/99/changes`) return { body: { files: [{ diff: '+retry' }] } };
  if (url === `${API}/merge_requests/99/notes?per_page=100&page=1`) return { body: NOTES };
  throw new Error(`unexpected ${url}`);
};

beforeEach(() => {
  vi.stubEnv('TGIT_TOKEN', 'secret');
  vi.mocked(log.warn).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchTGitMR review threads (#1187)', () => {
  it('groups the notes by discussion, without system or teamai notes', async () => {
    stubFetch(base);
    const mr = await fetchTGitMR(URL);
    expect(mr.discussions).toEqual([
      { notes: [{ author: 'bob', body: 'Fail fast on 403.' }, { author: 'alice', body: 'Done.' }] },
      { notes: [{ author: 'dave', body: 'LGTM' }] },
    ]);
    expect(mr.diff).toBe('+retry');
  });

  it('does not read the notes with discussions: false', async () => {
    const seen = stubFetch(base);
    const mr = await fetchTGitMR(URL, { discussions: false });
    expect(seen.some((u) => u.includes('/notes'))).toBe(false);
    expect(mr).not.toHaveProperty('discussions');
  });

  it('keeps the extraction going, with a warning, when the notes call fails', async () => {
    stubFetch((url) => (url.includes('/notes') ? { status: 500, body: {} } : base(url)));
    const mr = await fetchTGitMR(URL);
    expect(mr).not.toHaveProperty('discussions');
    expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringMatching(/Review threads not read \(TGit API error 500\)/),
    ]);
  });
});
