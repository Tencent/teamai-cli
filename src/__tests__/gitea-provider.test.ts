import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as homes from '../utils/home.js';
import { getUserHome } from '../utils/home.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GiteaProvider } from '../providers/gitea/index.js';
import { assertGiteaHttpUrl, giteaBaseUrl, parseGiteaPrUrl, parseGiteaRepoInput } from '../providers/gitea/repo-url.js';
import { getGiteaToken, giteaCreateRepo, giteaGetSync, giteaGitHeader, giteaJson, giteaList, giteaPullCreate, giteaRepoClone, giteaWhoami, readGiteaText, redactGiteaOutput, writeGiteaNetrcToken } from '../providers/gitea/gitea-api.js';
import { giteaListOrgRepos, giteaOrganizationExists } from '../providers/gitea/org.js';
import { fetchGiteaMR } from '../providers/gitea/mr-fetch.js';
import { probeSelfHostedGitea } from '../providers/gitea/probe.js';
import { detectProvider, detectProviderForInit, getDefaultProvider, getProvider } from '../providers/registry.js';
import { askSecret, isInteractive } from '../utils/prompt.js';
import { log } from '../utils/logger.js';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn() }));
vi.mock('../utils/prompt.js', async (original) => ({ ...await original<typeof import('../utils/prompt.js')>(), askSecret: vi.fn(), isInteractive: vi.fn(() => false) }));

const instance = 'http://gitea.test:3000';
const credentialsFile = path.join(getUserHome(), '.netrc');
let fetchMock = vi.fn<typeof fetch>();
let sequence = 0;

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function pull(base = 'main', repository = 'org/repo') {
  return { number: 12, html_url: `${instance}/org/repo/pulls/12`,
    head: { ref: 'feature', repo: { full_name: repository } }, base: { ref: base, repo: { full_name: repository } } };
}

const options = { repo: 'org/repo', source: 'feature', target: 'main', title: 'Share a skill' };

beforeEach(() => {
  vi.stubEnv('GITEA_URL', instance);
  vi.stubEnv('GITEA_TOKEN', `test-token-${++sequence}`);
  vi.stubEnv('TEAMAI_GITEA_HOST', '');
  vi.stubEnv('GITLAB_URL', '');
  vi.stubEnv('TEAMAI_GITLAB_HOST', '');
  fs.rmSync(credentialsFile, { force: true });
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(spawnSync).mockReset();
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'success').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(credentialsFile, { force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Gitea instance and URL boundary', () => {
  it.each([
    ['org/repo', `${instance}/org/repo.git`],
    [`${instance}/org/repo`, `${instance}/org/repo.git`],
    [`${instance}/org/repo.git`, `${instance}/org/repo.git`],
    [`${instance}/org/repo/pulls/12`, `${instance}/org/repo.git`],
    ['ssh://git@gitea.test:2222/org/repo.git', 'ssh://git@gitea.test:2222/org/repo.git'],
    ['git@gitea.test:org/repo.git', 'ssh://git@gitea.test/org/repo.git'],
  ])('parses %s without changing the transport', (input, expected) => {
    expect(parseGiteaRepoInput(input)).toEqual({ owner: 'org', repo: 'repo', projectId: 'org/repo', httpsUrl: expected });
    expect(detectProvider(input)).toBe(input === 'org/repo' ? getDefaultProvider() : 'gitea');
  });

  it('strips only a complete configured reverse-proxy prefix', () => {
    vi.stubEnv('GITEA_URL', 'https://gitea.test/sub/path/');
    expect(parseGiteaPrUrl('https://gitea.test/sub/path/org/repo/pulls/42').number).toBe(42);
    expect(parseGiteaRepoInput('org/repo').httpsUrl).toBe('https://gitea.test/sub/path/org/repo.git');
    expect(() => parseGiteaRepoInput('https://gitea.test/sub/path-other/org/repo')).toThrow(/base path/);
  });

  it.each([
    'http://gitea.test:3001/org/repo', 'https://gitea.test:3000/org/repo',
    'http://other.test:3000/org/repo', 'http://alice:secret@gitea.test:3000/org/repo',
    'ssh://git@alias.test:2222/org/repo', 'org/sub/repo', 'org/%2frepo', 'org/..',
    'org/repo/pull/12', 'org/repo/pulls/0', 'file:///org/repo',
  ])('rejects mismatched or malformed URL %s before I/O', (input) => {
    expect(() => parseGiteaRepoInput(input)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', 'gitea.test', 'ftp://gitea.test', 'http://user:pass@gitea.test', 'http://gitea.test/?token=secret'])('rejects invalid GITEA_URL %s', (value) => {
    vi.stubEnv('GITEA_URL', value);
    expect(() => giteaBaseUrl()).toThrow(/GITEA_URL/);
  });

  it('allows the same host hint but rejects a different hostname or HTTP port', () => {
    vi.stubEnv('TEAMAI_GITEA_HOST', 'gitea.test');
    expect(giteaBaseUrl()).toBe(instance);
    vi.stubEnv('TEAMAI_GITEA_HOST', 'gitea.test:3001');
    expect(() => giteaBaseUrl()).toThrow(/same instance/);
    expect(() => assertGiteaHttpUrl('http://other.test/org/repo')).toThrow();
  });

  it('registers the provider and explicit default override', () => {
    vi.stubEnv('TEAMAI_DEFAULT_PROVIDER', 'gitea');
    expect(getDefaultProvider()).toBe('gitea');
    expect(getProvider('gitea')).toBeInstanceOf(GiteaProvider);
    expect(new GiteaProvider().getDefaultEmailDomain()).toBeNull();
    expect(new GiteaProvider().getOrganizationCreateUrl()).toBe(`${instance}/org/create`);
  });
});

describe('Gitea credentials', () => {
  it('prefers env over a multiline host-scoped netrc entry', () => {
    fs.writeFileSync(credentialsFile, 'machine gitea.test\n login alice\n password saved-token\nmachine other.test login bob password other-token\n');
    expect(getGiteaToken()).toBe(process.env.GITEA_TOKEN);
    vi.stubEnv('GITEA_TOKEN', '');
    expect(getGiteaToken()).toBe('saved-token');
  });

  it('preserves other hosts when replacing credentials and enforces mode 0600', () => {
    fs.writeFileSync(credentialsFile, 'machine other.test login bob password keep-me\nmachine gitea.test\n login old\n password old-token\n', { mode: 0o644 });
    writeGiteaNetrcToken('new-token', 'alice');
    const text = fs.readFileSync(credentialsFile, 'utf8');
    expect(text).toContain('password keep-me');
    expect(text).not.toContain('old-token');
    expect(text).toContain('machine gitea.test login alice password new-token');
    if (process.platform !== 'win32') expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600);
  });

  it('does not prompt without a TTY, but accepts a valid configured token', async () => {
    vi.stubEnv('GITEA_TOKEN', '');
    await expect(new GiteaProvider().authenticate()).rejects.toThrow(/GITEA_TOKEN/);
    expect(askSecret).not.toHaveBeenCalled();
    vi.stubEnv('GITEA_TOKEN', 'noninteractive-token');
    fetchMock.mockResolvedValue(json({ login: 'alice' }));
    await expect(new GiteaProvider().authenticate()).resolves.toBe('alice');
  });

  it('verifies a pasted PAT before saving it', async () => {
    vi.stubEnv('GITEA_TOKEN', '');
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askSecret).mockResolvedValue('pasted-token');
    fetchMock.mockResolvedValue(json({ login: 'alice' }));
    await expect(new GiteaProvider().authenticate()).resolves.toBe('alice');
    expect(getGiteaToken()).toBe('pasted-token');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'token pasted-token' });
  });

  it.each([401, 403])('does not save rejected interactive credentials (%s)', async (status) => {
    vi.stubEnv('GITEA_TOKEN', '');
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askSecret).mockResolvedValue('rejected-token');
    fetchMock.mockResolvedValue(json({ message: 'private server detail' }, status));
    await expect(new GiteaProvider().authenticate()).rejects.toThrow(status === 401 ? /token rejected/ : /permission denied/);
    expect(fs.existsSync(credentialsFile)).toBe(false);
  });

  it('caches login per instance and token, and builds Basic with the real login', async () => {
    fetchMock.mockResolvedValue(json({ login: 'alice' }));
    expect(await giteaWhoami()).toBe('alice');
    expect(await giteaGitHeader()).toBe(`Authorization: Basic ${Buffer.from(`alice:${process.env.GITEA_TOKEN}`).toString('base64')}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubEnv('GITEA_TOKEN', 'another-token');
    fetchMock.mockResolvedValue(json({ login: 'bob' }));
    expect(await giteaWhoami()).toBe('bob');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts raw, encoded and header-form credentials', () => {
    vi.stubEnv('GITEA_TOKEN', 'secret:/token@');
    const text = redactGiteaOutput('secret:/token@ secret%3A%2Ftoken%40 http://alice:secret%3A%2Ftoken%40@gitea.test Authorization: Basic YWxpY2U6c2VjcmV0');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('YWxpY2U');
  });
});

describe('Gitea REST and pagination', () => {
  it('reads short pages until empty, even if the server clamps page size', async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 1 }])).mockResolvedValueOnce(json([{ id: 2 }])).mockResolvedValueOnce(json([]));
    expect(await giteaList('/orgs/org/repos')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('follows valid next-page links without changing endpoints', async () => {
    fetchMock.mockResolvedValueOnce(json([1], 200, { Link: `<${instance}/api/v1/orgs/org/repos?page=3>; rel="next"` }))
      .mockResolvedValueOnce(json([2], 200, { Link: `<${instance}/api/v1/orgs/org/repos?page=1>; rel="first"` }));
    expect(await giteaList('/orgs/org/repos')).toEqual([1, 2]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=3');
  });

  it('rejects cross-host pagination without sending a second token', async () => {
    fetchMock.mockResolvedValueOnce(json([1], 200, { Link: '<http://other.test/api/v1/orgs/org/repos?page=2>; rel="next"' }));
    await expect(giteaList('/orgs/org/repos')).rejects.toThrow(/next-page/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps org lists explicitly and supports maxRepos=0', async () => {
    expect(await giteaList('/orgs/org/repos', 0)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json([1, 2, 3]));
    expect(await giteaList('/orgs/org/repos', 2)).toEqual([1, 2]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('maxRepos=2'));
    await expect(giteaList('/orgs/org/repos', -1)).rejects.toThrow(/maxRepos/);
  });

  it('rejects redirects, invalid JSON, malformed lists and oversize JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 302));
    await expect(giteaJson('/user')).rejects.toThrow(/302/);
    fetchMock.mockResolvedValueOnce(new Response('not json'));
    await expect(giteaJson('/user')).rejects.toThrow(/invalid JSON/);
    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    await expect(giteaList('/orgs/org/repos')).rejects.toThrow(/invalid list/);
    await expect(readGiteaText(new Response('12345'), 4)).rejects.toThrow(/size limit/);
  });

  it('cancels a stalled API request within its timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
    }));
    const result = expect(giteaJson('/user')).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });
});

describe('Gitea PR create and recovery', () => {
  it('creates a PR and independently requests valid and invalid reviewers', async () => {
    fetchMock.mockResolvedValueOnce(json(pull(), 201)).mockResolvedValueOnce(json({}, 201)).mockResolvedValueOnce(json({}, 422));
    expect(await giteaPullCreate({ ...options, reviewers: ['alice', 'missing'] })).toBe(pull().html_url);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ reviewers: ['alice'] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('recovers the complete identity across pages and still requests reviewers', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 409)).mockResolvedValueOnce(json([pull('release'), pull('main', 'fork/repo')]))
      .mockResolvedValueOnce(json([pull()])).mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({}, 201));
    expect(await giteaPullCreate({ ...options, reviewers: ['alice'] })).toBe(pull().html_url);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/pulls/12/requested_reviewers');
  });

  it('finds an already-created PR after an ambiguous transport failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network reset')).mockResolvedValueOnce(json([pull()])).mockResolvedValueOnce(json([]));
    expect(await giteaPullCreate(options)).toBe(pull().html_url);
  });

  it('retains a 409 when no exact PR exists', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 409)).mockResolvedValueOnce(json([pull('release')])).mockResolvedValueOnce(json([]));
    await expect(giteaPullCreate(options)).rejects.toThrow(/409/);
  });

  it('does not retry a definitive authorization or server failure', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    await expect(giteaPullCreate(options)).rejects.toThrow(/permission/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a PR response from another instance', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...pull(), html_url: 'http://other.test/org/repo/pulls/12' }, 201));
    await expect(giteaPullCreate(options)).rejects.toThrow(/configured instance/);
  });
});

describe('Gitea clone and organizations', () => {
  it('preserves an explicit SSH origin and port without attaching a PAT', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
    giteaRepoClone('ssh://git@gitea.test:2222/org/repo.git', '/test/clone');
    expect(spawnSync).toHaveBeenCalledWith('git', ['clone', 'ssh://git@gitea.test:2222/org/repo.git', '/test/clone'], expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists encoded HTTP credentials after verification for subsequent pushes', async () => {
    vi.stubEnv('GITEA_TOKEN', 'token:/@');
    fetchMock.mockResolvedValueOnce(json({ login: 'alice' }));
    await giteaWhoami();
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
    giteaRepoClone('org/repo', '/test/clone');
    expect(spawnSync).toHaveBeenCalledWith('git', ['clone', 'http://alice:token%3A%2F%40@gitea.test:3000/org/repo.git', '/test/clone'], expect.anything());
  });

  it('uses Node stdin for synchronous API lookups, keeping tokens out of argv', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify({ status: 200, text: '{"id":1}' }), stderr: '' } as never);
    expect(giteaGetSync('/orgs/org')).toEqual({ id: 1 });
    expect(JSON.stringify(vi.mocked(spawnSync).mock.calls[0][1])).not.toContain(process.env.GITEA_TOKEN);
    expect(giteaOrganizationExists('org')).toBe(true);
  });

  it('distinguishes missing organizations from denied or timed-out lookups', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ status: 404, text: '{}' }) } as never);
    expect(giteaOrganizationExists('org')).toBe(false);
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ status: 403, text: '{}' }) } as never);
    expect(() => giteaOrganizationExists('org')).toThrow(/permission denied/);
    vi.mocked(spawnSync).mockReturnValueOnce({ status: null, stdout: '' } as never);
    expect(() => giteaGetSync('/user')).toThrow(/timed out/);
  });

  it('maps organization repository metadata and validates supplied clone URLs', async () => {
    fetchMock.mockResolvedValueOnce(json([{ name: 'repo', full_name: 'org/repo', clone_url: `${instance}/org/repo.git`, language: 'TypeScript', stars_count: 2 }]))
      .mockResolvedValueOnce(json([]));
    expect(await giteaListOrgRepos('org')).toEqual([expect.objectContaining({ name: 'repo', fullName: 'org/repo', primaryLanguage: 'TypeScript', stars: 2 })]);
  });

  it.each([['alice', '/user/repos'], ['org', '/orgs/org/repos']])('creates a private empty repo for %s', async (owner, endpoint) => {
    fetchMock.mockResolvedValueOnce(json({ login: 'alice' })).mockResolvedValueOnce(json({}, 201));
    await giteaCreateRepo(owner, 'repo');
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${instance}/api/v1${endpoint}`);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ name: 'repo', private: true, auto_init: false });
  });
});

describe('Gitea PR evidence', () => {
  it('fetches paginated commits and marks bounded diff evidence explicitly', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Fix', body: 'Reason', user: { login: 'alice' }, merged_at: '2026-10-18T00:00:00Z' }))
      .mockResolvedValueOnce(json([{ sha: 'abc', commit: { message: 'Fix input\n\nDetails' } }]))
      .mockResolvedValueOnce(json([{ sha: 'def', commit: { message: 'Add regression' } }]))
      .mockResolvedValueOnce(json([])).mockResolvedValueOnce(new Response('你'.repeat(20000)));
    const data = await fetchGiteaMR(`${instance}/org/repo/pulls/12`, { discussions: false });
    expect(data.commits).toHaveLength(2);
    expect(data.author).toBe('alice');
    expect(data.diff).toContain('Diff truncated');
    expect(data.diff).not.toContain('\ufffd');
    expect(Buffer.byteLength(data.diff)).toBeLessThanOrEqual(50 * 1024);
  });

  it('does not silently import missing required diff data', async () => {
    fetchMock.mockResolvedValueOnce(json({ title: 'Fix' })).mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({}, 403));
    await expect(fetchGiteaMR(`${instance}/org/repo/pulls/12`)).rejects.toThrow(/permission/);
  });
});

describe('anonymous self-hosted Gitea probe', () => {
  it('detects a subpath candidate without Authorization or product-name guesses', async () => {
    fetchMock.mockResolvedValueOnce(json({ version: '15.0.0' }));
    expect(await probeSelfHostedGitea('http://gitea.test:3000/sub/path/org/repo')).toEqual({ baseUrl: `${instance}/sub/path`, version: '15.0.0' });
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('instructs init to configure a compatible but unknown host', async () => {
    vi.stubEnv('GITEA_URL', '');
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ version: '1.27.3' }));
    await expect(detectProviderForInit(`${instance}/org/repo`)).rejects.toThrow(/Set GITEA_URL/);
  });

  it('does not probe SSH or credential-bearing URLs', async () => {
    expect(await probeSelfHostedGitea('ssh://git@gitea.test:2222/org/repo')).toBeNull();
    expect(await probeSelfHostedGitea('http://user:pass@gitea.test/org/repo')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds the whole probe even when fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = probeSelfHostedGitea(`${instance}/sub/path/org/repo`, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('Gitea review discussions', () => {
  function evidence(failReview = false) {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const route = url.pathname;
      if (route.endsWith('/pulls/12')) return json({ title: 'Fix' });
      if (route.endsWith('.diff')) return new Response('diff');
      if (!route.endsWith('/comments') && url.searchParams.get('page') !== '1') return json([]);
      if (route.endsWith('/commits')) return json([]);
      if (route.endsWith('/issues/12/comments')) return json([
        { id: 3, body: 'general', created_at: '2026-01-03', user: { login: 'author' } },
        { id: 3, body: 'general', created_at: '2026-01-03', user: { login: 'author' } },
        { id: 4, body: '<!-- teamai:ci-extract --> generated' },
        { id: 5, body: 'CUSTOM generated' },
      ]);
      if (route.endsWith('/reviews')) return json([
        { id: 10, body: 'review summary', state: 'APPROVED', submitted_at: '2026-01-01', user: { login: 'reviewer' } },
        { id: 11, body: 'draft secret', state: 'PENDING' },
        { id: 12, body: 'invitation', state: 'REQUEST_REVIEW' },
      ]);
      if (route.endsWith('/reviews/10/comments')) return failReview ? json({}, 403) : json([
        { id: 20, body: 'inline one', path: 'a.ts', position: 5, resolver: null, created_at: '2026-01-02' },
        { id: 21, body: 'inline two', path: 'a.ts', position: 5, resolver: { login: 'author' }, created_at: '2026-01-02' },
        { id: 22, body: '   ' },
      ]);
      throw new Error('Unexpected API route: ' + route);
    });
  }
  it('preserves review, inline and issue evidence without inventing reply links or line numbers', async () => {
    evidence();
    const data = await fetchGiteaMR(`${instance}/org/repo/pulls/12`, { commentMarker: 'CUSTOM' });
    expect(data.discussions).toHaveLength(4);
    expect(data.discussions?.map(t => t.notes[0].body)).toEqual(['review summary', 'inline one', 'inline two', 'general']);
    expect(data.discussions?.[1]).toMatchObject({ file: 'a.ts', resolved: false, sourceId: 'review:10:comment:20', createdAt: '2026-01-02' });
    expect(data.discussions?.[1].line).toBeUndefined();
    expect(data.discussions?.[2].resolved).toBe(true);
    expect(data.discussions?.every(t => t.notes.length === 1)).toBe(true);
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/comments')) expect(url.search).toBe('');
    }
  });
  it('does not request discussions when disabled', async () => {
    evidence();
    const data = await fetchGiteaMR(`${instance}/org/repo/pulls/12`, { discussions: false });
    expect(data.discussions).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => /reviews|comments/.test(String(url)))).toBe(false);
  });
  it('keeps required evidence and successful discussions when an inline endpoint fails', async () => {
    evidence(true);
    const data = await fetchGiteaMR(`${instance}/org/repo/pulls/12`, { commentMarker: 'CUSTOM' });
    expect(data.diff).toBe('diff');
    expect(data.discussions?.map(t => t.notes[0].body)).toEqual(['review summary', 'general']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('review 10 comments unavailable'));
  });
});


describe('Gitea credential home compatibility', () => {
  it('reads a legacy netrc only after the current home and writes to the current home', () => {
    vi.stubEnv('GITEA_TOKEN', '');
    const legacy = fs.mkdtempSync(path.join(getUserHome(), 'gitea-legacy-'));
    try {
      vi.spyOn(homes, 'legacyUserHome').mockReturnValue(legacy);
      fs.writeFileSync(path.join(legacy, '.netrc'), 'machine gitea.test login old password legacy-token\n');
      expect(getGiteaToken()).toBe('legacy-token');
      writeGiteaNetrcToken('current-token', 'alice');
      expect(getGiteaToken()).toBe('current-token');
      expect(fs.readFileSync(path.join(legacy, '.netrc'), 'utf8')).toContain('legacy-token');
      expect(fs.readFileSync(credentialsFile, 'utf8')).toContain('current-token');
    } finally { fs.rmSync(legacy, { recursive: true, force: true }); }
  });
});


describe('Gitea total-count pagination', () => {
  it('stops when a non-paginated comment list reports its complete total', async () => {
    fetchMock.mockResolvedValue(json([{ id: 5, body: 'comment' }], 200, { 'x-total-count': '1' }));
    expect(await giteaList('/repos/org/repo/issues/1/comments')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('continues across a server-clamped page until the declared total is reached', async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 1 }], 200, { 'x-total-count': '2' }))
      .mockResolvedValueOnce(json([{ id: 2 }], 200, { 'x-total-count': '2' }));
    expect(await giteaList('/repos/org/repo/pulls')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


it('honors an explicit next link before a conflicting total count', async () => {
  fetchMock.mockResolvedValueOnce(json([{ id: 1 }], 200, { 'x-total-count': '1', link: `<${instance}/api/v1/repos/org/repo/pulls?page=2>; rel="next"` }))
    .mockResolvedValueOnce(json([]));
  expect(await giteaList('/repos/org/repo/pulls')).toEqual([{ id: 1 }]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
