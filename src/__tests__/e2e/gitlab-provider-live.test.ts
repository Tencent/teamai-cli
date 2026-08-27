import { describe, it, expect } from 'vitest';
import { gitlabIsAuthenticated, gitlabWhoami } from '../../providers/gitlab/gitlab-api.js';

/**
 * Live, read-only smoke test for the GitLab provider against a real account
 * (gitlab.com or a self-hosted instance via GITLAB_URL).
 *
 * Opt-in: skipped unless GITLAB_TOKEN is set, so normal CI (no GitLab secret)
 * never runs it. Intentionally read-only — it does NOT create repos/MRs.
 * The full mutating flow (init → clone → push → open-MR) was verified manually
 * against `git.guazi-corp.com`; see the PR notes.
 */
const HAS_GITLAB = Boolean(process.env.GITLAB_TOKEN);

describe('GitLab provider (live GitLab instance)', () => {
  it.skipIf(!HAS_GITLAB)('authenticates via env token and resolves the account username', async () => {
    expect(gitlabIsAuthenticated()).toBe(true);
    const user = await gitlabWhoami();
    expect(typeof user).toBe('string');
    expect((user ?? '').length).toBeGreaterThan(0);
  });
});