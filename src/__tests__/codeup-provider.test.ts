import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseCodeupRepoInput } from '../providers/codeup/repo-url.js';
import { CodeupProvider } from '../providers/codeup/index.js';
import {
  getCodeupToken,
  codeupWhoami,
  codeupMrCreate,
  codeupFindOpenMr,
} from '../providers/codeup/codeup-api.js';
import { detectProvider, getProvider } from '../providers/registry.js';

describe('Codeup repo-url parsing', () => {
  it('parses short org/repo format', () => {
    const info = parseCodeupRepoInput('org/repo');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('repo');
    expect(info.httpsUrl).toBe('https://codeup.aliyun.com/org/repo.git');
    expect(info.projectId).toBe('org/repo');
  });

  it('parses nested org/group/repo format keeping the full path', () => {
    const info = parseCodeupRepoInput('org/group/repo');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
    expect(info.httpsUrl).toBe('https://codeup.aliyun.com/org/group/repo.git');
    expect(`${info.owner}/${info.repo}`).toBe('org/group/repo');
  });

  it('parses HTTPS URL and strips .git', () => {
    const info = parseCodeupRepoInput('https://codeup.aliyun.com/org/group/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
  });

  it('parses SSH URL with nested groups', () => {
    const info = parseCodeupRepoInput('git@codeup.aliyun.com:org/group/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
    expect(info.httpsUrl).toBe('https://codeup.aliyun.com/org/group/repo.git');
  });

  it('parses ssh:// URL without a port', () => {
    const info = parseCodeupRepoInput('ssh://git@codeup.aliyun.com/org/group/repo.git');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
  });

  it('ignores trailing web-route segments (/changeRequest/list)', () => {
    const info = parseCodeupRepoInput('https://codeup.aliyun.com/org/group/repo/changeRequest/list');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
  });

  it('ignores file-browser web-route segments (/tree/main)', () => {
    const info = parseCodeupRepoInput('https://codeup.aliyun.com/org/group/repo/tree/main');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
  });

  it('strips .git before a web-route suffix', () => {
    const info = parseCodeupRepoInput('https://codeup.aliyun.com/org/group/repo.git/tree/main');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/repo');
  });

  it('keeps a group named like a web-route segment in first position after the owner', () => {
    const info = parseCodeupRepoInput('org/tree/repo');
    expect(info.repo).toBe('tree/repo');
  });

  it('throws on a single-segment input', () => {
    expect(() => parseCodeupRepoInput('justorg')).toThrow(/Unrecognized Codeup/);
  });
});

describe('CodeupProvider', () => {
  it('has name codeup', () => {
    expect(new CodeupProvider().name).toBe('codeup');
  });

  it('getDefaultEmailDomain returns null', () => {
    expect(new CodeupProvider().getDefaultEmailDomain()).toBeNull();
  });

  it('is registered under the codeup.aliyun.com host', () => {
    expect(detectProvider('git@codeup.aliyun.com:org/group/repo.git')).toBe('codeup');
    expect(detectProvider('https://codeup.aliyun.com/org/group/repo.git')).toBe('codeup');
    expect(getProvider('codeup').name).toBe('codeup');
  });
});

describe('Codeup token resolution', () => {
  const OLD_ENV = process.env;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.CODEUP_TOKEN;
    delete process.env.YUNXIAO_TOKEN;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeup-netrc-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    // getUserHome() reads HOME/USERPROFILE before os.homedir(), so the spy
    // alone would still resolve to the machine's real profile.
    process.env.HOME = tmpHome;
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    homedirSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prefers CODEUP_TOKEN env over everything', () => {
    process.env.CODEUP_TOKEN = 'env-primary';
    expect(getCodeupToken()).toBe('env-primary');
  });

  it('accepts YUNXIAO_TOKEN as an alias when CODEUP_TOKEN is absent', () => {
    process.env.YUNXIAO_TOKEN = 'yunxiao-alias';
    expect(getCodeupToken()).toBe('yunxiao-alias');
  });

  it('falls back to ~/.netrc when no env token is set', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.netrc'),
      'machine codeup.aliyun.com login zhangsan password netrc-token\n',
    );
    expect(getCodeupToken()).toBe('netrc-token');
  });

  it('returns null when neither env nor netrc has a token', () => {
    expect(getCodeupToken()).toBeNull();
  });
});

describe('Codeup REST calls', () => {
  const OLD_ENV = process.env;

  /** Route mocked fetch responses by URL. */
  function mockFetch(routes: Array<{ match: (url: string, method: string) => boolean; status: number; body: unknown }>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      for (const route of routes) {
        if (route.match(url, method)) {
          return new Response(JSON.stringify(route.body), { status: route.status });
        }
      }

      return new Response(JSON.stringify({ error: `no mock for ${method} ${url}` }), { status: 500 });
    });
  }

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.CODEUP_TOKEN = 'test-token';
    process.env.CODEUP_ORG_ID = '64700f00f1234';
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('whoami reads the platform user endpoint with the yunxiao token header', async () => {
    const fetchMock = mockFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/oapi/v1/platform/user'),
        status: 200,
        body: { username: 'zhangsan', lastOrganization: '64700f00f1234' },
      },
    ]);

    const { username, lastOrganization } = await codeupWhoami();
    expect(username).toBe('zhangsan');
    expect(lastOrganization).toBe('64700f00f1234');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://openapi-rdc.aliyuncs.com/oapi/v1/platform/user');
    expect((init?.headers as Record<string, string> | undefined)?.['x-yunxiao-token']).toBe('test-token');
  });

  it('mrCreate resolves the numeric repo id then posts a changeRequest and returns detailUrl', async () => {
    const fetchMock = mockFetch([
      {
        match: (url, method) => method === 'GET' && /\/oapi\/v1\/codeup\/organizations\/[^/]+\/repositories\/org%2Fgroup%2Frepo-a$/.test(url),
        status: 200,
        body: { id: 2813489 },
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/repositories/2813489/changeRequests'),
        status: 200,
        body: { localId: 12, detailUrl: 'https://codeup.aliyun.com/org/group/repo-a/changeRequest/12' },
      },
    ]);

    const url = await codeupMrCreate({
      repo: 'org/group/repo-a',
      source: 'teamai/push/zhangsan/20260101-000000',
      target: 'master',
      title: 'My MR',
      description: 'body text',
    });
    expect(url).toBe('https://codeup.aliyun.com/org/group/repo-a/changeRequest/12');

    const createCall = fetchMock.mock.calls.find(([, init]) => (init as any)?.method === 'POST')!;
    const body = JSON.parse((createCall[1] as any).body);

    expect(body).toMatchObject({
      title: 'My MR',
      sourceBranch: 'teamai/push/zhangsan/20260101-000000',
      targetBranch: 'master',
      sourceProjectId: '2813489',
      targetProjectId: '2813489',
      createFrom: 'WEB',
      description: 'body text',
    });
  });

  it('mrCreate falls back to a changeRequest URL from localId when detailUrl is absent', async () => {
    mockFetch([
      {
        match: (url, method) => method === 'GET' && /\/repositories\/org%2Frepo-b$/.test(url),
        status: 200,
        body: { id: 99 },
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/repositories/99/changeRequests'),
        status: 200,
        body: { localId: 42 },
      },
    ]);

    const url = await codeupMrCreate({
      repo: 'org/repo-b',
      source: 'f',
      target: 'master',
      title: 't',
    });
    expect(url).toBe('https://codeup.aliyun.com/org/repo-b/change/42');
  });

  it('mrCreate throws on a non-ok create response', async () => {
    mockFetch([
      {
        match: (url, method) => method === 'GET' && /\/repositories\/org%2Frepo-c$/.test(url),
        status: 200,
        body: { id: 7 },
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/changeRequests'),
        status: 400,
        body: { errorMessage: 'source branch equals target branch' },
      },
    ]);

    await expect(
      codeupMrCreate({ repo: 'org/repo-c', source: 'f', target: 'master', title: 't' }),
    ).rejects.toThrow(/Failed to create Codeup MR: 400/);
  });

  it('findOpenMr lists opened change requests and matches on branch names (live field names)', async () => {
    const fetchMock = mockFetch([
      {
        match: (url, method) => method === 'GET' && /\/repositories\/org%2Frepo-d$/.test(url),
        status: 200,
        body: { id: 55 },
      },
      {
        match: (url, method) => method === 'GET' && /\/changeRequests\?/.test(url),
        status: 200,
        body: [
          {
            localId: 1,
            title: 'other MR',
            // `status` is the tolerated alias form
            status: 'UNDER_REVIEW',
            sourceBranch: 'other-branch',
            targetBranch: 'master',
            createTime: '2026-01-01T00:00:00Z',
          },
          {
            localId: 2,
            title: 'ours',
            // `state` is what the live API sends
            state: 'TO_BE_MERGED',
            sourceBranch: 'teamai/push/x/20260101-000000',
            targetBranch: 'master',
            createdAt: '2026-01-02T00:00:00Z',
            detailUrl: 'https://codeup.aliyun.com/org/repo-d/change/2',
          },
        ],
      },
    ]);

    const url = await codeupFindOpenMr({
      repo: 'org/repo-d',
      source: 'teamai/push/x/20260101-000000',
      target: 'master',
      timeoutMs: 5_000,
    });
    expect(url).toBe('https://codeup.aliyun.com/org/repo-d/change/2');

    const listCall = fetchMock.mock.calls.find(([u]) => /\/changeRequests\?/.test(String(u)))!;
    expect(String(listCall[0])).toContain('projectIds=55');
    expect(String(listCall[0])).toContain('state=opened');
  });

  it('findOpenMr answers undefined when no open MR matches', async () => {
    mockFetch([
      {
        match: (url, method) => method === 'GET' && /\/repositories\/org%2Frepo-e$/.test(url),
        status: 200,
        body: { id: 66 },
      },
      {
        match: (url, method) => method === 'GET' && /\/changeRequests\?/.test(url),
        status: 200,
        body: [],
      },
    ]);

    const url = await codeupFindOpenMr({
      repo: 'org/repo-e',
      source: 'f',
      target: 'master',
      timeoutMs: 5_000,
    });
    expect(url).toBeUndefined();
  });
});
