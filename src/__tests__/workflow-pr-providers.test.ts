import { afterEach, describe, expect, it, vi } from 'vitest';
import * as github from '../providers/github/gh-cli.js';
import * as gitcode from '../providers/gitcode/gitcode-api.js';
import * as tgit from '../providers/tgit/rest-auth.js';
import * as cnb from '../providers/cnb/cnb-cli.js';
import { GitHubProvider } from '../providers/github/index.js';
import { GitLabProvider } from '../providers/gitlab/index.js';
import { GitCodeProvider } from '../providers/gitcode/index.js';
import { TGitProvider } from '../providers/tgit/index.js';
import { CNBProvider } from '../providers/cnb/index.js';
import type { PrCreateOptions } from '../providers/types.js';

const opts: PrCreateOptions = { repo: 'acme/app', source: 'teamai/run/work/p1', target: 'main', title: 'Change', spawnTimeoutMs: 1000 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('workflow provider PR reuse and validation', () => {
  it('reuses the exact GitHub repository/head/base and never accepts a fork with the same branch name', async () => {
    vi.spyOn(github, 'isGhInstalled').mockReturnValue(false);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const pull = { state: 'open', html_url: 'https://github.com/acme/app/pull/7', head: { ref: opts.source, repo: { full_name: opts.repo } }, base: { ref: 'main', repo: { full_name: opts.repo } } };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ...pull, head: { ref: opts.source, repo: { full_name: 'fork/app' } }, html_url: 'https://github.com/acme/app/pull/6' }, pull])));
    vi.stubGlobal('fetch', fetcher);
    const provider = new GitHubProvider();
    expect(await provider.findOpenPullRequest(opts)).toBe(pull.html_url);
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(url.searchParams.get('head')).toBe(`acme:${opts.source}`);
    expect(url.searchParams.get('base')).toBe('main');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(pull)));
    expect(await provider.validatePullRequest(pull.html_url, opts)).toBe(true);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...pull, base: { ...pull.base, ref: 'other' } })));
    expect(await provider.validatePullRequest(pull.html_url, opts)).toBe(false);
    expect(await provider.validatePullRequest('https://github.com/other/app/pull/7', opts)).toBe(false);
    const calls = fetcher.mock.calls.length;
    expect(await provider.validatePullRequest('https://private-review.example/1', opts)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('uses an already authenticated gh without invoking login', async () => {
    vi.spyOn(github, 'isGhInstalled').mockReturnValue(true);
    const cli = vi.spyOn(github, 'ghExec').mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify([{ state: 'open', html_url: 'https://github.com/acme/app/pull/8', head: { ref: opts.source, repo: { full_name: opts.repo } }, base: { ref: opts.target, repo: { full_name: opts.repo } } }]) });
    expect(await new GitHubProvider().findOpenPullRequest(opts)).toBe('https://github.com/acme/app/pull/8');
    expect(cli.mock.calls[0]?.[0][0]).toBe('api');
    expect(cli.mock.calls.flatMap(([args]) => args)).not.toContain('login');
  });

  it('fails noninteractively without GitHub credentials, without echoing response bodies', async () => {
    vi.spyOn(github, 'isGhInstalled').mockReturnValue(false);
    vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', '');
    await expect(new GitHubProvider().findOpenPullRequest(opts)).rejects.toThrow('GitHub authentication unavailable');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-token-in-body', { status: 403 })));
    await expect(new GitHubProvider().findOpenPullRequest(opts)).rejects.toThrow('GitHub PR lookup failed (403). Check token and repository access.');
  });

  it('validates GitLab project and branches at the configured instance, including a subpath', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-token'); vi.stubEnv('GITLAB_URL', 'https://gitlab.example/team');
    const mr = { state: 'opened', source_branch: opts.source, target_branch: opts.target, source_project_id: 5, target_project_id: 5, web_url: 'https://gitlab.example/team/acme/app/-/merge_requests/9' };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([mr])));
    vi.stubGlobal('fetch', fetcher);
    const provider = new GitLabProvider();
    expect(await provider.findOpenPullRequest(opts)).toBe(mr.web_url);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/team/api/v4/projects/acme%2Fapp/merge_requests?');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(mr)));
    expect(await provider.validatePullRequest(mr.web_url, opts)).toBe(true);
    expect(await provider.validatePullRequest('https://gitlab.example/team/other/app/-/merge_requests/9', opts)).toBe(false);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...mr, source_project_id: 99 })));
    expect(await provider.validatePullRequest(mr.web_url, opts)).toBe(false);
  });

  it('reuses TGit requests through its existing REST authentication', async () => {
    const mr = { state: 'opened', source_branch: opts.source, target_branch: opts.target, source_project_id: 4, target_project_id: 4, web_url: 'https://git.woa.com/acme/app/merge_requests/3' };
    const fetcher = vi.spyOn(tgit, 'tgitFetch').mockResolvedValue(new Response(JSON.stringify([mr])));
    expect(await new TGitProvider().findOpenPullRequest(opts)).toBe(mr.web_url);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([mr])));
    expect(await new TGitProvider().validatePullRequest(mr.web_url, opts)).toBe(true);
  });

  it('paginates GitCode open requests before deciding to create a new one', async () => {
    vi.spyOn(gitcode, 'getGitCodeToken').mockReturnValue('test-token');
    const pull = { state: 'open', html_url: 'https://gitcode.com/acme/app/pull/2', head: { ref: opts.source, repo: { full_name: opts.repo } }, base: { ref: opts.target, repo: { full_name: opts.repo } } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ ...pull, head: { ...pull.head, ref: 'other' } })))))
      .mockResolvedValueOnce(new Response(JSON.stringify([pull])));
    vi.stubGlobal('fetch', fetcher);
    expect(await new GitCodeProvider().findOpenPullRequest(opts)).toBe(pull.html_url);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('page=2');
  });

  it('uses the CNB CLI schema and normalizes refs/heads branch names', async () => {
    const pull = { state: 'open', number: '12', head: { ref: `refs/heads/${opts.source}`, repo: { path: opts.repo } }, base: { ref: 'refs/heads/main', repo: { path: opts.repo } } };
    const cli = vi.spyOn(cnb, 'cnbExec').mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify([pull]) });
    const provider = new CNBProvider();
    expect(await provider.findOpenPullRequest(opts)).toBe('https://cnb.cool/acme/app/-/pulls/12');
    expect(cli.mock.calls[0]?.[0]).toContain('list-pulls');
    cli.mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify(pull) });
    expect(await provider.validatePullRequest('https://cnb.cool/acme/app/-/pulls/12', opts)).toBe(true);
  });
});
