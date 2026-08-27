import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
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

import { execSync, spawnSync } from 'node:child_process';
import { parseGitHubRepoInput } from '../providers/github/repo-url.js';
import {
  ghPrCreate,
  ghCreateRepo,
  ghRepoClone,
  ghIsAuthenticated,
  getGitHubToken,
  RepoNotFoundError,
} from '../providers/github/gh-cli.js';
import { detectProvider, getProvider } from '../providers/registry.js';
import { GitHubProvider } from '../providers/github/index.js';

const mockedExecSync = execSync as Mock;
const mockedSpawnSync = spawnSync as Mock;

// ─── repo-url parsing ───────────────────────────────────

describe('parseGitHubRepoInput', () => {
  it('parses bare owner/repo', () => {
    const info = parseGitHubRepoInput('teamai/teamai-cli');
    expect(info.owner).toBe('teamai');
    expect(info.repo).toBe('teamai-cli');
    expect(info.httpsUrl).toBe('https://github.com/teamai/teamai-cli.git');
    expect(info.projectId).toBe('teamai/teamai-cli');
  });

  it('parses https URL with .git', () => {
    const info = parseGitHubRepoInput('https://github.com/org/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
  });

  it('parses https URL without .git', () => {
    const info = parseGitHubRepoInput('https://github.com/org/repo');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
  });

  it('parses ssh URL', () => {
    const info = parseGitHubRepoInput('git@github.com:org/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
  });

  it('rejects multi-segment owners (no subgroups on GitHub)', () => {
    expect(() => parseGitHubRepoInput('group/sub/repo')).toThrow(
      /Unrecognized GitHub repo format/,
    );
  });

  it('rejects non-GitHub URLs', () => {
    expect(() => parseGitHubRepoInput('https://git.woa.com/org/repo.git')).toThrow(
      /Unrecognized GitHub repo format/,
    );
  });
});

// ─── provider detection ─────────────────────────────────

describe('detectProvider', () => {
  it('detects github from https URL', () => {
    expect(detectProvider('https://github.com/org/repo')).toBe('github');
  });

  it('detects github from ssh URL', () => {
    expect(detectProvider('git@github.com:org/repo.git')).toBe('github');
  });

  it('detects tgit from git.woa.com URLs', () => {
    expect(detectProvider('https://git.woa.com/team/repo')).toBe('tgit');
    expect(detectProvider('git@git.woa.com:team/repo.git')).toBe('tgit');
  });

  it('defaults bare owner/repo to github', () => {
    expect(detectProvider('org/repo')).toBe('github');
  });

  it('uses generic git for unknown hosts', () => {
    expect(detectProvider('https://gitea.example.com/org/repo')).toBe('git');
  });
});

// ─── auth token resolution ──────────────────────────────

describe('getGitHubToken', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghp_aaa';
    delete process.env.GH_TOKEN;
    expect(getGitHubToken()).toBe('ghp_aaa');
  });

  it('falls back to GH_TOKEN', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'ghp_bbb';
    expect(getGitHubToken()).toBe('ghp_bbb');
  });

  it('returns null when neither is set', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(getGitHubToken()).toBeNull();
  });
});

// ─── ghIsAuthenticated ──────────────────────────────────

describe('ghIsAuthenticated', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns true when GITHUB_TOKEN is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_xxx';
    expect(ghIsAuthenticated()).toBe(true);
  });

  it('returns false when no gh, no token', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    mockedExecSync.mockImplementation(() => {
      throw new Error('command not found: gh');
    });
    expect(ghIsAuthenticated()).toBe(false);
  });
});

// ─── ghRepoClone ────────────────────────────────────────

describe('ghRepoClone', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpawnSync.mockReset();
    mockedExecSync.mockReset();
    // no gh CLI, no token by default
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws RepoNotFoundError when remote does not exist', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'remote: Repository not found.',
    });
    expect(() => ghRepoClone('org/missing', '/tmp/clone')).toThrow(RepoNotFoundError);
  });

  it('succeeds when git clone exits 0', () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "Cloning into '/tmp/clone'...",
      stderr: '',
    });
    expect(() => ghRepoClone('org/repo', '/tmp/clone')).not.toThrow();
  });

  it('sanitizes token from error output', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: unable to connect to x-access-token:ghp_secret@github.com',
    });
    expect(() => ghRepoClone('org/repo', '/tmp/clone')).toThrow(/x-access-token:\*\*\*@/);
  });
});

// ─── ghCreateRepo ───────────────────────────────────────

describe('ghCreateRepo', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReset();
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates repo under authenticated user when owner matches login', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice' }), { status: 200 });
      }
      if (url.endsWith('/user/repos')) {
        return new Response(JSON.stringify({ name: 'repo' }), { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await expect(ghCreateRepo('alice', 'repo')).resolves.toBeUndefined();

    const calls = (global.fetch as Mock).mock.calls;
    expect(calls.some(([url]) => url.endsWith('/user/repos'))).toBe(true);
  });

  it('creates repo under org when owner differs from login', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice' }), { status: 200 });
      }
      if (url.includes('/orgs/teamai/repos')) {
        return new Response(JSON.stringify({ name: 'cli' }), { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await expect(ghCreateRepo('teamai', 'cli')).resolves.toBeUndefined();

    const calls = (global.fetch as Mock).mock.calls;
    expect(calls.some(([url]) => url.includes('/orgs/teamai/repos'))).toBe(true);
  });

  it('throws on non-OK response', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice' }), { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }) as never;

    await expect(ghCreateRepo('teamai', 'cli')).rejects.toThrow(/403/);
  });

  it('throws when no token is available', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    await expect(ghCreateRepo('teamai', 'cli')).rejects.toThrow(/Cannot retrieve GitHub token/);
  });
});

// ─── ghPrCreate (API fallback path) ─────────────────────

describe('ghPrCreate via REST API', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReset();
    // no gh CLI → should use API
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates PR and returns html_url', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          number: 42,
          html_url: 'https://github.com/org/repo/pull/42',
        }),
        { status: 201 },
      );
    }) as never;

    const url = await ghPrCreate({
      repo: 'org/repo',
      source: 'feat/x',
      target: 'master',
      title: 'Feat x',
      description: 'body',
    });

    expect(url).toBe('https://github.com/org/repo/pull/42');
  });

  it('requests reviewers in a separate call when provided', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({ number: 7, html_url: 'https://github.com/org/repo/pull/7' }),
          { status: 201 },
        );
      }
      if (url.includes('/requested_reviewers')) {
        return new Response('{}', { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }) as never;

    await ghPrCreate({
      repo: 'org/repo',
      source: 'feat/y',
      target: 'master',
      title: 'Y',
      reviewers: ['alice', 'bob'],
    });

    expect(calls.some((u) => u.includes('/requested_reviewers'))).toBe(true);
  });

  it('throws on non-OK response from pulls endpoint', async () => {
    global.fetch = vi.fn(async () => new Response('Validation failed', { status: 422 })) as never;

    await expect(
      ghPrCreate({
        repo: 'org/repo',
        source: 'feat/z',
        target: 'master',
        title: 'Z',
      }),
    ).rejects.toThrow(/422/);
  });
});

// ─── GitHubProvider surface ─────────────────────────────

describe('GitHubProvider', () => {
  it('is the default provider returned when name omitted', () => {
    const p = getProvider();
    expect(p.name).toBe('github');
  });

  it('is returned when getProvider("github") is called', () => {
    const p = getProvider('github');
    expect(p).toBeInstanceOf(GitHubProvider);
  });

  it('returns null for default email domain', () => {
    const p = new GitHubProvider();
    expect(p.getDefaultEmailDomain()).toBeNull();
  });

  it('parseRepoInput delegates to repo-url parser', () => {
    const p = new GitHubProvider();
    const info = p.parseRepoInput('org/repo');
    expect(info.httpsUrl).toBe('https://github.com/org/repo.git');
  });
});
