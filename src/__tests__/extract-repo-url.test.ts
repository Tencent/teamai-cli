import { describe, expect, it } from 'vitest';

import { extractRepoUrlFromMrUrl } from '../import-mr.js';

/**
 * fetchMR() normalizes hosts (case-insensitive, strips 'www.'), so the repo URL
 * inference must accept the same URL forms. Otherwise repo_url stays empty and
 * the teamwiki incremental update is silently skipped.
 */
describe('extractRepoUrlFromMrUrl', () => {
  it('extracts a GitHub PR repo URL', () => {
    expect(extractRepoUrlFromMrUrl('https://github.com/owner/repo/pull/123')).toBe('https://github.com/owner/repo.git');
  });

  it('extracts a GitHub PR repo URL with www.', () => {
    expect(extractRepoUrlFromMrUrl('https://www.github.com/owner/repo/pull/123')).toBe('https://github.com/owner/repo.git');
  });

  it('extracts a GitHub PR repo URL over http', () => {
    expect(extractRepoUrlFromMrUrl('http://github.com/owner/repo/pull/123')).toBe('https://github.com/owner/repo.git');
  });

  it('extracts a GitHub PR repo URL with a mixed-case host', () => {
    expect(extractRepoUrlFromMrUrl('https://GitHub.com/owner/repo/pull/123')).toBe('https://github.com/owner/repo.git');
  });

  it('extracts a TGit MR repo URL including nested groups', () => {
    expect(extractRepoUrlFromMrUrl('https://git.woa.com/group/sub/repo/merge_requests/7')).toBe('https://git.woa.com/group/sub/repo.git');
  });

  it('extracts a self-hosted GitLab MR repo URL', () => {
    expect(extractRepoUrlFromMrUrl('https://gitlab.example.com/acme/repo/-/merge_requests/12')).toBe('https://gitlab.example.com/acme/repo.git');
  });

  it('preserves a self-hosted GitLab protocol, host and port', () => {
    expect(extractRepoUrlFromMrUrl('http://gitlab.example.com:8443/acme/repo/-/merge_requests/12'))
      .toBe('http://gitlab.example.com:8443/acme/repo.git');
  });

  it('preserves www. on a self-hosted GitLab host', () => {
    expect(extractRepoUrlFromMrUrl('https://www.gitlab.example.com/acme/repo/-/merge_requests/12'))
      .toBe('https://www.gitlab.example.com/acme/repo.git');
  });

  it('extracts a GitCode PR repo URL', () => {
    expect(extractRepoUrlFromMrUrl('https://gitcode.com/owner/repo/pull/42')).toBe('https://gitcode.com/owner/repo.git');
  });

  it('extracts a GitCode PR over the pulls and merge_requests routes', () => {
    expect(extractRepoUrlFromMrUrl('https://gitcode.com/owner/repo/pulls/42')).toBe('https://gitcode.com/owner/repo.git');
    expect(extractRepoUrlFromMrUrl('https://gitcode.com/owner/repo/merge_requests/42')).toBe('https://gitcode.com/owner/repo.git');
  });

  it('extracts a GitCode PR with www. and mixed-case host', () => {
    expect(extractRepoUrlFromMrUrl('https://www.GitCode.com/owner/repo/pull/42')).toBe('https://gitcode.com/owner/repo.git');
  });

  it('does not treat a GitLab URL mentioning gitcode.com as a GitCode PR', () => {
    expect(extractRepoUrlFromMrUrl('https://gitlab.example.com/gitcode.com/repo/-/merge_requests/3'))
      .toBe('https://gitlab.example.com/gitcode.com/repo.git');
  });

  it('returns empty for an unrecognized URL', () => {
    expect(extractRepoUrlFromMrUrl('https://example.com/foo')).toBe('');
  });
});
