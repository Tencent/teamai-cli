import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../providers/github/index.js';
import { GenericGitProvider } from '../providers/git/index.js';
import { providerForRemote } from '../providers/registry.js';
import type { PullRequestLookup, PullRequestRef } from '../providers/types.js';
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

describe('the provider of a checkout origin', () => {
  it.each([
    ['https://user:secret@github.com/acme/app.git', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'acme/app'],
    ['git@github.com:acme/app.git', 'acme/app'],
  ])('reads GitHub and the repository from %s', (remote, repo) => {
    const origin = providerForRemote(remote);
    expect(origin.kind === 'provider' && [origin.provider.name, origin.repo]).toEqual(['github', repo]);
  });

  it.each(['/srv/git/app.git', 'file:///srv/git/app.git', 'https://git.example.internal/acme/app.git', 'https://github.com/acme'])(
    'reaches %s through git alone, which opens no pull request',
    (remote) => expect(providerForRemote(remote)).toEqual({ kind: 'transport' }),
  );

  it('a generic git host has no pull request lookup', () => {
    expect(new GenericGitProvider().pullRequests).toBeNull();
  });
});
