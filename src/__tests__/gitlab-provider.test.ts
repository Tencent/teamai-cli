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
  GitLabRepoNotFoundError,
} from '../providers/gitlab/gitlab-api.js';
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

  it('succeeds when git clone exits 0', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "Cloning into '/tmp/clone'...",
      stderr: '',
    });
    expect(() => gitlabRepoClone('org/repo', '/tmp/clone')).not.toThrow();
    const args = mockedSpawnSync.mock.calls[0][1];
    expect(args[0]).toBe('clone');
    expect(args[1]).toContain('oauth2:glpat_secret@');
  });

  it('sanitizes token from error output', () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: Authentication failed for host oauth2:glpat_secret@gitlab.example.com',
    });
    expect(() => gitlabRepoClone('org/repo', '/tmp/clone')).toThrow(/oauth2:\*\*\*@/);
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
      if (url.includes('/namespaces?')) {
        return new Response(
          JSON.stringify([{ id: 7, full_path: 'teamai' }]),
          { status: 200 },
        );
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
      return new Response('Forbidden', { status: 403 });
    }) as never;

    await expect(gitlabCreateRepo('teamai', 'cli')).rejects.toThrow(/403/);
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
