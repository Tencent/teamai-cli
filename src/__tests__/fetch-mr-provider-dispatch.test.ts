/**
 * `fetchMR` routes a PR/MR URL to exactly one provider parser. Two classes of
 * regression are covered here:
 *
 * 1. GitCode is a registered provider with a working `fetchGitCodeMR`, but the
 *    dispatcher never called it — every `teamai import --from-mr` on a GitCode
 *    URL died with "Unsupported MR URL".
 * 2. The old dispatcher used `url.includes('github.com')`. A self-hosted
 *    GitLab on `github.com.example.com` (or any URL whose path mentioned
 *    github.com) was hijacked to the GitHub parser before the GitLab route
 *    check could run.
 *
 * The parsers themselves are stubbed: this file tests dispatch only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above the imports, so its factories run before any
// top-level `const` initializer would. `vi.hoisted` moves these stubs up with
// them; a plain `const` here makes collection fail with a ReferenceError.
const { github, tgit, gitlab, gitcode } = vi.hoisted(() => ({
  github: vi.fn(async (url: string) => ({ provider: 'github', url })),
  tgit: vi.fn(async (url: string) => ({ provider: 'tgit', url })),
  gitlab: vi.fn(async (url: string) => ({ provider: 'gitlab', url })),
  gitcode: vi.fn(async (url: string) => ({ provider: 'gitcode', url })),
}));

vi.mock('../providers/github/mr-fetch.js', () => ({ fetchGitHubPR: github }));
vi.mock('../providers/tgit/mr-fetch.js', () => ({ fetchTGitMR: tgit }));
vi.mock('../providers/gitlab/mr-fetch.js', () => ({ fetchGitLabMR: gitlab }));
vi.mock('../providers/gitcode/mr-fetch.js', () => ({ fetchGitCodeMR: gitcode }));

import { fetchMR } from '../import-mr.js';

const providers = { github, tgit, gitlab, gitcode };

beforeEach(() => {
  for (const fn of Object.values(providers)) fn.mockClear();
});

/** The single provider that received the call. */
function called(): string[] {
  return Object.entries(providers).filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
}

describe('fetchMR dispatches by exact host, not substring', () => {
  it.each([
    ['https://github.com/owner/repo/pull/42', 'github'],
    ['https://git.woa.com/owner/repo/-/merge_requests/7', 'tgit'],
    ['https://gitlab.com/group/repo/-/merge_requests/9', 'gitlab'],
    ['https://gitlab.mycorp.io/group/repo/-/merge_requests/3', 'gitlab'],
  ])('routes %s to %s', async (url, expected) => {
    await fetchMR(url, {});
    expect(called()).toEqual([expected]);
  });

  it.each([
    'https://github.com.example.com/group/repo/-/merge_requests/1',
    'https://git.mycorp.io/r/github.com-mirror/-/merge_requests/2',
  ])('does not hijack %s to GitHub just because the host/path mentions github.com', async (url) => {
    await fetchMR(url, {});
    expect(called()).toEqual(['gitlab']);
    expect(github).not.toHaveBeenCalled();
  });
});

describe('fetchMR supports GitCode', () => {
  it.each([
    'https://gitcode.com/owner/repo/pull/42',
    'https://gitcode.com/owner/repo/merge_requests/42',
  ])('routes %s to the GitCode provider', async (url) => {
    const result = await fetchMR(url, { discussions: false });
    expect(called()).toEqual(['gitcode']);
    expect(result).toMatchObject({ provider: 'gitcode', url });
  });

  it('recognises www.gitcode.com', async () => {
    await fetchMR('https://www.gitcode.com/owner/repo/pull/1', {});
    expect(called()).toEqual(['gitcode']);
  });
});

describe('fetchMR rejects unknown URLs', () => {
  it('throws Unsupported MR URL for an unknown host', async () => {
    await expect(fetchMR('https://bitbucket.org/owner/repo/pull/1', {}))
      .rejects.toThrow('Unsupported MR URL');
    expect(called()).toEqual([]);
  });

  it('throws Unsupported MR URL for a malformed URL', async () => {
    await expect(fetchMR('not-a-url', {})).rejects.toThrow('Unsupported MR URL');
    expect(called()).toEqual([]);
  });

  it('mentions GitCode in the error so users know it is supported', async () => {
    await expect(fetchMR('https://example.com/r/pull/1', {}))
      .rejects.toThrow(/GitCode/);
  });
});
