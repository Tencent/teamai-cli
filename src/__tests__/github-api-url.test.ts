import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubApiUrl } from '../providers/github/api-url.js';
import { ghFetchLogin } from '../providers/github/gh-cli.js';
import { ghListOrgRepos } from '../providers/github/gh-org.js';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';

vi.mock('../providers/github/gh-cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providers/github/gh-cli.js')>(),
  ghExec: vi.fn(() => { throw new Error('gh unavailable'); }),
  isGhInstalled: vi.fn(() => false),
}));
vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

/** A GitHub Enterprise stand-in: its API lives under /api/v3 and speaks plain http. */
const ROOT_PATH = '/api/v3';
const requested: string[] = [];
let server: http.Server;
let root: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    requested.push(path);
    const route = path.slice(ROOT_PATH.length).split('?')[0];
    const body = !path.startsWith(ROOT_PATH) ? null
      : route === '/user' ? { login: 'octocat' }
      : route === '/orgs/acme/repos' ? [{ clone_url: 'https://ghe.example/acme/tool.git', full_name: 'acme/tool', name: 'tool' }]
      : route === '/repos/team/repo/pulls/42' ? (String(req.headers.accept).includes('.diff') ? 'diff --git a/a b/a\n' : { title: 'Fix retries', body: null, user: { login: 'dev' }, merged_at: null })
      : route === '/repos/team/repo/pulls/42/commits' ? [{ sha: 'abc123', commit: { message: 'Fix retries' } }]
      : [];
    res.statusCode = body === null ? 404 : 200;
    res.end(typeof body === 'string' ? body : JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ROOT_PATH}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requested.length = 0;
  vi.stubEnv('GITHUB_API_URL', root);
  vi.stubEnv('GITHUB_TOKEN', 'fake-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GITHUB_API_URL', () => {
  it('names the API root, without a trailing slash, and falls back to github.com when unset or blank', () => {
    vi.stubEnv('GITHUB_API_URL', ' https://ghe.example/api/v3/// ');
    expect(githubApiUrl()).toBe('https://ghe.example/api/v3');
    vi.stubEnv('GITHUB_API_URL', '  ');
    expect(githubApiUrl()).toBe('https://api.github.com');
    vi.stubEnv('GITHUB_API_URL', '');
    expect(githubApiUrl()).toBe('https://api.github.com');
  });

  it('is where ghFetchLogin asks for the user', async () => {
    expect(await ghFetchLogin('fake-token')).toBe('octocat');
    expect(requested).toEqual([`${ROOT_PATH}/user`]);
  });

  it('is where ghListOrgRepos lists an organisation', async () => {
    const repos = await ghListOrgRepos('acme');
    expect(repos.map((r) => r.fullName)).toEqual(['acme/tool']);
    expect(requested.every((p) => p.startsWith(`${ROOT_PATH}/orgs/acme/repos`))).toBe(true);
  });

  it('is where the REST fallback of fetchGitHubPR reads the pull request, over http and under the root path', async () => {
    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false });
    expect(mr.title).toBe('Fix retries');
    expect(mr.diff).toContain('diff --git');
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((p) => p.startsWith(`${ROOT_PATH}/repos/team/repo/pulls/42`))).toBe(true);
  });
});
