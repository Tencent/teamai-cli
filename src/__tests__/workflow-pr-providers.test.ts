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
import type { GitProvider, PullRequestLookup, PullRequestRef } from '../providers/types.js';
import { fakeGh, resolveGh } from './helpers/fake-gh.js';

const ref: PullRequestRef = { repo: 'acme/app', source: 'teamai/run/work/p1', target: 'main', timeoutMs: 1000 };
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
    const answer = lookup().findOpen({ ...ref, timeoutMs: 300 }).then(() => 'found', () => 'failed');
    try {
      await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
      const result = await Promise.race([
        answer,
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve('still waiting for the pipe'), 1000); }),
      ]);
      expect(result).toBe('failed');
    } finally {
      clearTimeout(deadline);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      process.kill(pid, 'SIGKILL');
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
    const lookup = lookupOf(new GitLabProvider());
    vi.stubEnv('GITLAB_TOKEN', ''); vi.stubEnv('GITLAB_PRIVATE_TOKEN', ''); vi.stubEnv('GITLAB_PAT', '');
    await expect(lookup.findOpen(ref)).rejects.toThrow('GitLab authentication unavailable');
    vi.stubEnv('GITLAB_TOKEN', 'test-token');
    answering({ message: 'private-token-in-body' }, 403);
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^GitLab answered the open merge request lookup with HTTP 403\.(?!.*private-token-in-body)/);
    answering({ message: 'private-token-in-body' });
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^GitLab answered the open merge request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => mr(`other-${index}`, index)));
    await expect(lookup.findOpen(ref)).rejects.toThrow('more open merge requests than one page');
    answering([mr(ref.source, 7, 1, 'https://evil.example/acme/app/-/merge_requests/7')]);
    await expect(lookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(lookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
  });

  it('gives up on a create GitLab does not answer in time', async () => {
    hanging();
    await expect(new GitLabProvider().createPullRequest({ repo: 'acme/app', source: ref.source, target: 'main', title: 't', spawnTimeoutMs: 20 })).rejects.toThrow();
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
    const lookup = lookupOf(new TGitProvider());
    answering({ message: 'private-token-in-body' }, 404);
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^TGit answered the open merge request lookup with HTTP 404\.(?!.*private-token-in-body)/);
    answering([{ web_url: 'https://git.woa.com/acme/app/merge_requests/7', state: 'opened' }]);
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^TGit answered the open merge request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => tgitMr(`other-${index}`, index)));
    await expect(lookup.findOpen(ref)).rejects.toThrow('more open merge requests than one page');
    answering([tgitMr(ref.source, 7, 1, 'opened', 'https://evil.example/acme/app/merge_requests/7')]);
    await expect(lookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(lookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
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
    const lookup = lookupOf(new GitCodeProvider());
    answering({ message: 'private-token-in-body' }, 401);
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^GitCode answered the open pull request lookup with HTTP 401\.(?!.*private-token-in-body)/);
    answering([gitcodePull(ref.source, 'acme/app', 7, 'opened')]);
    await expect(lookup.findOpen(ref)).rejects.toThrow(/^GitCode answered the open pull request lookup with data TeamAI cannot read\.$/);
    answering(Array.from({ length: 100 }, (_, index) => gitcodePull(`other-${index}`, 'acme/app', index)));
    await expect(lookup.findOpen(ref)).rejects.toThrow('more open pull requests than one page');
    answering([gitcodePull(ref.source, 'acme/app', 7, 'open', 'https://evil.example/acme/app/pull/7')]);
    await expect(lookup.findOpen(ref)).rejects.toThrow('on another host');
    hanging();
    await expect(lookup.findOpen({ ...ref, timeoutMs: 20 })).rejects.toThrow();
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
