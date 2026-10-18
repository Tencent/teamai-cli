import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSelfHostedGitLab } from '../providers/gitlab/probe.js';
import { detectProviderForInit } from '../providers/registry.js';

const repoUrl = 'https://code.example.com/group/project.git';
const gitlabMeta = JSON.stringify({ correlation_id: '01TESTREQUEST', version: '1' });
const gitlabPage = '<html><head><meta property="og:site_name" content="GitLab">'
  + '<script>window.gon = {}; gon.api_version = "v4";</script></head></html>';

function htmlResponse(body = gitlabPage, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('anonymous self-hosted GitLab probe', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['https://code.example.com/group/project.git', 'https://code.example.com'],
    ['http://code.example.com:8080/group/subgroup/project', 'http://code.example.com:8080'],
    ['https://code.example.com:8443/group/project.git', 'https://code.example.com:8443'],
    ['git@code.example.com:group/project.git', 'https://code.example.com'],
    ['ssh://git@code.example.com:2222/group/project.git', 'https://code.example.com'],
  ])('probes the web origin for %s', async (input, baseUrl) => {
    fetchMock.mockResolvedValue(htmlResponse());

    await expect(probeSelfHostedGitLab(input)).resolves.toEqual({ baseUrl });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/users/sign_in?auto_sign_in=false`);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      redirect: 'manual',
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('does not send environment credentials during discovery', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'gitlab-secret');
    vi.stubEnv('GITHUB_TOKEN', 'github-secret');
    vi.stubEnv('TEAMAI_GITLAB_TOKEN', 'teamai-secret');
    fetchMock.mockResolvedValue(htmlResponse());

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toEqual({ baseUrl: 'https://code.example.com' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://code.example.com/users/sign_in?auto_sign_in=false');
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].some((name) => /authorization|token|cookie|key/i.test(name))).toBe(false);
    expect(JSON.stringify([...headers.entries()])).not.toMatch(/gitlab-secret|github-secret|teamai-secret/);
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe('omit');
  });

  it.each([
    '',
    'group/project',
    'https://code.example.com',
    'https://code.example.com/group',
    'file:///tmp/group/project.git',
    'ftp://code.example.com/group/project.git',
    'https://oauth2:secret@code.example.com/group/project.git',
    'https://user@code.example.com/group/project.git',
    'ssh://git:secret@code.example.com/group/project.git',
    'oauth2:secret@code.example.com:group/project.git',
    'https://code.example.com/group/project.git?token=secret',
    'https://code.example.com/group/project.git#secret',
    'ssh://git@code.example.com/group/project.git?token=secret',
    'git@code.example.com:group/project.git#secret',
  ])('rejects unsafe or non-repository input without making a request: %s', async (input) => {
    await expect(probeSelfHostedGitLab(input)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([200, 204, 401, 403])('accepts a structured GitLab metadata header on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, {
      status,
      headers: { 'X-Gitlab-Meta': gitlabMeta },
    }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toEqual({ baseUrl: 'https://code.example.com' });
  });

  it.each([
    'GitLab',
    '{invalid json}',
    '{}',
    '{"correlation_id":"request"}',
    '{"version":"1"}',
    '{"correlation_id":"","version":"1"}',
    '{"correlation_id":"request","version":""}',
    '{"correlation_id":123,"version":"1"}',
    '{"correlation_id":"request","version":1}',
    '[{"correlation_id":"request","version":"1"}]',
  ])('does not identify GitLab from an invalid metadata header: %s', async (header) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401, headers: { 'x-gitlab-meta': header } }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it.each([401, 403])('does not identify GitLab from HTTP %i alone', async (status) => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it.each([
    '<meta content="GitLab" property="og:site_name"><script>gon.api_version="v4";</script>',
    "<meta property='og:site_name' content='GitLab'><script>gon.api_version = 'v4';</script>",
    "<meta data-other='value' content='GitLab' property='og:site_name' /><script nonce='abc'>gon.api_version = 'v4';</script>",
  ])('recognizes independent HTML fingerprints with different attribute ordering and quoting', async (body) => {
    fetchMock.mockResolvedValue(htmlResponse(body));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toEqual({ baseUrl: 'https://code.example.com' });
  });

  it.each([
    '<html><h1>GitLab hosting guide</h1></html>',
    '<meta property="og:site_name" content="GitLab">',
    '<script>gon.api_version="v4";</script>',
    '<meta property="og:site_name" content="GitLab"><p>gon.api_version="v4";</p>',
    '<meta property="og:site_name" content="Not GitLab"><script>gon.api_version="v4";</script>',
    '<meta property="og:site_name" content="GitLab"><script>gon.api_version="v3";</script>',
    '&lt;meta property="og:site_name" content="GitLab"&gt;<script>gon.api_version="v4";</script>',
    '<!-- <meta property="og:site_name" content="GitLab"> --><script>gon.api_version="v4";</script>',
    '<script>const template = `<meta property="og:site_name" content="GitLab">`; gon.api_version="v4";</script>',
  ])('does not mistake partial fingerprints or GitLab mentions for a GitLab instance', async (body) => {
    fetchMock.mockResolvedValue(htmlResponse(body));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it('requires HTML content type for the HTML fingerprint', async () => {
    fetchMock.mockResolvedValue(new Response(gitlabPage, { headers: { 'content-type': 'text/plain' } }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it.each([201, 401, 403])('does not use HTML fingerprints on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(htmlResponse(gitlabPage, status));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it.each([302, 500])('rejects HTTP %i even when a response contains GitLab fingerprints', async (status) => {
    fetchMock.mockResolvedValue(new Response(gitlabPage, {
      status,
      headers: {
        'x-gitlab-meta': gitlabMeta,
        'content-type': 'text/html',
        location: 'https://sso.example.com/login',
      },
    }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('returns null for certificate or connection failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: self-signed certificate'));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it('aborts when response headers do not arrive before the deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const pending = probeSelfHostedGitLab(repoUrl, 25);
    await vi.advanceTimersByTimeAsync(26);

    await expect(pending).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('enforces the same deadline when headers arrive but the HTML body stalls', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><head>'));
      },
      cancel,
    }), { headers: { 'content-type': 'text/html' } }));

    const pending = probeSelfHostedGitLab(repoUrl, 25);
    await vi.advanceTimersByTimeAsync(26);

    await expect(pending).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects oversized HTML even when the fingerprint appears before the limit', async () => {
    fetchMock.mockResolvedValue(htmlResponse(gitlabPage + 'x'.repeat(128 * 1024)));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
  });

  it('limits streamed body bytes without trusting Content-Length', async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(gitlabPage));
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel,
    }), { headers: { 'content-type': 'text/html', 'content-length': '1' } }));

    await expect(probeSelfHostedGitLab(repoUrl)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('provider discovery during initialization', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITLAB_URL', '');
    vi.stubEnv('TEAMAI_GITLAB_HOST', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['https://github.com/group/project.git', 'github'],
    ['git@gitlab.com:group/project.git', 'gitlab'],
    ['https://git.woa.com/group/project.git', 'tgit'],
    ['https://cnb.cool/group/project.git', 'cnb'],
  ])('keeps known provider %s without a network request', async (input, provider) => {
    await expect(detectProviderForInit(input)).resolves.toBe(provider);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses explicitly configured self-hosted GitLab without probing', async () => {
    vi.stubEnv('GITLAB_URL', 'https://code.example.com:8443');

    await expect(detectProviderForInit('git@code.example.com:group/project.git')).resolves.toBe('gitlab');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps generic Git when the host cannot be positively identified', async () => {
    fetchMock.mockResolvedValue(htmlResponse('<h1>Company Git hosting</h1>'));

    await expect(detectProviderForInit(repoUrl)).resolves.toBe('git');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/version');
  });

  it('reports the detected instance and required setup before writing a provider choice', async () => {
    fetchMock.mockResolvedValue(htmlResponse());

    await expect(detectProviderForInit(repoUrl)).rejects.toThrow(
      /Detected self-hosted GitLab at https:\/\/code\.example\.com\..*GITLAB_URL=https:\/\/code\.example\.com.*GITLAB_TOKEN.*api scope.*teamai init again/,
    );
    expect(process.env.GITLAB_URL).toBe('');
  });
});
