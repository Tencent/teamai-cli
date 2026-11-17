import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/github/gh-cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providers/github/gh-cli.js')>(),
  ghExec: vi.fn(() => { throw new Error('gh unavailable'); }),
  isGhInstalled: vi.fn().mockReturnValue(false),
}));
import { ghCreateRepo, ghFetchLogin, isGhInstalled } from '../providers/github/gh-cli.js';
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));
vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';
import { ghListOrgRepos } from '../providers/github/gh-org.js';
import { DefaultFolders } from '../default-folders.js';
import { computeMrHintOutput } from '../mr-hint.js';

const ROOT = 'https://ghe.example.com/api/v3';

beforeEach(() => {
  vi.stubEnv('GITHUB_API_URL', ROOT);
  vi.stubEnv('GITHUB_TOKEN', 'ghe-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GITHUB_API_URL is honored by every GitHub REST call', () => {
  it('ghFetchLogin requests the env root', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify({ login: 'dev' }), { status: 200 }));
    }));

    const login = await ghFetchLogin('token');
    expect(login).toBe('dev');
    expect(seen[0]).toBe(`${ROOT}/user`);
  });

  it('ghCreateRepo requests the env root for a foreign org', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response('{}', { status: 201 }));
    }));

    await ghCreateRepo('acme', 'shop');
    // ghCreateRepo reads the login first to tell an org from the member's own account.
    expect(seen).toContain(`${ROOT}/orgs/acme/repos`);
  });

  it('ghListOrgRepos requests the env root when gh is unavailable', async () => {
    expect(isGhInstalled()).toBe(false);
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify([
        { clone_url: `${ROOT}/acme/shop.git`, full_name: 'acme/shop', name: 'shop', stargazers_count: 3 },
      ]), { status: 200 }));
    }));

    const repos = await ghListOrgRepos('acme');
    expect(repos.map(r => r.name)).toContain('shop');
    expect(seen[0]).toBe(`${ROOT}/orgs/acme/repos?per_page=100&page=1`);
  });

  it('fetchGitHubPR sends its REST fallback to the env root', async () => {
    const PR = '/repos/team/repo/pulls/42';
    const seenPaths: string[] = [];
    const request = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
      seenPaths.push(String(options.path));
      const accept = String((options.headers as Record<string, string>)?.Accept ?? '');
      const beforeQuery = (String(options.path).startsWith('/api/v3') ? String(options.path).slice('/api/v3'.length) : String(options.path)).split('?')[0];
      const body = accept.includes('.diff') ? 'diff --git a/a b/a\n+fixed\n'
        // List endpoints (commits, threads) answer with an array; the rest with the PR.
        : beforeQuery === PR ? JSON.stringify({ title: 'Fix retries', body: null, user: { login: 'dev' }, merged_at: null })
        : '[]';
      // The response is a real emitter: its own `on` would fire the body before a
      // handler attaches, so the body is emitted only after the callback runs.
      const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as IncomingMessage;
      process.nextTick(() => {
        callback(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      });
      return Object.assign(new EventEmitter(), { end: () => {}, setTimeout: () => {}, destroy: () => {} });
    };
    vi.spyOn(https, 'request').mockImplementation(request as unknown as typeof https.request);

    const data = await fetchGitHubPR('https://github.com/team/repo/pull/42');
    expect(data.title).toBe('Fix retries');
    expect(seenPaths).toContain(`/api/v3${PR}`);
    expect(seenPaths.every(p => p.startsWith('/api/v3/'))).toBe(true);
  });

  it('fetchGitHubPR sends an http root over node:http', async () => {
    const seen: https.RequestOptions[] = [];
    vi.stubEnv('GITHUB_API_URL', 'http://127.0.0.1:3999/api/v3');
    const spy = vi.spyOn(http, 'request').mockImplementation(((options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
      seen.push(options);
      const req = Object.assign(new EventEmitter(), {
        end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as IncomingMessage;
          process.nextTick(() => {
            callback(res);
            process.nextTick(() => {
              // The PR metadata reads first; the list endpoints after it answer with arrays.
              const body = seen.length === 1
                ? JSON.stringify({ title: 'Fix retries', body: null, user: { login: 'dev' }, merged_at: null })
                : '[]';
              res.emit('data', Buffer.from(body));
              res.emit('end');
            });
          });
        },
        on: () => req,
        setTimeout: () => req,
        destroy: () => {},
      }) as unknown as ReturnType<typeof http.request>;
      return req;
    }) as typeof http.request);

    const data = await fetchGitHubPR('https://github.com/team/repo/pull/42');
    expect(data.title).toBe('Fix retries');
    expect(spy).toHaveBeenCalled();
    // Every request the HTTPS client never sees still went to the http root.
    expect(seen.map(o => String(o.path))).toContain('/api/v3/repos/team/repo/pulls/42');
  });
});

describe('mr-hint REST fallback honors GITHUB_API_URL', () => {
  it('lists merged MRs from the env root when gh fails', async () => {
    const mrHint = await DefaultFolders.load({ kind: 'hooks', name: 'teamai-mr-hint' }, null);
    if (!mrHint) throw new Error('mr-hint hook folder not found');
    const at = (id: string) => ({
      sessionId: id,
      cwd: process.cwd(),
      run: { runMode: 'attended' as const },
    });
    // mr-hint imports spawnSync itself; the hoisted module mock above supplies it.
    const childProcess = await import('node:child_process');

    vi.mocked(childProcess.spawnSync).mockImplementation(() => ({
      pid: 0, output: [null, '', 'error'], stdout: '', stderr: 'error', status: 1, signal: null,
    }));
    // The hook finds the repo from the git remote and needs it to be the one the mock answers for.
    const git = await import('../utils/git.js');
    vi.spyOn(git, 'getRemoteUrl').mockResolvedValue('https://github.com/acme/shop.git');

    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify([
        { number: 7, title: 'Fix the login redirect', html_url: `${ROOT}/acme/shop/pull/7`, merged_at: '2026-11-01T00:00:00Z' },
      ]), { status: 200 }));
    }));

    await computeMrHintOutput('en', null, at('s1'));
    expect(seen[0]).toContain(`${ROOT}/repos/acme/shop/pulls`);
  });
});
