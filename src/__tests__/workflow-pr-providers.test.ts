import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../providers/github/index.js';
import { GitLabProvider } from '../providers/gitlab/index.js';
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

describe('the provider of a checkout origin', () => {
  it.each([
    ['https://user:secret@github.com/acme/app.git', 'github', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'github', 'acme/app'],
    ['git@github.com:acme/app.git', 'github', 'acme/app'],
    ['git@gitlab.com:acme/platform/app.git', 'gitlab', 'acme/platform/app'],
  ])('reads the provider and the repository from %s', (remote, provider, repo) => {
    vi.stubEnv('GITLAB_URL', ''); vi.stubEnv('TEAMAI_GITLAB_HOST', '');
    const origin = providerForRemote(remote);
    expect(origin.kind === 'provider' && [origin.provider.name, origin.repo]).toEqual([provider, repo]);
  });

  it.each(['/srv/git/app.git', 'file:///srv/git/app.git', 'https://git.example.internal/acme/app.git', 'https://github.com/acme'])(
    'reaches %s through git alone, which opens no pull request',
    (remote) => expect(providerForRemote(remote)).toEqual({ kind: 'transport' }),
  );

  it('a generic git host has no pull request lookup', () => {
    expect(new GenericGitProvider().pullRequests).toBeNull();
  });
});
