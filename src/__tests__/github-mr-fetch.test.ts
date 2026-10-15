import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execSync: vi.fn(() => { throw new Error('gh unavailable'); }),
}));

const PR = '/repos/team/repo/pulls/42';
const METADATA = { title: 'Fix retries', body: null, user: { login: 'dev' }, merged_at: null };

function mockResponses(failedPath?: string, status = 200, body = ''): string[] {
  const seen: string[] = [];
  const request = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const url = String(options.path);
    seen.push(url);
    const diff = options.headers && (options.headers as Record<string, string>).Accept.includes('.diff');
    const key = diff ? `${url}.diff` : url;
    const failed = key === failedPath;
    const response = failed ? body : diff ? 'diff --git a/a b/a\n+fixed\n'
      : url === PR ? JSON.stringify(METADATA)
      : JSON.stringify([{ sha: 'abc123', commit: { message: 'Fix retries\n\nDetails' } }]);
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end() {
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: failed ? status : 200 });
          callback(res as IncomingMessage);
          res.emit('data', Buffer.from(response));
          res.emit('end');
        });
      },
    });
    return req as unknown as ReturnType<typeof https.request>;
  };
  vi.spyOn(https, 'request').mockImplementation(request as typeof https.request);
  return seen;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('GitHub PR REST fallback', () => {
  it.each([
    [404, '{"message":"Not Found"}'],
    [403, '<html>Rate limit exceeded</html>'],
  ])('reports HTTP %i before parsing metadata or requesting commits', async (status, body) => {
    const seen = mockResponses(PR, status, body);
    await expect(fetchGitHubPR('https://github.com/team/repo/pull/42'))
      .rejects.toThrow(`GitHub API error ${status}: ${body}`);
    expect(seen).toEqual([PR]);
  });

  it('reports a commits endpoint error instead of calling map on an error object', async () => {
    mockResponses(`${PR}/commits?per_page=50`, 429, '{"message":"Too many requests"}');
    await expect(fetchGitHubPR('https://github.com/team/repo/pull/42'))
      .rejects.toThrow('GitHub API error 429: {"message":"Too many requests"}');
  });

  it('does not pass an HTTP error page to the learning extractor as a diff', async () => {
    mockResponses(`${PR}.diff`, 503, 'Service Unavailable');
    await expect(fetchGitHubPR('https://github.com/team/repo/pull/42'))
      .rejects.toThrow('GitHub API diff error 503: Service Unavailable');
  });

  it('preserves metadata, commit headlines, and diff on success', async () => {
    mockResponses();
    await expect(fetchGitHubPR('https://github.com/team/repo/pull/42')).resolves.toMatchObject({
      title: 'Fix retries', description: '', author: 'dev',
      commits: [{ hash: 'abc123', message: 'Fix retries' }],
      diff: 'diff --git a/a b/a\n+fixed\n',
    });
  });
});
