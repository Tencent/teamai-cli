import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseCodeupRepoInput, codeupInputTransport } from '../providers/codeup/repo-url.js';
import { CodeupProvider } from '../providers/codeup/index.js';
import {
  getCodeupToken,
  codeupWhoami,
  codeupMrCreate,
  codeupFindOpenMr,
  codeupMrHistory,
  codeupCloneUrl,
  readNetrcUsername,
  writeNetrcToken,
} from '../providers/codeup/codeup-api.js';
import { detectProvider, getProvider } from '../providers/registry.js';

// Mirrors init.test.ts's prompt mock: interactive only when a test forces a
// TTY; askQuestion consumes queued answers.
let questionAnswers: string[] = [];

vi.mock('../utils/prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/prompt.js')>()),
  isInteractive: () => Boolean(process.stdin.isTTY),
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    const answer = questionAnswers.shift();

    return Promise.resolve(answer ?? defaultValue ?? '');
  }),
}));

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

  it('keeps a nested group named like a web route in the bare form', () => {
    const info = parseCodeupRepoInput('org/team/files/repo');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('team/files/repo');
  });

  it('keeps route-like segments in an ssh clone URL', () => {
    expect(parseCodeupRepoInput('git@codeup.aliyun.com:org/group/tree/repo.git').repo).toBe('group/tree/repo');
  });

  it('keeps route-like segments in an https URL ending in .git', () => {
    expect(parseCodeupRepoInput('https://codeup.aliyun.com/org/group/tree/repo.git').repo).toBe('group/tree/repo');
  });

  it('keeps a repo named like a web route at the end of a browser URL', () => {
    const info = parseCodeupRepoInput('https://codeup.aliyun.com/org/group/wiki');
    expect(info.owner).toBe('org');
    expect(info.repo).toBe('group/wiki');
  });

  it('rejects a URL on another host', () => {
    expect(() => parseCodeupRepoInput('https://github.com/org/repo')).toThrow(/only codeup.aliyun.com/);
    expect(() => parseCodeupRepoInput('git@gitcode.com:org/repo.git')).toThrow(/only codeup.aliyun.com/);
  });

  it('reads the transport from the input form', () => {
    expect(codeupInputTransport('https://codeup.aliyun.com/org/repo.git')).toBe('https');
    expect(codeupInputTransport('git@codeup.aliyun.com:org/repo.git')).toBe('ssh');
    expect(codeupInputTransport('ssh://git@codeup.aliyun.com/org/repo.git')).toBe('ssh');
    expect(codeupInputTransport('org/repo')).toBeNull();
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

  it('reads a multiline netrc entry', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.netrc'),
      'machine codeup.aliyun.com\n  login zhangsan\n  password multi-line-token\n',
    );
    expect(getCodeupToken()).toBe('multi-line-token');
    expect(readNetrcUsername()).toBe('zhangsan');
  });

  it('writeNetrcToken replaces a multiline entry without orphaning its credential lines', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.netrc'),
      'machine other.host login a password b\nmachine codeup.aliyun.com\nlogin old-user\npassword old-token\n',
    );

    writeNetrcToken('new-token', 'zhangsan');
    const content = fs.readFileSync(path.join(tmpHome, '.netrc'), 'utf-8');

    expect(content).toContain('machine other.host login a password b');
    expect(content).not.toContain('old-token');
    expect(content).not.toContain('old-user');
    expect(content.endsWith('machine codeup.aliyun.com login zhangsan password new-token\n')).toBe(true);
  });
});

describe('Codeup clone transport', () => {
  const OLD_ENV = process.env;
  let tmpHome: string;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.CODEUP_TOKEN;
    delete process.env.YUNXIAO_TOKEN;
    delete process.env.CODEUP_TRANSPORT;
    delete process.env.CODEUP_USERNAME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeup-clone-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    process.env.HOME = tmpHome;
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('clones an https input as a plain https URL when no credentials are configured', () => {
    expect(codeupCloneUrl('org/group/repo', 'https')).toBe('https://codeup.aliyun.com/org/group/repo.git');
  });

  it('clones an ssh or bare input over ssh', () => {
    expect(codeupCloneUrl('org/group/repo', 'ssh')).toBe('git@codeup.aliyun.com:org/group/repo.git');
    expect(codeupCloneUrl('org/group/repo', null)).toBe('git@codeup.aliyun.com:org/group/repo.git');
  });

  it('embeds the PAT in an https clone once token and username are known', () => {
    process.env.CODEUP_TOKEN = 'pt-token';
    process.env.CODEUP_USERNAME = 'zhangsan';

    expect(codeupCloneUrl('org/repo', 'https')).toBe('https://zhangsan:pt-token@codeup.aliyun.com/org/repo.git');
  });

  it('reads the username from ~/.netrc when CODEUP_USERNAME is unset', () => {
    fs.writeFileSync(path.join(tmpHome, '.netrc'), 'machine codeup.aliyun.com login lisi password netrc-tok\n');

    expect(codeupCloneUrl('org/repo', 'https')).toBe('https://lisi:netrc-tok@codeup.aliyun.com/org/repo.git');
  });

  it('lets CODEUP_TRANSPORT override the input scheme', () => {
    process.env.CODEUP_TRANSPORT = 'https';
    expect(codeupCloneUrl('org/repo', null)).toBe('https://codeup.aliyun.com/org/repo.git');

    process.env.CODEUP_TRANSPORT = 'ssh';
    process.env.CODEUP_TOKEN = 'pt-token';
    process.env.CODEUP_USERNAME = 'zhangsan';
    expect(codeupCloneUrl('org/repo', 'https')).toBe('git@codeup.aliyun.com:org/repo.git');
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
  });  it('whoami reads the platform user endpoint with the yunxiao token header', async () => {
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
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-b'),
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
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-c'),
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
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-d'),
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
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-e'),
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

  it('findOpenMr throws on a body that is not a request list', async () => {
    mockFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-f'),
        status: 200,
        body: { id: 77 },
      },
      {
        match: (url, method) => method === 'GET' && /\/changeRequests\?/.test(url),
        status: 200,
        body: { errorCode: 'OK', result: 'not-a-list' },
      },
    ]);

    await expect(
      codeupFindOpenMr({ repo: 'org/repo-f', source: 'f', target: 'master', timeoutMs: 5_000 }),
    ).rejects.toThrow(/cannot read/);
  });

  it('findOpenMr reads the next page when the first page is full', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      localId: i,
      state: 'UNDER_REVIEW',
      sourceBranch: `other-${i}`,
      targetBranch: 'master',
    }));

    mockFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-g'),
        status: 200,
        body: { id: 88 },
      },
      {
        match: (url) => url.includes('page=2&'),
        status: 200,
        body: [
          {
            localId: 99,
            state: 'TO_BE_MERGED',
            sourceBranch: 'feat-x',
            targetBranch: 'master',
            detailUrl: 'https://codeup.aliyun.com/org/repo-g/change/99',
          },
        ],
      },
      {
        match: (url, method) => method === 'GET' && /\/changeRequests\?/.test(url),
        status: 200,
        body: fullPage,
      },
    ]);

    const url = await codeupFindOpenMr({ repo: 'org/repo-g', source: 'feat-x', target: 'master', timeoutMs: 5_000 });

    expect(url).toBe('https://codeup.aliyun.com/org/repo-g/change/99');
  });

  it('history combines the three states newest first', async () => {
    mockFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-h'),
        status: 200,
        body: { id: 111 },
      },
      {
        match: (url) => url.includes('state=opened'),
        status: 200,
        body: [],
      },
      {
        match: (url) => url.includes('state=merged'),
        status: 200,
        body: [
          {
            localId: 1,
            title: 'merged one',
            state: 'MERGED',
            sourceBranch: 'feat-x',
            targetBranch: 'master',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
            sourceCommitId: 'aaa',
            mergedRevision: 'bbb',
          },
        ],
      },
      {
        match: (url) => url.includes('state=closed'),
        status: 200,
        body: [
          {
            localId: 2,
            title: 'closed one',
            state: 'CLOSED',
            sourceBranch: 'feat-x',
            targetBranch: 'master',
            createdAt: '2026-02-01T00:00:00Z',
            updatedAt: '2026-02-02T00:00:00Z',
          },
        ],
      },
    ]);

    const records = await codeupMrHistory({ repo: 'org/repo-h', source: 'feat-x', target: 'master', timeoutMs: 5_000 });

    expect(records.map((r) => r.title)).toEqual(['closed one', 'merged one']);
    const mergedOne = records[1];

    expect(mergedOne.state === 'merged' && mergedOne.merge).toEqual({ head: 'aaa', commit: 'bbb' });
  });

  it('history throws when a state lists more requests than the page cap', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      localId: i,
      title: `mr ${i}`,
      state: 'MERGED',
      sourceBranch: `other-${i}`,
      targetBranch: 'master',
      createdAt: '2026-01-01T00:00:00Z',
    }));

    mockFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/repositories/org%2Frepo-i'),
        status: 200,
        body: { id: 222 },
      },
      {
        match: (url) => url.includes('state=opened'),
        status: 200,
        body: [],
      },
      {
        match: (url) => url.includes('state=merged'),
        status: 200,
        body: fullPage,
      },
      {
        match: (url) => url.includes('state=closed'),
        status: 200,
        body: [],
      },
    ]);

    await expect(
      codeupMrHistory({ repo: 'org/repo-i', source: 'feat-x', target: 'master', timeoutMs: 5_000 }),
    ).rejects.toThrow(/more merge requests than TeamAI reads/);
  });
});

describe('Codeup authenticate (codeup-scope PAT fallback)', () => {
  const OLD_ENV = process.env;
  let tmpHome: string;

  /**
   * A PAT with only codeup scope: /oapi/v1/platform/user answers 403, the org
   * repository list answers 200 — the exact live behavior verified against
   * openapi-rdc.aliyuncs.com.
   */
  function mockScopeLimitedFetch(repoListStatus = 200) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);

      if (url.endsWith('/oapi/v1/platform/user')) {
        return new Response(JSON.stringify({ errorCode: 'Forbidden', errorMessage: 'Current token has no permission to api.' }), { status: 403 });
      }

      if (/\/oapi\/v1\/codeup\/organizations\/[^/]+\/repositories/.test(url)) {
        return new Response(JSON.stringify([]), { status: repoListStatus });
      }

      return new Response(JSON.stringify({ error: `no mock for ${init?.method ?? 'GET'} ${url}` }), { status: 500 });
    });
  }

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.CODEUP_TOKEN = 'scope-limited-token';
    delete process.env.CODEUP_ORG_ID;
    delete process.env.CODEUP_USERNAME;
    delete process.env.YUNXIAO_EDITION;
    delete process.env.CODEUP_API_BASE_URL;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeup-auth-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    process.env.HOME = tmpHome;
    delete process.env.USERPROFILE;
    questionAnswers = [];
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns the platform whoami username when the token has platform scope', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ username: 'zhangsan', lastOrganization: '64700f00f1234' }), { status: 200 }),
    );

    expect(await new CodeupProvider().authenticate()).toBe('zhangsan');
  });

  it('falls back to CODEUP_USERNAME when the token is codeup-scope-only and the probe passes', async () => {
    mockScopeLimitedFetch(200);
    process.env.CODEUP_ORG_ID = '64700f00f1234';
    process.env.CODEUP_USERNAME = 'zhangsan';

    expect(await new CodeupProvider().authenticate()).toBe('zhangsan');
  });

  it('throws guidance when the org id is missing for a codeup-scope-only token', async () => {
    mockScopeLimitedFetch(200);

    await expect(new CodeupProvider().authenticate()).rejects.toThrow(/organizationId/);
  });

  it('rejects a token the probe answers with an error', async () => {
    mockScopeLimitedFetch(401);
    process.env.CODEUP_ORG_ID = '64700f00f1234';
    process.env.CODEUP_USERNAME = 'zhangsan';

    await expect(new CodeupProvider().authenticate()).rejects.toThrow(/rejected/);
  });

  it('throws a headless error when the username is unknown non-interactively', async () => {
    mockScopeLimitedFetch(200);
    process.env.CODEUP_ORG_ID = '64700f00f1234';

    await expect(new CodeupProvider().authenticate()).rejects.toThrow(/CODEUP_USERNAME/);
  });

  it('reports an unreachable API as unreachable, not as a rejected token', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    process.env.CODEUP_ORG_ID = '64700f00f1234';
    process.env.CODEUP_USERNAME = 'zhangsan';

    await expect(new CodeupProvider().authenticate()).rejects.toThrow(/Could not reach the Codeup API/);
  });

  it('needs no organizationId in the Region edition', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);

      if (url.endsWith('/oapi/v1/platform/user')) {
        return new Response(JSON.stringify({ errorCode: 'Forbidden' }), { status: 403 });
      }

      if (url.includes('/oapi/v1/codeup/repositories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }

      return new Response(JSON.stringify({ error: `no mock for ${url}` }), { status: 500 });
    });
    process.env.YUNXIAO_EDITION = 'region';
    process.env.CODEUP_USERNAME = 'zhangsan';

    expect(await new CodeupProvider().authenticate()).toBe('zhangsan');
  });

  it('asks for a missing organizationId interactively and persists it', async () => {
    mockScopeLimitedFetch(200);
    process.env.CODEUP_USERNAME = 'zhangsan';
    questionAnswers = ['64700f00f1234'];
    const originalIsTTY = process.stdin.isTTY;

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      expect(await new CodeupProvider().authenticate()).toBe('zhangsan');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    const saved = JSON.parse(fs.readFileSync(path.join(tmpHome, '.teamai', 'codeup.json'), 'utf-8'));

    expect(saved.organizationId).toBe('64700f00f1234');
    expect(questionAnswers).toHaveLength(0);
  });
});
