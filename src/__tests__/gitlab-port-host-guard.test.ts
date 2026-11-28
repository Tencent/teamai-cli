import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseGitLabMRUrl } from '../providers/gitlab/mr-fetch.js';

const originalEnv = { ...process.env };
beforeEach(() => { process.env.GITLAB_TOKEN = 'glpat_test'; });
afterEach(() => { process.env = { ...originalEnv }; });

describe('GitLab bare-host override with ported GITLAB_URL', () => {
  it('accepts an MR URL on the configured GITLAB_URL host with a port', () => {
    process.env.TEAMAI_GITLAB_HOST = 'gitlab.corp';
    process.env.GITLAB_URL = 'https://gitlab.corp:8443/gitlab';
    const parsed = parseGitLabMRUrl('https://gitlab.corp:8443/gitlab/team/repo/-/merge_requests/12');
    expect(parsed.apiBase).toBe('https://gitlab.corp:8443/gitlab/api/v4');
  });

  it('still refuses a host that matches neither the override nor GITLAB_URL', () => {
    process.env.TEAMAI_GITLAB_HOST = 'gitlab.corp';
    process.env.GITLAB_URL = 'https://gitlab.corp:8443/gitlab';
    expect(() => parseGitLabMRUrl('https://evil.example/team/repo/-/merge_requests/12'))
      .toThrow('Refusing to fetch GitLab MR');
  });
});
