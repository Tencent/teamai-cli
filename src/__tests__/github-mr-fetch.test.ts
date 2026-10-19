import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execSync: vi.fn(() => { throw new Error('gh unavailable'); }),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));
import { log } from '../utils/logger.js';

const PR = '/repos/team/repo/pulls/42';
const METADATA = { title: 'Fix retries', body: null, user: { login: 'dev' }, merged_at: null };

/** The review threads (#1187): diff comments, review summaries, conversation. */
const REVIEW_COMMENTS = [
  { id: 1, body: 'Three retries hide a dead bucket.', path: 'src/up.ts', line: 42, user: { login: 'bob' } },
  { id: 2, body: 'Unrelated nit', path: 'src/x.ts', line: null, original_line: 7, user: { login: 'carol' } },
  { id: 3, body: 'Agreed, fail fast on 403.', path: 'src/up.ts', line: 42, in_reply_to_id: 1, user: { login: 'dev' } },
];
const REVIEWS = [
  { body: '', state: 'APPROVED', user: { login: 'bob' } },
  { body: 'Please split the retry policy out.', state: 'CHANGES_REQUESTED', user: { login: 'carol' } },
  { body: 'draft', state: 'PENDING', user: { login: 'erin' } },
];
const CONVERSATION = [
  { body: '<!-- teamai:ci-extract -->\n## TeamAI 知识提炼', user: { login: 'ci-bot' } },
  { body: 'Merging after the split.', user: { login: 'dev' } },
];

function mockResponses(failedPath?: string, status = 200, body = '', responseError?: Error): string[] {
  const seen: string[] = [];
  const request = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const url = String(options.path);
    seen.push(url);
    const diff = options.headers && (options.headers as Record<string, string>).Accept.includes('.diff');
    const key = diff ? `${url}.diff` : url;
    const failed = key === failedPath;
    const response = failed ? body : diff ? 'diff --git a/a b/a\n+fixed\n'
      : url === PR ? JSON.stringify(METADATA)
      : url.startsWith(`${PR}/comments`) ? JSON.stringify(REVIEW_COMMENTS)
      : url.startsWith(`${PR}/reviews`) ? JSON.stringify(REVIEWS)
      : url.startsWith('/repos/team/repo/issues/42/comments') ? JSON.stringify(CONVERSATION)
      : JSON.stringify([{ sha: 'abc123', commit: { message: 'Fix retries\n\nDetails' } }]);
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end() {
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: failed ? status : 200 });
          callback(res as IncomingMessage);
          res.emit('data', Buffer.from(response));
          if (failed && responseError) {
            // Keep the baseline's unhandled event from crashing the test worker.
            res.on('error', () => {});
            res.emit('error', responseError);
            res.emit('close');
            return;
          }
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
  it.each([PR, `${PR}/commits?per_page=50`, `${PR}.diff`])(
    'rejects when the response stream fails at %s', async (endpoint) => {
      const error = new Error('aborted');
      const seen = mockResponses(endpoint, 200, 'partial response', error);
      await expect(Promise.race([
        fetchGitHubPR('https://github.com/team/repo/pull/42'),
        setImmediate('response error was not handled'),
      ])).rejects.toBe(error);
      expect(seen.at(-1)).toBe(endpoint.replace(/\.diff$/, ''));
    },
  );

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

describe('GitHub PR review threads (#1187)', () => {
  it('groups diff comments into threads and adds review verdicts and conversation, without teamai comments', async () => {
    mockResponses();
    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42');
    expect(mr.discussions).toEqual([
      { file: 'src/up.ts', line: 42, notes: [{ author: 'bob', body: 'Three retries hide a dead bucket.' }, { author: 'dev', body: 'Agreed, fail fast on 403.' }] },
      { file: 'src/x.ts', line: 7, notes: [{ author: 'carol', body: 'Unrelated nit' }] },
      { notes: [{ author: 'carol', body: 'changes requested: Please split the retry policy out.' }] },
      { notes: [{ author: 'dev', body: 'Merging after the split.' }] },
    ]);
  });

  it('requests none of the list endpoints with discussions: false', async () => {
    const seen = mockResponses();
    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false });
    expect(mr).not.toHaveProperty('discussions');
    expect(seen.filter((u) => /comments|reviews/.test(u))).toEqual([]);
  });

  it('keeps the extraction going, with a warning, when a list endpoint fails', async () => {
    vi.mocked(log.warn).mockClear();
    mockResponses(`${PR}/reviews?per_page=100&page=1`, 403, '{"message":"Forbidden"}');
    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42');
    expect(mr.title).toBe('Fix retries');
    expect(mr).not.toHaveProperty('discussions');
    expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringMatching(/Review threads not read \(GitHub API error 403/),
    ]);
  });
});
