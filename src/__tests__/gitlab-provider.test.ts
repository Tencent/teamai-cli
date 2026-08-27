import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

// ─── Imports after mocks ────────────────────────────────

import { spawnSync } from 'node:child_process';
import { parseGitLabRepoInput, GITLAB_HOST } from '../providers/gitlab/repo-url.js';
import {
  gitlabIsAuthenticated,
  gitlabWhoami,
  gitlabRepoClone,
  gitlabCreateRepo,
  gitlabMrCreate,
  getGitLabToken,
  gitlabBaseUrl,
  GitLabRepoNotFoundError,
} from '../providers/gitlab/gitlab-api.js';
import { fetchGitLabMR } from '../providers/gitlab/mr-fetch.js';
import { gitlabListOrgRepos } from '../providers/gitlab/org.js';
import { detectProvider, getProvider } from '../providers/registry.js';
import { GitLabProvider } from '../providers/gitlab/index.js';

const mockedSpawnSync = spawnSync as Mock;

// ─── repo-url parsing ───────────────────────────────────

describe('parseGitLabRepoInput', () => {
  it('parses bare owner/repo', () => {
    const info = parseGitLabRepoInput('teamai/teamai-cli');
    expect(info.owner).toBe('teamai');
    expect(info.repo).toBe('teamai-cli');
    expect(info.httpsUrl).toBe(`https://${GITLAB_HOST}/teamai/teamai-cli.git`);
    expect(info.projectId).toBe('teamai%2Fteamai-cli');
  });

  it('parses nested group path (subgroups)', () => {
    const info = parseGitLabRepoInput('group/subgroup/repo');
    expect(info.owner).toBe('group/subgroup');
    expect(info.repo).toBe('repo');
    expect(info.projectId).toBe('group%2Fsubgroup%2Frepo');
  });

  it('parses https URL with .git on the public host', () => {
    const info = parseGitLabRepoInput('https://gitlab.com/org/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
  });

  it('parses ssh URL', () => {
    const info = parseGitLabRepoInput('git@gitlab.com:org/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
  });

  it('accepts any self-hosted host in a full URL', () => {
    const info = parseGitLabRepoInput('https://gitlab.example.com/group/sub/repo.git');
    expect(info.owner).toBe('group/sub');
    expect(info.repo).toBe('repo');
    expect(info.httpsUrl).toBe('https://gitlab.example.com/group/sub/repo.git');
  });

  it('rejects input without an owner', () => {
    expect(() => parseGitLabRepoInput('repo')).toThrow(/Unrecognized GitLab repo format/);
  });
});

// ─── provider detection ─────────────────────────────────

describe('detectProvider for GitLab', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITLAB_URL;
    delete process.env.TEAMAI_GITLAB_HOST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('detects gitlab from gitlab.com https URL', () => {
    expect(detectProvider('https://gitlab.com/org/repo')).toBe('gitlab');
  });

  it('detects gitlab from gitlab.com ssh URL', () => {
    expect(detectProvider('git@gitlab.com:org/repo.git')).toBe('gitlab');
  });

  it('detects a self-hosted GitLab host via GITLAB_URL', () => {
    process.env.GITLAB_URL = 'https://gitlab.example.com';
    expect(detectProvider('https://gitlab.example.com/group/repo')).toBe('gitlab');
    expect(detectProvider('git@gitlab.example.com:group/repo.git')).toBe('gitlab');
  });

  it('detects a self-hosted GitLab host via TEAMAI_GITLAB_HOST', () => {
    process.env.TEAMAI_GITLAB_HOST = 'gitlab.example.com';
    expect(detectProvider('https://gitlab.example.com/group/repo')).toBe('gitlab');
  });

  it('the factory returns a GitLabProvider named "gitlab"', () => {
    const p = getProvider('gitlab');
    expect(p).toBeInstanceOf(GitLabProvider);
    expect(p.name).toBe('gitlab');
    expect(p.getDefaultEmailDomain()).toBeNull();
  });
});

// ─── token resolution ───────────────────────────────────

describe('getGitLabToken', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads GITLAB_TOKEN', () => {
    process.env.GITLAB_TOKEN = 'glpat_aaa';
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    expect(getGitLabToken()).toBe('glpat_aaa');
  });

  it('falls back to GITLAB_PRIVATE_TOKEN', () => {
    delete process.env.GITLAB_TOKEN;
    process.env.GITLAB_PRIVATE_TOKEN = 'glpat_bbb';
    delete process.env.GITLAB_PAT;
    expect(getGitLabToken()).toBe('glpat_bbb');
  });

  it('falls back to GITLAB_PAT', () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    process.env.GITLAB_PAT = 'glpat_ccc';
    expect(getGitLabToken()).toBe('glpat_ccc');
  });

  it('returns null when none is set', () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    expect(getGitLabToken()).toBeNull();
  });
});

// ─── gitlabIsAuthenticated ──────────────────────────────

describe('gitlabIsAuthenticated', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns true when GITLAB_TOKEN is set', () => {
    process.env.GITLAB_TOKEN = 'glpat_xxx';
    expect(gitlabIsAuthenticated()).toBe(true);
  });

  it('returns false when no token is set', () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    expect(gitlabIsAuthenticated()).toBe(false);
  });
});

// ─── gitlabRepoClone ────────────────────────────────────

describe('gitlabRepoClone', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws GitLabRepoNotFoundError when remote does not exist', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'remote: The project you were looking for could not be found.',
    });
    expect(() => gitlabRepoClone('org/missing', '/tmp/clone')).toThrow(GitLabRepoNotFoundError);
  });

  it('injects the token via http.extraHeader, never into the clone URL', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "Cloning into '/tmp/clone'...",
      stderr: '',
    });
    expect(() => gitlabRepoClone('org/repo', '/tmp/clone')).not.toThrow();
    const args = mockedSpawnSync.mock.calls[0][1] as string[];
    // -c http.extraHeader=Authorization: Basic <base64(oauth2:token)>
    expect(args[0]).toBe('-c');
    const expectedHeader = `http.extraHeader=Authorization: Basic ${Buffer.from('oauth2:glpat_secret').toString('base64')}`;
    expect(args[1]).toBe(expectedHeader);
    expect(args[2]).toBe('clone');
    // The token must NOT appear anywhere in the clone URL.
    const cloneUrlArg = args.find((a) => a.endsWith('.git'));
    expect(cloneUrlArg).toBeDefined();
    expect(cloneUrlArg).not.toContain('glpat_secret');
    expect(cloneUrlArg).not.toContain('oauth2:');
    // And the raw token must not appear in any argument.
    expect(args.some((a) => a.includes('glpat_secret'))).toBe(false);
  });

  it('clones anonymously (no auth header) when no token is set', () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    gitlabRepoClone('org/repo', '/tmp/clone');
    const args = mockedSpawnSync.mock.calls[0][1] as string[];
    expect(args[0]).toBe('clone');
    expect(args.some((a) => a.includes('http.extraHeader'))).toBe(false);
  });

  it('sanitizes credentials from error output via the shared helper', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      // git echoes the full URL (with any embedded userinfo) on access errors.
      stderr: "fatal: unable to access 'https://oauth2:glpat_secret@gitlab.example.com/org/repo.git/': The requested URL returned error: 403",
    });
    const err = (() => { try { gitlabRepoClone('org/repo', '/tmp/clone'); return null; } catch (e) { return e as Error; } })();
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain('glpat_secret');
    expect(err!.message).toContain('***@');
  });
});

// ─── gitlabWhoami ───────────────────────────────────────

describe('gitlabWhoami', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns the username from /user', async () => {
    process.env.GITLAB_TOKEN = 'glpat_test';
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
    }) as never;
    expect(await gitlabWhoami()).toBe('alice');
  });

  it('returns null when the API call fails', async () => {
    process.env.GITLAB_TOKEN = 'glpat_test';
    global.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as never;
    expect(await gitlabWhoami()).toBeNull();
  });

  it('returns null when no token is set', async () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    expect(await gitlabWhoami()).toBeNull();
  });
});

// ─── gitlabCreateRepo ───────────────────────────────────

describe('gitlabCreateRepo', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITLAB_TOKEN = 'glpat_test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates a repo under the authenticated user namespace', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
      }
      if (url.endsWith('/projects')) {
        return new Response(JSON.stringify({ name: 'repo' }), { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await expect(gitlabCreateRepo('alice', 'repo')).resolves.toBeUndefined();

    const calls = (global.fetch as Mock).mock.calls;
    expect(calls.some(([u]) => String(u).endsWith('/projects'))).toBe(true);
  });

  it('resolves a group namespace when owner differs from login', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
      }
      if (url.includes('/groups/')) {
        return new Response(JSON.stringify({ id: 7, full_path: 'teamai' }), { status: 200 });
      }
      if (url.endsWith('/projects')) {
        const body = JSON.parse(String((global.fetch as Mock).mock.calls.find(
          ([u]) => String(u).endsWith('/projects'),
        )?.[1]?.body ?? '{}'));
        expect(body.namespace_id).toBe(7);
        return new Response(JSON.stringify({ name: 'cli' }), { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await expect(gitlabCreateRepo('teamai', 'cli')).resolves.toBeUndefined();
  });

  it('throws on non-OK response', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
      }
      if (url.includes('/groups/')) {
        return new Response(JSON.stringify({ id: 7, full_path: 'teamai' }), { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }) as never;

    await expect(gitlabCreateRepo('teamai', 'cli')).rejects.toThrow(/403/);
  });

  it('refuses to fall back to the personal namespace when the group is unknown', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
      }
      if (url.includes('/groups/')) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ name: 'cli' }), { status: 201 });
    }) as never;

    // Posting without namespace_id would silently create alice/cli instead.
    await expect(gitlabCreateRepo('platform-team', 'cli')).rejects.toThrow(/namespace/i);
    const posted = (global.fetch as Mock).mock.calls.some(
      ([u, init]) => String(u).endsWith('/projects') && init?.method === 'POST',
    );
    expect(posted).toBe(false);
  });

  it('throws when no token is available', async () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    await expect(gitlabCreateRepo('teamai', 'cli')).rejects.toThrow(/GITLAB_TOKEN/);
  });
});

// ─── gitlabMrCreate ─────────────────────────────────────

describe('gitlabMrCreate', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITLAB_TOKEN = 'glpat_test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates MR and returns web_url', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ iid: 42, web_url: 'https://gitlab.com/org/repo/-/merge_requests/42' }),
        { status: 201 },
      );
    }) as never;

    const url = await gitlabMrCreate({
      repo: 'org/repo',
      source: 'feat/x',
      target: 'main',
      title: 'Feat x',
      description: 'body',
    });

    expect(url).toBe('https://gitlab.com/org/repo/-/merge_requests/42');
  });

  it('resolves reviewers to user IDs and sends reviewer_ids', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('/users?')) {
        return new Response(JSON.stringify([{ id: 5, username: 'alice' }]), { status: 200 });
      }
      if (String(url).endsWith('/merge_requests')) {
        const body = JSON.parse(String(init?.body));
        expect(body.reviewer_ids).toEqual([5]);
        return new Response(
          JSON.stringify({ iid: 1, web_url: 'https://gitlab.com/org/repo/-/merge_requests/1' }),
          { status: 201 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await gitlabMrCreate({
      repo: 'org/repo',
      source: 'feat/y',
      target: 'main',
      title: 'Y',
      reviewers: ['alice'],
    });

    expect(calls.some((u) => u.includes('/users?'))).toBe(true);
  });

  it('throws on non-OK response from merge_requests endpoint', async () => {
    global.fetch = vi.fn(async () => new Response('Validation failed', { status: 422 })) as never;

    await expect(
      gitlabMrCreate({
        repo: 'org/repo',
        source: 'feat/z',
        target: 'main',
        title: 'Z',
      }),
    ).rejects.toThrow(/422/);
  });
});

// ─── GitLabProvider surface ─────────────────────────────

describe('GitLabProvider', () => {
  it('is returned when getProvider("gitlab") is called', () => {
    const p = getProvider('gitlab');
    expect(p).toBeInstanceOf(GitLabProvider);
  });

  it('parseRepoInput delegates to repo-url parser', () => {
    const p = new GitLabProvider();
    const info = p.parseRepoInput('org/repo');
    expect(info.httpsUrl).toBe(`https://${GITLAB_HOST}/org/repo.git`);
  });
});


// ─── regressions: URL / host handling ───────────────────

describe('parseGitLabRepoInput — GitLab route paths', () => {
  it('strips the /-/ route so a browser URL yields the project, not the route', () => {
    const info = parseGitLabRepoInput('https://gitlab.com/org/repo/-/tree/main');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
    expect(info.httpsUrl).toBe('https://gitlab.com/org/repo.git');
  });

  it('strips /-/ for nested groups and for MR URLs', () => {
    expect(parseGitLabRepoInput('https://gl.example.com/g/sub/repo/-/merge_requests/42'))
      .toMatchObject({ owner: 'g/sub', repo: 'repo' });
    expect(parseGitLabRepoInput('https://gitlab.com/org/repo/-/blob/main/README.md'))
      .toMatchObject({ owner: 'org', repo: 'repo' });
  });
});

describe('gitlabBaseUrl', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to the public host', () => {
    delete process.env.GITLAB_URL;
    expect(gitlabBaseUrl()).toBe('https://gitlab.com');
  });

  it('keeps scheme, port and path prefix of a self-hosted instance', () => {
    process.env.GITLAB_URL = 'http://gitlab.internal:8929/gitlab/';
    expect(gitlabBaseUrl()).toBe('http://gitlab.internal:8929/gitlab');
  });

  it('rejects a GITLAB_URL without a scheme instead of silently diverging', () => {
    process.env.GITLAB_URL = 'gitlab.example.com';
    expect(() => gitlabBaseUrl()).toThrow(/Invalid GITLAB_URL/);
  });
});

describe('getGitLabToken — blank handling', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('treats an empty token as absent', () => {
    process.env.GITLAB_TOKEN = '';
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    expect(getGitLabToken()).toBeNull();
    expect(gitlabIsAuthenticated()).toBe(false);
  });

  it('falls through a blank primary to a set alias, and trims', () => {
    process.env.GITLAB_TOKEN = '   ';
    process.env.GITLAB_PRIVATE_TOKEN = 'glpat_real\n';
    expect(getGitLabToken()).toBe('glpat_real');
  });
});

describe('gitlabRepoClone — self-hosted clone URL', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpawnSync.mockReset();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('preserves scheme, port and path prefix in the clone URL — without the token', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    process.env.GITLAB_URL = 'http://gitlab.internal:8929/gitlab';
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    gitlabRepoClone('group/repo', '/tmp/clone');

    const args = mockedSpawnSync.mock.calls[0][1] as string[];
    const cloneTarget = args.find((a) => a.endsWith('.git'));
    // URL keeps the self-hosted scheme/port/prefix but carries NO credentials.
    expect(cloneTarget).toBe('http://gitlab.internal:8929/gitlab/group/repo.git');
    // Token travels in the extraHeader instead.
    const expectedHeader = `http.extraHeader=Authorization: Basic ${Buffer.from('oauth2:glpat_secret').toString('base64')}`;
    expect(args).toContain(expectedHeader);
    expect(args.some((a) => a.includes('glpat_secret') && a.endsWith('.git'))).toBe(false);
  });
});

// ─── mr-fetch ───────────────────────────────────────────

describe('fetchGitLabMR', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITLAB_TOKEN = 'glpat_test';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('queries the MR URL host when it matches the configured instance', async () => {
    // Default GITLAB_HOST in the test process is gitlab.com; an MR URL on that
    // host is trusted and the token is sent to it.
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('/changes')) {
        return new Response(JSON.stringify({ changes: [{ diff: '@@ -1 +1 @@' }] }), { status: 200 });
      }
      if (String(url).includes('/commits')) {
        return new Response(JSON.stringify([{ id: 'abc123', title: 'first' }]), { status: 200 });
      }
      return new Response(
        JSON.stringify({ title: 'T', description: 'D', author: { username: 'bob' } }),
        { status: 200 },
      );
    }) as never;

    const mr = await fetchGitLabMR('https://gitlab.com/team/repo/-/merge_requests/42');

    expect(seen.every((u) => u.startsWith('https://gitlab.com/api/v4/'))).toBe(true);
    expect(mr.title).toBe('T');
    expect(mr.author).toBe('bob');
    expect(mr.commits).toEqual([{ hash: 'abc123', message: 'first' }]);
    expect(mr.diff).toContain('@@');
  });

  it('refuses to send the token to a host that is not the configured instance (SSRF guard)', async () => {
    // GITLAB_HOST defaults to gitlab.com; an MR URL on a different host must be
    // rejected BEFORE any network call, so the PAT is never exfiltrated.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as never;

    await expect(
      fetchGitLabMR('https://git.corp.example.com/team/repo/-/merge_requests/42'),
    ).rejects.toThrow(/does not match the configured GitLab instance/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('encodes a nested group path into the project id', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ title: 'T', description: null, author: { username: 'a' } }),
        { status: 200 },
      );
    }) as never;

    await fetchGitLabMR('https://gitlab.com/g/sub/repo/-/merge_requests/7');
    expect(seen[0]).toContain('/projects/g%2Fsub%2Frepo/merge_requests/7');
  });

  it('throws an English error on a non-OK response', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as never;
    await expect(
      fetchGitLabMR('https://gitlab.com/org/repo/-/merge_requests/1'),
    ).rejects.toThrow(/GitLab API error 500/);
  });

  it('rejects a URL that is not a GitLab MR', async () => {
    await expect(fetchGitLabMR('https://gitlab.com/org/repo')).rejects.toThrow(/Invalid GitLab MR URL/);
  });
});

// ─── org listing ────────────────────────────────────────

describe('gitlabListOrgRepos', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITLAB_TOKEN = 'glpat_test';
    delete process.env.GITLAB_URL;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  const project = (id: number, path: string) => ({
    id,
    name: path.split('/').pop(),
    path_with_namespace: path,
    http_url_to_repo: `https://gitlab.com/${path}.git`,
    archived: false,
    star_count: id,
    last_activity_at: '2026-01-01T00:00:00Z',
  });

  it('requests subgroup projects too', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify([project(1, 'g/sub/repo')]), { status: 200 });
    }) as never;

    const repos = await gitlabListOrgRepos('g');

    expect(seen[0]).toContain('include_subgroups=true');
    expect(repos).toHaveLength(1);
    expect(repos[0].fullName).toBe('g/sub/repo');
  });

  it('paginates until a short page and honours maxRepos', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => project(i, `g/repo-${i}`));
    global.fetch = vi.fn(async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      return new Response(JSON.stringify(page === 1 ? page1 : [project(999, 'g/last')]), {
        status: 200,
      });
    }) as never;

    expect(await gitlabListOrgRepos('g')).toHaveLength(101);
    expect(await gitlabListOrgRepos('g', { maxRepos: 5 })).toHaveLength(5);
  });

  it('reports a missing group distinctly from other HTTP errors', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as never;
    await expect(gitlabListOrgRepos('ghost')).rejects.toThrow(/not found or no access/);

    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as never;
    await expect(gitlabListOrgRepos('g')).rejects.toThrow(/HTTP 500/);
  });

  it('requires a token', async () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    await expect(gitlabListOrgRepos('g')).rejects.toThrow(/GitLab token unavailable/);
  });
});
