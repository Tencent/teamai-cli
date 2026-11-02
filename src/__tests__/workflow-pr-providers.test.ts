import { expectTypeOf } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../providers/github/index.js';
import { GitLabProvider } from '../providers/gitlab/index.js';
import { TGitProvider } from '../providers/tgit/index.js';
import { GitCodeProvider } from '../providers/gitcode/index.js';
import { GenericGitProvider } from '../providers/git/index.js';
import { providerForRemote } from '../providers/registry.js';
import type { CommitRef, GitProvider, PullRequestLookup, PullRequestRef } from '../providers/types.js';
import { fakeGh, resolveGh } from './helpers/fake-gh.js';

const ref: PullRequestRef = { repo: 'acme/app', source: 'teamai/run/work/p1', target: 'main', timeoutMs: 3000 };
const pull = (head: string, repo = 'acme/app', number = 7) => ({
  state: 'open', html_url: `https://github.com/acme/app/pull/${number}`, head: { ref: head, repo: { full_name: repo } }, base: { ref: 'main', repo: { full_name: 'acme/app' } },
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function lookup(): PullRequestLookup {
  const found = new GitHubProvider().pullRequests;
  if (!found) throw new Error('GitHub has no pull request lookup');
  return found;
}

describe('GitHub pull request lookup', () => {
  it('finds the open request of this repository branch into the target, never a fork with the same branch name', async () => {
    resolveGh(null);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([pull(ref.source, 'fork/app', 6), pull('other'), pull(ref.source)])));
    vi.stubGlobal('fetch', fetcher);

    expect(await lookup().findOpen(ref)).toBe('https://github.com/acme/app/pull/7');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([url.pathname, url.searchParams.get('state'), url.searchParams.get('head'), url.searchParams.get('base')])
      .toEqual(['/repos/acme/app/pulls', 'open', `acme:${ref.source}`, 'main']);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([pull(ref.source, 'fork/app', 6)])));
    expect(await lookup().findOpen(ref)).toBeUndefined();
  });

  it('asks an installed gh with prompts off, and never logs in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-gh-'));
    dirs.push(dir);
    const gh = fakeGh(dir, { open: [pull(ref.source)] });

    expect(await lookup().findOpen(ref)).toBe('https://github.com/acme/app/pull/7');
    expect(gh.calls()).toMatchObject([{ args: ['api', expect.stringMatching(/^repos\/acme\/app\/pulls\?/)], prompt: '0' }]);
  });

  it('keeps the process running while gh answers, and gives up on a gh that does not answer in time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-gh-'));
    dirs.push(dir);
    fakeGh(dir, { hold: 'lookup', open: [pull(ref.source)] });
    await expect(lookup().findOpen({ ...ref, timeoutMs: 300 })).rejects.toThrow('gh could not look up open pull requests');

    // Only a timer of this process lets gh answer, so a lookup that blocked the process would time out instead.
    const release = setTimeout(() => fs.writeFileSync(path.join(dir, 'release'), ''), 50);
    try {
      expect(await lookup().findOpen({ ...ref, timeoutMs: 5000 })).toBe('https://github.com/acme/app/pull/7');
    } finally {
      clearTimeout(release);
    }
  });

  it('ends the lookup at its deadline when a launcher child keeps the output pipe open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gh-launcher-'));
    dirs.push(dir);
    const launcher = path.join(dir, 'gh');
    const pidFile = path.join(dir, 'holder.pid');
    fs.writeFileSync(launcher, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    resolveGh(launcher);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // macOS may take over 300 ms to start a newly written executable.
    const timeoutMs = 3000;
    let holder: number | undefined;
    const answer = lookup().findOpen({ ...ref, timeoutMs }).then(() => 'found', () => 'failed');
    try {
      await expect.poll(() => fs.existsSync(pidFile), { timeout: 2500 }).toBe(true);
      holder = Number(fs.readFileSync(pidFile, 'utf8'));
      const result = await Promise.race([
        answer,
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve('still waiting for the pipe'), timeoutMs + 1000); }),
      ]);
      expect(result).toBe('failed');
    } finally {
      clearTimeout(deadline);
      if (holder !== undefined) process.kill(holder, 'SIGKILL');
      await answer;
    }
  });

  it('fails, rather than finding nothing, without credentials or on an answer it cannot read, and never repeats what GitHub said', async () => {
    resolveGh(null);
    vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', '');
    await expect(lookup().findOpen(ref)).rejects.toThrow('GitHub credentials are unavailable');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('private-token-in-body', { status: 403 })));
    await expect(lookup().findOpen(ref)).rejects.toThrow(/^GitHub answered the open pull request lookup with HTTP 403\.(?!.*private-token-in-body)/);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: 'private-token-in-body' }))));
    await expect(lookup().findOpen(ref)).rejects.toThrow(/^GitHub answered the open pull request lookup with data TeamAI cannot read\.$/);
  });
});

const SHA = 'c'.repeat(40);
const commit: CommitRef = { repo: 'acme/app', commit: SHA, timeoutMs: 3000 };
const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });
type CombinedStatus = { state: string; total_count: number; statuses: Array<{ state: string }> };

/** Answers GitHub's check runs and combined status of a commit, by path. */
/** The combined status GitHub answers for commit statuses in `states`: its state as GitHub combines them, and each context. */
function statuses(...states: string[]): CombinedStatus {
  const state = states.some((each) => each === 'failure' || each === 'error') ? 'failure' : states.includes('pending') || states.length === 0 ? 'pending' : 'success';
  return { state, total_count: states.length, statuses: states.map((each) => ({ state: each })) };
}

function githubAnswering(runs: unknown[], status: CombinedStatus) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith('/check-runs')) return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }));
    if (pathname.endsWith('/status')) return new Response(JSON.stringify(status));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('GitHub commit checks', () => {
  beforeEach(() => {
    resolveGh(null);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
  });

  it.each([
    ['a check run that failed', [run('completed', 'success'), run('completed', 'failure')], statuses(), 'failed'],
    ['a check run that timed out', [run('completed', 'timed_out')], statuses(), 'failed'],
    ['a commit status that failed', [run('completed', 'success')], statuses('failure'), 'failed'],
    ['a check run still running', [run('completed', 'success'), run('in_progress')], statuses(), 'pending'],
    ['a failed check run while another still runs', [run('completed', 'failure'), run('in_progress')], statuses(), 'pending'],
    ['a failed check run while a commit status is pending', [run('completed', 'failure')], statuses('pending'), 'pending'],
    // GitHub's combined state is failure here, though one context has not finished.
    ['a failed commit status while another is pending', [run('completed', 'success')], statuses('failure', 'pending'), 'pending'],
    ['more commit statuses than one page shows', [run('completed', 'success')], { ...statuses('failure'), total_count: 101 }, 'pending'],
    ['a commit status still pending', [run('completed', 'success')], statuses('pending', 'success'), 'pending'],
    ['every check passed or skipped', [run('completed', 'success'), run('completed', 'skipped')], statuses('success'), 'passed'],
    ['no check at all', [], statuses(), 'none'],
    ['only cancelled check runs', [run('completed', 'cancelled')], statuses(), 'none'],
  ])('reads %s', async (_case, runs, status, expected) => {
    const fetcher = githubAnswering(runs, status);

    expect(await lookup().checks?.(commit)).toBe(expected);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname).sort())
      .toEqual([`/repos/acme/app/commits/${SHA}/check-runs`, `/repos/acme/app/commits/${SHA}/status`]);
  });

  it('asks an installed gh with prompts off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-gh-'));
    dirs.push(dir);
    const gh = fakeGh(dir, { checks: { runs: [run('completed', 'failure')] } });

    expect(await lookup().checks?.(commit)).toBe('failed');
    expect(gh.calls().sort((left, right) => String(left.args[1]).localeCompare(String(right.args[1])))).toMatchObject([
      { args: ['api', `repos/acme/app/commits/${SHA}/check-runs?per_page=100`], prompt: '0' },
      { args: ['api', `repos/acme/app/commits/${SHA}/status?per_page=100`], prompt: '0' },
    ]);
  });

  it('fails, rather than reading no checks, without credentials or on an answer it cannot read', async () => {
    vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', '');
    await expect(lookup().checks?.(commit)).rejects.toThrow('GitHub credentials are unavailable');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    answering({ message: 'private-token-in-body' }, 403);
    await expect(lookup().checks?.(commit)).rejects.toThrow(/^GitHub answered the commit checks lookup with HTTP 403\.(?!.*private-token-in-body)/);
    answering({ unexpected: true });
    await expect(lookup().checks?.(commit)).rejects.toThrow(/^GitHub answered the commit checks lookup with data TeamAI cannot read\.$/);
  });
});

describe('GitHub pull request history', () => {
  const ended = (head: string, number: number, state: 'open' | 'closed', mergedAt: string | null, repo = 'acme/app') => ({
    ...pull(head, repo, number), state, title: `Change ${number}`, created_at: `2026-10-0${number}T10:00:00Z`,
    closed_at: state === 'closed' ? `2026-10-0${number}T12:00:00Z` : null, merged_at: mergedAt,
  });

  it('lists every request of this repository branch into the target with how it ended, never a fork with the same branch name', async () => {
    resolveGh(null);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([
      ended(ref.source, 9, 'open', null), ended(ref.source, 8, 'closed', null), ended(ref.source, 6, 'closed', null, 'fork/app'),
      { ...ended(ref.source, 5, 'closed', '2026-10-05T12:00:00Z'), head: { ref: ref.source, repo: { full_name: 'acme/app' }, sha: 'h'.repeat(40) }, merge_commit_sha: 's'.repeat(40) },
    ])));
    vi.stubGlobal('fetch', fetcher);

    expect(await lookup().history(ref)).toEqual([
      { url: 'https://github.com/acme/app/pull/9', title: 'Change 9', openedAt: '2026-10-09T10:00:00Z', state: 'open' },
      { url: 'https://github.com/acme/app/pull/8', title: 'Change 8', openedAt: '2026-10-08T10:00:00Z', state: 'closed', closedAt: '2026-10-08T12:00:00Z' },
      { url: 'https://github.com/acme/app/pull/5', title: 'Change 5', openedAt: '2026-10-05T10:00:00Z', state: 'merged', closedAt: '2026-10-05T12:00:00Z', merge: { head: 'h'.repeat(40), commit: 's'.repeat(40) } },
    ]);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([url.pathname, url.searchParams.get('state'), url.searchParams.get('head'), url.searchParams.get('base')])
      .toEqual(['/repos/acme/app/pulls', 'all', `acme:${ref.source}`, 'main']);
  });

  it('fails, rather than listing nothing, on an answer it cannot read or see past', async () => {
    resolveGh(null);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([pull(ref.source)]))));
    await expect(lookup().history(ref)).rejects.toThrow(/^GitHub answered the pull request history lookup with data TeamAI cannot read\.$/);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ended(`other-${index}`, 1, 'open', null))))));
    await expect(lookup().history(ref)).rejects.toThrow('more pull requests than one page');
  });
});

function lookupOf(provider: GitProvider): PullRequestLookup {
  if (!provider.pullRequests) throw new Error(`${provider.name} has no pull request lookup`);
  return provider.pullRequests;
}

/** Answers every request with `body` as JSON and `status`, and returns the spy. */
function answering(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

/** Answers no request until its signal aborts it, as a host that never responds. */
function hanging(): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })));
}

/** An open merge request as the GitLab API lists it. */
const mr = (source: string, iid = 7, sourceProject = 1, url = `https://gitlab.com/acme/app/-/merge_requests/${iid}`) => ({
  web_url: url, state: 'opened', source_branch: source, target_branch: 'main', source_project_id: sourceProject, target_project_id: 1,
});

describe('GitLab merge request lookup', () => {
  beforeEach(() => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubEnv('GITLAB_URL', '');
    vi.stubEnv('TEAMAI_GITLAB_HOST', '');
  });

  it('finds the open request of this project branch into the target, never one from a fork with the same branch name', async () => {
    const fetcher = answering([mr(ref.source, 6, 2), mr('other', 8), mr(ref.source)]);

    expect(await lookupOf(new GitLabProvider()).findOpen(ref)).toBe('https://gitlab.com/acme/app/-/merge_requests/7');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([`${url.origin}${url.pathname}`, url.searchParams.get('state'), url.searchParams.get('source_branch'), url.searchParams.get('target_branch')])
      .toEqual(['https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests', 'opened', ref.source, 'main']);
    answering([mr(ref.source, 6, 2)]);
    expect(await lookupOf(new GitLabProvider()).findOpen(ref)).toBeUndefined();
  });

  it('fails, rather than finding nothing, without a token, on an answer it cannot read or see past, on another host, or with no answer in time', async () => {
    const gitlabLookup = lookupOf(new GitLabProvider());
    vi.stubEnv('GITLAB_TOKEN', ''); vi.stubEnv('GITLAB_PRIVATE_TOKEN', ''); vi.stubEnv('GITLAB_PAT', '');
    await expect(gitlabLookup.findOpen(ref)).rejects.toThrow('GitLab authentication unavailable');
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    answering({ message: 'private-token-in-body' }, 403);
    await expect(gitlabLookup.findOpen(ref)).rejects.toThrow(/^GitLab answered the open merge request lookup with HTTP 403\.(?!.*private-token-in-body)/);
    answering({ message: 'private-token-in-body' });
    await expect(gitlabLookup.findOpen(ref)).rejects.toThrow(/^GitLab answered the open merge request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => mr(`other-${index}`, index)));
    await expect(gitlabLookup.findOpen(ref)).rejects.toThrow('more open merge requests than one page');
    answering([mr(ref.source, 7, 1, 'https://evil.example/acme/app/-/merge_requests/7')]);
    await expect(gitlabLookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(gitlabLookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
  });

  it('lists every request of this project branch into the target with how it ended, never one from a fork', async () => {
    const at = (iid: number, state: string, ended: Record<string, string | null>) => ({ ...mr(ref.source, iid), state, title: `Change ${iid}`, created_at: `2026-10-0${iid}T10:00:00Z`, ...ended });
    const fetcher = answering([
      at(9, 'opened', { closed_at: null, merged_at: null }), at(8, 'closed', { closed_at: '2026-10-08T12:00:00Z', merged_at: null }),
      { ...at(6, 'closed', { closed_at: '2026-10-06T12:00:00Z', merged_at: null }), source_project_id: 2 },
      at(5, 'merged', { closed_at: null, merged_at: '2026-10-05T12:00:00Z', sha: 'h'.repeat(40), merge_commit_sha: null, squash_commit_sha: 's'.repeat(40) }),
      // A fast-forward merge: the head is the commit the target branch got.
      at(4, 'merged', { closed_at: null, merged_at: '2026-10-04T12:00:00Z', sha: 'f'.repeat(40), merge_commit_sha: null }),
    ]);

    expect(await lookupOf(new GitLabProvider()).history(ref)).toEqual([
      { url: 'https://gitlab.com/acme/app/-/merge_requests/9', title: 'Change 9', openedAt: '2026-10-09T10:00:00Z', state: 'open' },
      { url: 'https://gitlab.com/acme/app/-/merge_requests/8', title: 'Change 8', openedAt: '2026-10-08T10:00:00Z', state: 'closed', closedAt: '2026-10-08T12:00:00Z' },
      { url: 'https://gitlab.com/acme/app/-/merge_requests/5', title: 'Change 5', openedAt: '2026-10-05T10:00:00Z', state: 'merged', closedAt: '2026-10-05T12:00:00Z', merge: { head: 'h'.repeat(40), commit: 's'.repeat(40) } },
      { url: 'https://gitlab.com/acme/app/-/merge_requests/4', title: 'Change 4', openedAt: '2026-10-04T10:00:00Z', state: 'merged', closedAt: '2026-10-04T12:00:00Z', merge: { head: 'f'.repeat(40), commit: 'f'.repeat(40) } },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('state')).toBe('all');
    answering([{ ...at(7, 'opened', {}), web_url: 'https://evil.example/acme/app/-/merge_requests/7' }]);
    await expect(lookupOf(new GitLabProvider()).history(ref)).rejects.toThrow('on another host');
  });

  it('gives up on a create GitLab does not answer in time', async () => {
    hanging();
    await expect(new GitLabProvider().createPullRequest({ repo: 'acme/app', source: ref.source, target: 'main', title: 't', spawnTimeoutMs: 20 })).rejects.toThrow();
  });
});

describe('GitLab commit pipelines', () => {
  beforeEach(() => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    vi.stubEnv('GITLAB_URL', '');
    vi.stubEnv('TEAMAI_GITLAB_HOST', '');
  });

  it.each([
    ['failed', 'failed'], ['success', 'passed'], ['running', 'pending'], ['created', 'pending'], ['canceled', 'none'], ['skipped', 'none'],
  ])('reads the newest pipeline of the commit, %s, as %s', async (status, expected) => {
    const fetcher = answering([{ status }, { status: 'success' }]);

    expect(await lookupOf(new GitLabProvider()).checks?.(commit)).toBe(expected);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([url.pathname, url.searchParams.get('sha'), url.searchParams.get('order_by')]).toEqual(['/api/v4/projects/acme%2Fapp/pipelines', SHA, 'id']);
  });

  it('reads a commit no pipeline ran for as none, and fails on an answer it cannot read', async () => {
    answering([]);
    expect(await lookupOf(new GitLabProvider()).checks?.(commit)).toBe('none');
    answering({ message: 'private-token-in-body' }, 403);
    await expect(lookupOf(new GitLabProvider()).checks?.(commit)).rejects.toThrow(/^GitLab answered the commit pipelines lookup with HTTP 403\.(?!.*private-token-in-body)/);
  });
});

describe('TGit merge request lookup', () => {
  const tgitMr = (source: string, iid = 7, sourceProject = 1, state = 'opened', url = `https://git.woa.com/acme/app/merge_requests/${iid}`) => ({
    ...mr(source, iid, sourceProject, url), state,
  });
  beforeEach(() => vi.stubEnv('TGIT_TOKEN', 'test-token'));

  it('finds the open or reopened request of this project branch into the target, never one from a fork with the same branch name', async () => {
    const fetcher = answering([tgitMr(ref.source, 6, 2), tgitMr('other', 8), tgitMr(ref.source, 9, 1, 'reopened')]);

    expect(await lookupOf(new TGitProvider()).findOpen(ref)).toBe('https://git.woa.com/acme/app/merge_requests/9');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([`${url.origin}${url.pathname}`, url.searchParams.get('state'), url.searchParams.get('source_branch'), url.searchParams.get('target_branch')])
      .toEqual(['https://git.woa.com/api/v3/projects/acme%2Fapp/merge_requests', 'opened', ref.source, 'main']);
    answering([tgitMr(ref.source, 6, 2), tgitMr(ref.source, 5, 1, 'merged')]);
    expect(await lookupOf(new TGitProvider()).findOpen(ref)).toBeUndefined();
  });

  it('fails, rather than finding nothing, on an answer it cannot read or see past, on another host, or with no answer in time', async () => {
    const tgitLookup = lookupOf(new TGitProvider());
    answering({ message: 'private-token-in-body' }, 404);
    await expect(tgitLookup.findOpen(ref)).rejects.toThrow(/^TGit answered the open merge request lookup with HTTP 404\.(?!.*private-token-in-body)/);
    answering([{ web_url: 'https://git.woa.com/acme/app/merge_requests/7', state: 'opened' }]);
    await expect(tgitLookup.findOpen(ref)).rejects.toThrow(/^TGit answered the open merge request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => tgitMr(`other-${index}`, index)));
    await expect(tgitLookup.findOpen(ref)).rejects.toThrow('more open merge requests than one page');
    answering([tgitMr(ref.source, 7, 1, 'opened', 'https://evil.example/acme/app/merge_requests/7')]);
    await expect(tgitLookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(tgitLookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
  });

  it('lists every request of this project branch into the target with how it ended, a reopened one as open', async () => {
    const at = (iid: number, state: string, updated: string) => ({ ...tgitMr(ref.source, iid, 1, state), title: `Change ${iid}`, created_at: `2026-10-0${iid}T10:00:00Z`, updated_at: updated });
    const fetcher = answering([at(9, 'reopened', '2026-10-09T11:00:00Z'), at(8, 'closed', '2026-10-08T12:00:00Z'), at(5, 'merged', '2026-10-05T12:00:00Z')]);

    expect(await lookupOf(new TGitProvider()).history(ref)).toEqual([
      { url: 'https://git.woa.com/acme/app/merge_requests/9', title: 'Change 9', openedAt: '2026-10-09T10:00:00Z', state: 'open' },
      { url: 'https://git.woa.com/acme/app/merge_requests/8', title: 'Change 8', openedAt: '2026-10-08T10:00:00Z', state: 'closed', closedAt: '2026-10-08T12:00:00Z' },
      { url: 'https://git.woa.com/acme/app/merge_requests/5', title: 'Change 5', openedAt: '2026-10-05T10:00:00Z', state: 'merged', closedAt: '2026-10-05T12:00:00Z' },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('state')).toBe('all');
  });
});

describe('GitCode pull request lookup', () => {
  const gitcodePull = (head: string, repo = 'acme/app', number = 7, state = 'open', url = `https://gitcode.com/acme/app/pull/${number}`) => ({
    ...pull(head, repo, number), html_url: url, state,
  });
  beforeEach(() => vi.stubEnv('GITCODE_TOKEN', 'test-token'));

  it('finds the open request of this repository branch into the target, never a fork with the same branch name', async () => {
    const fetcher = answering([gitcodePull(ref.source, 'fork/app', 6), gitcodePull('other', 'acme/app', 8), gitcodePull(ref.source)]);

    expect(await lookupOf(new GitCodeProvider()).findOpen(ref)).toBe('https://gitcode.com/acme/app/pull/7');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect([`${url.origin}${url.pathname}`, url.searchParams.get('state'), url.searchParams.get('head'), url.searchParams.get('base')])
      .toEqual(['https://api.gitcode.com/api/v5/repos/acme/app/pulls', 'open', ref.source, 'main']);
    answering([gitcodePull(ref.source, 'fork/app', 6), gitcodePull(ref.source, 'acme/app', 5, 'merged')]);
    expect(await lookupOf(new GitCodeProvider()).findOpen(ref)).toBeUndefined();
  });

  it('fails, rather than finding nothing, on an answer it cannot read or see past, on another host, or with no answer in time', async () => {
    const gitcodeLookup = lookupOf(new GitCodeProvider());
    answering({ message: 'private-token-in-body' }, 401);
    await expect(gitcodeLookup.findOpen(ref)).rejects.toThrow(/^GitCode answered the open pull request lookup with HTTP 401\.(?!.*private-token-in-body)/);
    answering([gitcodePull(ref.source, 'acme/app', 7, 'opened')]);
    await expect(gitcodeLookup.findOpen(ref)).rejects.toThrow(/^GitCode answered the open pull request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => gitcodePull(`other-${index}`, 'acme/app', index)));
    await expect(gitcodeLookup.findOpen(ref)).rejects.toThrow('more open pull requests than one page');
    answering([gitcodePull(ref.source, 'acme/app', 7, 'open', 'https://evil.example/acme/app/pull/7')]);
    await expect(gitcodeLookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(gitcodeLookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
  });

  it('lists every request of this repository branch into the target with how it ended, never a fork', async () => {
    const at = (number: number, state: string, ended: Record<string, string | null>, repo = 'acme/app') => ({ ...gitcodePull(ref.source, repo, number, state), title: `Change ${number}`, created_at: `2026-10-0${number}T10:00:00Z`, ...ended });
    const fetcher = answering([
      at(9, 'open', { closed_at: null, merged_at: null }), at(8, 'closed', { closed_at: '2026-10-08T12:00:00Z', merged_at: null }),
      at(6, 'closed', { closed_at: '2026-10-06T12:00:00Z', merged_at: null }, 'fork/app'), at(5, 'merged', { closed_at: '2026-10-05T12:00:00Z', merged_at: '2026-10-05T12:00:00Z' }),
    ]);

    expect(await lookupOf(new GitCodeProvider()).history(ref)).toEqual([
      { url: 'https://gitcode.com/acme/app/pull/9', title: 'Change 9', openedAt: '2026-10-09T10:00:00Z', state: 'open' },
      { url: 'https://gitcode.com/acme/app/pull/8', title: 'Change 8', openedAt: '2026-10-08T10:00:00Z', state: 'closed', closedAt: '2026-10-08T12:00:00Z' },
      { url: 'https://gitcode.com/acme/app/pull/5', title: 'Change 5', openedAt: '2026-10-05T10:00:00Z', state: 'merged', closedAt: '2026-10-05T12:00:00Z' },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('state')).toBe('all');
  });
});

describe('the provider of a checkout origin', () => {
  it.each([
    ['https://user:secret@github.com/acme/app.git', 'github', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'github', 'acme/app'],
    ['git@github.com:acme/app.git', 'github', 'acme/app'],
    ['git@gitlab.com:acme/platform/app.git', 'gitlab', 'acme/platform/app'],
    ['https://git.woa.com/acme/app.git', 'tgit', 'acme/app'],
    ['https://gitcode.com/acme/app.git', 'gitcode', 'acme/app'],
  ])('reads the provider and the repository from %s', (remote, provider, repo) => {
    vi.stubEnv('GITLAB_URL', ''); vi.stubEnv('TEAMAI_GITLAB_HOST', '');
    const origin = providerForRemote(remote);
    expect(origin.kind === 'provider' && [origin.provider.name, origin.repo]).toEqual([provider, repo]);
  });

  it.each([
    ['https://github.com/acme/app.git', '', 'github.com'],
    ['ssh://git@github.com:22/acme/app.git', '', 'github.com'],
    ['git@gl.example.com:acme/app.git', 'https://gl.example.com:8443', 'gl.example.com'],
  ])('reads the host the pull requests of %s are on', (remote, gitlabUrl, host) => {
    vi.stubEnv('GITLAB_URL', gitlabUrl); vi.stubEnv('TEAMAI_GITLAB_HOST', '');
    const origin = providerForRemote(remote);
    expect(origin.kind === 'provider' && origin.hostname).toBe(host);
  });

  it.each(['/srv/git/app.git', 'file:///srv/git/app.git', 'https://git.example.internal/acme/app.git', 'https://github.com/acme', 'https://cnb.cool/acme/app.git'])(
    'reaches %s through git alone, which opens no pull request',
    (remote) => expect(providerForRemote(remote)).toEqual({ kind: 'transport' }),
  );

  it('a generic git host has no pull request lookup', () => {
    expect(new GenericGitProvider().pullRequests).toBeNull();
  });
});

it('request lookup only reads: open requests, how a branch\'s requests ended, and the checks of a commit', () => {
  expectTypeOf<keyof PullRequestLookup>().toEqualTypeOf<'findOpen' | 'history' | 'checks'>();
});
