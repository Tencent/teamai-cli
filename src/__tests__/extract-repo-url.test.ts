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

  it('returns empty for an unrecognized URL', () => {
    expect(extractRepoUrlFromMrUrl('https://example.com/foo')).toBe('');
  });
});
