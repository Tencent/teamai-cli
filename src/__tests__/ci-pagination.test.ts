import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { postOrUpdateMrComment } from '../ci/mr-comment.js';
import { readRejections } from '../ci/read-rejections.js';

const marker = '<!-- teamai:ci-extract:learning -->';
const response = (body: unknown) => new Response(JSON.stringify(body), {
  headers: Array.isArray(body) && body.length === 100
    ? { link: '<https://api.github.com/next>; rel="next"', 'x-next-page': '2' }
    : {},
});
const filler = Array.from({ length: 100 }, (_, id) => ({ id, body: 'discussion', content: '+1' }));

beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'test');
  vi.stubEnv('TGIT_TOKEN', 'test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['github', 'tgit'])('updates a marker on the second %s page', async (provider) => {
  const github = provider === 'github';
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('merge_requests?iid=')) return response([{ id: 7, iid: 7 }]);
    if (init?.method === 'PATCH' || init?.method === 'PUT') return response({});
    if (init?.method === 'POST') return response({});
    return response(new URL(input).searchParams.get('page') === '2' ? [{ id: 123, body: marker }] : filler);
  });
  vi.stubGlobal('fetch', fetchMock);
  const url = github ? 'https://github.com/acme/app/pull/7' : 'https://git.woa.com/acme/app/merge_requests/7';
  expect((await postOrUpdateMrComment(url, undefined, undefined, marker)).created).toBe(false);
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each(['github', 'tgit'])('reads rejected markers on the second %s page', async (provider) => {
  const github = provider === 'github';
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('merge_requests?iid=')) return response([{ id: 7, iid: 7 }]);
    const page = new URL(input).searchParams.get('page');
    if (input.includes('/reactions')) return response([{ content: '-1' }]);
    return response(page === '2' ? [{ id: 123, body: marker, comments: [{ comment: 8 }] }] : filler);
  }));
  const url = github ? 'https://github.com/acme/app/pull/7' : 'https://git.woa.com/acme/app/merge_requests/7';
  expect((await readRejections(url)).rejectedIds.has('learning')).toBe(true);
});

it('reads a GitHub thumbsdown on the second reaction page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (!input.includes('/reactions')) return response([{ id: 123, body: marker }]);
    return response(new URL(input).searchParams.get('page') === '2' ? [{ content: '-1' }] : filler);
  }));
  expect((await readRejections('https://github.com/acme/app/pull/7')).rejectedIds.has('learning')).toBe(true);
});

it('fails instead of approving when the second comment page fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new URL(input).searchParams.get('page') === '2'
    ? new Response(null, { status: 503 })
    : response(filler)));
  await expect(readRejections('https://github.com/acme/app/pull/7'))
    .rejects.toThrow('GitHub comments request failed (503)');
});

it('fails instead of silently truncating at the page limit', async () => {
  const fetchMock = vi.fn(async () => response(filler));
  vi.stubGlobal('fetch', fetchMock);
  await expect(readRejections('https://github.com/acme/app/pull/7'))
    .rejects.toThrow('refusing to truncate');
  expect(fetchMock).toHaveBeenCalledTimes(20);
});

it('honors a next-page link even when the GitHub page is short', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('/reactions')) return response([{ content: '-1' }]);
    if (new URL(input).searchParams.get('page') === '2') return response([{ id: 123, body: marker }]);
    return new Response('[]', { headers: { link: '<https://api.github.com/next>; rel="next"' } });
  }));
  expect((await readRejections('https://github.com/acme/app/pull/7')).rejectedIds.has('learning')).toBe(true);
});
