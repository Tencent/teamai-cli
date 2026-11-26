import { describe, expect, it } from 'vitest';

import { ciWriteProvider } from '../ci/extract-mr.js';

/**
 * `ci write` picks the token (and therefore the commit author identity) from
 * the MR provider. A GitLab project named `github.com-mirror` must not be
 * routed to the GitHub token just because its URL mentions "github.com".
 */
describe('ciWriteProvider', () => {
  it('routes a GitHub pull request to github', () => {
    expect(ciWriteProvider('https://github.com/org/repo/pull/7')).toBe('github');
  });

  it('routes a TGit merge request to tgit', () => {
    expect(ciWriteProvider('https://git.woa.com/group/sub/repo/merge_requests/7')).toBe('tgit');
  });

  it('routes a GitLab MR to gitlab even when its path mentions github.com', () => {
    expect(ciWriteProvider('https://gitlab.example.com/acme/github.com-mirror/-/merge_requests/12')).toBe('gitlab');
    expect(ciWriteProvider('https://gitlab.example.com/acme/repo/-/merge_requests/12?ref=github.com')).toBe('gitlab');
  });

  it('routes a TGit MR to tgit even when its path mentions github.com', () => {
    expect(ciWriteProvider('https://git.woa.com/acme/github.com-mirror/merge_requests/3')).toBe('tgit');
  });
});
