import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseGitCodeRepoInput } from '../providers/gitcode/repo-url.js';
import { GitCodeProvider } from '../providers/gitcode/index.js';
import {
  getGitCodeToken,
  gitcodePullCreate,
  gitcodeWhoami,
} from '../providers/gitcode/gitcode-api.js';

describe('GitCode repo-url parsing', () => {
  it('parses short owner/repo format', () => {
    const info = parseGitCodeRepoInput('owner/repo');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
    expect(info.httpsUrl).toBe('https://gitcode.com/owner/repo.git');
    expect(info.projectId).toBe('owner/repo');
  });

  it('parses HTTPS URL and strips .git', () => {
    const info = parseGitCodeRepoInput('https://gitcode.com/owner/repo.git');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
  });

  it('parses SSH URL', () => {
    const info = parseGitCodeRepoInput('git@gitcode.com:owner/repo.git');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
  });

  it('parses ssh:// URL with a non-default port', () => {
    const info = parseGitCodeRepoInput('ssh://git@gitcode.com:2222/owner/repo.git');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
    expect(info.httpsUrl).toBe('https://gitcode.com/owner/repo.git');
  });

  it('parses ssh:// URL without a port', () => {
    const info = parseGitCodeRepoInput('ssh://git@gitcode.com/owner/repo.git');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
  });

  it('ignores trailing web-route segments (Gitee-style /pulls/1)', () => {
    const info = parseGitCodeRepoInput('https://gitcode.com/owner/repo/pulls/1');
    expect(info.owner).toBe('owner');
    expect(info.repo).toBe('repo');
  });

  it('throws on a single-segment input', () => {
    expect(() => parseGitCodeRepoInput('justowner')).toThrow(/Unrecognized GitCode/);
  });
});

describe('GitCodeProvider', () => {
  it('has name gitcode', () => {
    expect(new GitCodeProvider().name).toBe('gitcode');
  });

  it('getDefaultEmailDomain returns null', () => {
    expect(new GitCodeProvider().getDefaultEmailDomain()).toBeNull();
  });
});

describe('GitCode token resolution', () => {
  const OLD_ENV = process.env;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.GITCODE_TOKEN;
    delete process.env.GC_TOKEN;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcode-netrc-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    process.env = OLD_ENV;
    homedirSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prefers GITCODE_TOKEN env over everything', () => {
    process.env.GITCODE_TOKEN = 'env-primary';
    expect(getGitCodeToken()).toBe('env-primary');
  });

  it('accepts GC_TOKEN as an alias when GITCODE_TOKEN is absent', () => {
    process.env.GC_TOKEN = 'gc-alias';
    expect(getGitCodeToken()).toBe('gc-alias');
  });

  it('falls back to ~/.netrc when no env token is set', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.netrc'),
      'machine gitcode.com login oauth2 password netrc-token\n',
    );
    expect(getGitCodeToken()).toBe('netrc-token');
  });

  it('returns null when neither env nor netrc has a token', () => {
    expect(getGitCodeToken()).toBeNull();
  });
});

describe('GitCode REST calls', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.GITCODE_TOKEN = 'test-token';
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('whoami reads the Gitee-style `login` field', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }),
    );
    expect(await gitcodeWhoami()).toBe('octocat');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.gitcode.com/api/v5/user');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('pullCreate posts head/base/title/body and returns html_url', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ html_url: 'https://gitcode.com/o/r/pull/7', number: 7 }), {
        status: 201,
      }),
    );
    const url = await gitcodePullCreate({
      repo: 'o/r',
      source: 'feature',
      target: 'main',
      title: 'My PR',
      description: 'body text',
    });
    expect(url).toBe('https://gitcode.com/o/r/pull/7');

    const [reqUrl, init] = fetchMock.mock.calls[0];
    expect(String(reqUrl)).toBe('https://api.gitcode.com/api/v5/repos/o/r/pulls');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ head: 'feature', base: 'main', title: 'My PR', body: 'body text' });
  });

  it('pullCreate falls back to a /pull/ URL when html_url is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ number: 42 }), { status: 201 }),
    );
    const url = await gitcodePullCreate({
      repo: 'o/r',
      source: 'f',
      target: 'main',
      title: 't',
    });
    expect(url).toBe('https://gitcode.com/o/r/pull/42');
  });

  it('pullCreate throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad request', { status: 422 }),
    );
    await expect(
      gitcodePullCreate({ repo: 'o/r', source: 'f', target: 'main', title: 't' }),
    ).rejects.toThrow(/Failed to create GitCode PR: 422/);
  });
});
