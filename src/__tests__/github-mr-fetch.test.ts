import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';

vi.mock('../providers/github/gh-cli.js', () => ({
  ghExec: vi.fn(() => { throw new Error('gh unavailable'); }),
}));
import { ghExec } from '../providers/github/gh-cli.js';
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

function mockResponses(
  failedPath?: string,
  status = 200,
  body = '',
  responseError?: Error,
  commits = [{ sha: 'abc123', commit: { message: 'Fix retries\n\nDetails' } }],
): string[] {
  const seen: string[] = [];
  const request = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    const url = String(options.path);
    seen.push(url);
    const diff = options.headers && (options.headers as Record<string, string>).Accept.includes('.diff');
    const key = diff ? `${url}.diff` : url;
    const failed = key === failedPath;
    const params = new URL(url, 'https://api.github.com').searchParams;
    const pageSize = Number(params.get('per_page') ?? 100);
    const start = (Number(params.get('page') ?? 1) - 1) * pageSize;
    const response = failed ? body : diff ? 'diff --git a/a b/a\n+fixed\n'
      : url === PR ? JSON.stringify(METADATA)
      : url.startsWith(`${PR}/comments`) ? JSON.stringify(REVIEW_COMMENTS)
      : url.startsWith(`${PR}/reviews`) ? JSON.stringify(REVIEWS)
      : url.startsWith('/repos/team/repo/issues/42/comments') ? JSON.stringify(CONVERSATION)
      : JSON.stringify(commits.slice(start, start + pageSize));
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

beforeEach(() => {
  vi.mocked(ghExec).mockImplementation(() => { throw new Error('gh unavailable'); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('GitHub PR REST fallback', () => {
  it.each([PR, `${PR}/commits?per_page=100&page=1`, `${PR}.diff`])(
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
    mockResponses(`${PR}/commits?per_page=100&page=1`, 429, '{"message":"Too many requests"}');
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

  it.each([0, 1, 50, 51, 100, 101, 250])('paginates %i commits without dropping or reordering them', async (count) => {
    const commits = Array.from({ length: count }, (_, i) => ({
      sha: `commit-${i + 1}`, commit: { message: `Change ${i + 1}\n\nDetails` },
    }));
    const seen = mockResponses(undefined, 200, '', undefined, commits);
    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false });
    expect(mr.commits).toEqual(commits.map((c) => ({ hash: c.sha, message: c.commit.message.split('\n')[0] })));
    expect(seen.filter((u) => u.includes('/commits?'))).toEqual(
      Array.from({ length: Math.floor(count / 100) + 1 }, (_, i) => `${PR}/commits?per_page=100&page=${i + 1}`),
    );
  });

  it.each([
    [429, '{"message":"Too many requests"}', undefined, 'GitHub API error 429'],
    [200, '{"message":"Not a commit list"}', undefined, 'GitHub API returned no list'],
    [200, 'partial response', new Error('aborted'), 'aborted'],
  ] as const)('rejects a failed later commit page (%i, %s) instead of returning partial history', async (status, body, error, message) => {
    const commits = Array.from({ length: 100 }, (_, i) => ({ sha: `commit-${i}`, commit: { message: `Change ${i}` } }));
    const seen = mockResponses(`${PR}/commits?per_page=100&page=2`, status, body, error, commits);
    await expect(fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false })).rejects.toThrow(message);
    expect(seen.at(-1)).toBe(`${PR}/commits?per_page=100&page=2`);
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

describe('GitHub PR gh CLI path', () => {
  it('calls ghExec with argument arrays and preserves pr view metadata and diff', async () => {
    const mockGhExec = vi.mocked(ghExec);
    mockGhExec.mockImplementation((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            title: 'CLI PR Title',
            body: 'CLI PR Description',
            author: { login: 'cli-user' },
            mergedAt: '2026-10-24T00:00:00Z',
            commits: [{ oid: 'commit123', messageHeadline: 'Commit headline' }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return {
          status: 0,
          stdout: 'diff --git a/file b/file\n+change\n',
          stderr: '',
        };
      }
      if (args[0] === 'api') {
        return {
          status: 0,
          stdout: JSON.stringify([]),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unknown command' };
    });

    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false });
    expect(mr).toEqual({
      title: 'CLI PR Title',
      description: 'CLI PR Description',
      author: 'cli-user',
      mergedAt: '2026-10-24T00:00:00Z',
      commits: [{ hash: 'commit123', message: 'Commit headline' }],
      diff: 'diff --git a/file b/file\n+change\n',
      url: 'https://github.com/team/repo/pull/42',
    });

    expect(mockGhExec).toHaveBeenCalledWith(
      ['pr', 'view', '42', '--repo', 'team/repo', '--json', 'title,body,author,mergedAt,commits'],
    );
    expect(mockGhExec).toHaveBeenCalledWith(
      ['pr', 'diff', '42', '--repo', 'team/repo'],
      { maxBuffer: 50 * 1024 * 1024 },
    );
  });

  it('reads review threads via ghExec api', async () => {
    const mockGhExec = vi.mocked(ghExec);
    mockGhExec.mockImplementation((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            title: 'Threads PR',
            body: '',
            author: { login: 'author' },
            mergedAt: null,
            commits: [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'api') {
        const path = args[1];
        if (path.includes('/pulls/42/comments')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 1, body: 'Thread comment', path: 'file.ts', line: 10, user: { login: 'reviewer' } },
            ]),
            stderr: '',
          };
        }
        if (path.includes('/pulls/42/reviews')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: 'Looks good', state: 'APPROVED', user: { login: 'reviewer' } },
            ]),
            stderr: '',
          };
        }
        if (path.includes('/issues/42/comments')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { body: 'Issue conversation comment', user: { login: 'author' } },
            ]),
            stderr: '',
          };
        }
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    });

    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42');
    expect(mr.discussions).toEqual([
      { file: 'file.ts', line: 10, notes: [{ author: 'reviewer', body: 'Thread comment' }] },
      { notes: [{ author: 'reviewer', body: 'approved: Looks good' }] },
      { notes: [{ author: 'author', body: 'Issue conversation comment' }] },
    ]);
  });

  it('falls back to REST API when gh pr view exits with non-zero status', async () => {
    mockResponses();
    const mockGhExec = vi.mocked(ghExec);
    mockGhExec.mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'not logged in',
    }));

    const mr = await fetchGitHubPR('https://github.com/team/repo/pull/42', { discussions: false });
    expect(mr.title).toBe('Fix retries');
  });

  it('passes repo and number without shell interpretation, preventing command injection', async () => {
    const mockGhExec = vi.mocked(ghExec);
    mockGhExec.mockImplementation((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            title: 'Injection test',
            body: '',
            author: { login: 'user' },
            mergedAt: null,
            commits: [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    });

    await fetchGitHubPR('https://github.com/owner/repo$(whoami)/pull/42', { discussions: false });

    expect(mockGhExec).toHaveBeenCalledWith([
      'pr', 'view', '42',
      '--repo', 'owner/repo$(whoami)',
      '--json', 'title,body,author,mergedAt,commits',
    ]);
  });
});
