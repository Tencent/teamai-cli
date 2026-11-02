import type { OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';

import { z } from 'zod';

import { type JsonValue, type MRData, type MRFetchOptions, type MRThread } from '../../types.js';
import { log } from '../../utils/logger.js';
import { pruneThreads } from '../mr-threads.js';
import { ghExec } from './gh-cli.js';

/** GitHub PR URL 解析结果 */
interface ParsedGitHubPR {
  owner: string;
  repo: string;
  number: string;
}

/**
 * 从 GitHub PR URL 解析出 owner / repo / PR number。
 *
 * 支持格式：https://github.com/<owner>/<repo>/pull/<number>
 * 解析失败时抛出 Error。
 */
function parseGitHubPRUrl(url: string): ParsedGitHubPR {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

  if (!match) {
    throw new Error(`Invalid GitHub PR URL: ${url}`);
  }

  return { owner: match[1], repo: match[2], number: match[3] };
}

const GitHubUserSchema = z.object({ login: z.string() });

/** gh pr view 返回的 JSON 结构（仅使用的字段） */
const GhPRViewSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  author: GitHubUserSchema.nullish(),
  mergedAt: z.string().nullish(),
  commits: z.array(z.object({ oid: z.string(), messageHeadline: z.string() })).nullish(),
});

/** GitHub REST API PR 响应（仅使用的字段） */
const GitHubApiPRSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  merged_at: z.string().nullish(),
  user: GitHubUserSchema.nullish(),
});

/** GitHub REST API Commit 响应（仅使用的字段） */
const GitHubApiCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({ message: z.string() }),
});

/**
 * 通过 Node.js 内置 https 模块调用 GitHub REST API。
 *
 * 支持公开仓库无需 token；如有 GITHUB_TOKEN 环境变量则自动携带以提高限流上限。
 */
async function githubApiGet(path: string): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const token = process.env['GITHUB_TOKEN'];

    const headers: OutgoingHttpHeaders = {
      'User-Agent': 'teamai-cli',
      'Accept': 'application/vnd.github+json',
    };

    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(
      { hostname: 'api.github.com', path, headers },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub API error ${res.statusCode}: ${body}`));

            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    req.end();
  });
}

/** Reads one API path as JSON: through `gh api` or the REST client. */
type ApiGet = (path: string) => Promise<JsonValue>;

/** `gh api <path>`: the same paths as the REST client, with gh's credentials. */
async function ghApiGet(path: string): Promise<JsonValue> {
  const result = ghExec(['api', path.replace(/^\//, '')]);

  if (result.status !== 0) {
    throw new Error(`gh api error ${result.status}: ${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

/** A `/pulls/:n/comments` entry (the fields read). */
const GitHubReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  path: z.string().nullish(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  /** The thread's first comment, on a reply. */
  in_reply_to_id: z.number().nullish(),
  user: GitHubUserSchema.nullish(),
});

/** A `/pulls/:n/reviews` entry (the fields read). */
const GitHubReviewSchema = z.object({
  body: z.string().nullish(),
  state: z.string().nullish(),
  user: GitHubUserSchema.nullish(),
});

/** A `/issues/:n/comments` entry (the fields read). */
const GitHubIssueCommentSchema = z.object({
  body: z.string().nullish(),
  user: GitHubUserSchema.nullish(),
});

/** Pages of 100 read at most per list endpoint. */
const MAX_LIST_PAGES = 10;

/** Reads every page of a list endpoint, each entry parsed with `entry`. */
async function readPages<Entry extends z.ZodType>(get: ApiGet, path: string, entry: Entry): Promise<z.output<Entry>[]> {
  const all: z.output<Entry>[] = [];

  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const items = await get(`${path}?per_page=100&page=${page}`);

    if (!Array.isArray(items)) {
      throw new Error(`GitHub API returned no list for ${path}`);
    }

    all.push(...z.array(entry).parse(items));

    if (items.length < 100) break;
  }

  return all;
}

/**
 * Reads the PR's review threads (#1187): the diff comments grouped into their
 * threads, each review's summary, and the conversation comments, without
 * teamai's own CI comments. The REST API does not say whether a thread is
 * resolved, so `resolved` stays unset.
 *
 * @throws Error on an API error; the caller keeps the extraction going without threads
 */
async function fetchGitHubThreads(
  get: ApiGet,
  owner: string,
  repo: string,
  number: string,
  commentMarker?: string,
): Promise<MRThread[]> {
  const base = `/repos/${owner}/${repo}`;
  const comments = await readPages(get, `${base}/pulls/${number}/comments`, GitHubReviewCommentSchema);
  const reviews = await readPages(get, `${base}/pulls/${number}/reviews`, GitHubReviewSchema);
  const conversation = await readPages(get, `${base}/issues/${number}/comments`, GitHubIssueCommentSchema);

  const byRoot = new Map<number, MRThread>();

  for (const c of comments) {
    const note = { author: c.user?.login, body: c.body ?? '' };
    const thread = byRoot.get(c.in_reply_to_id ?? c.id);

    if (thread) {
      thread.notes.push(note);
    } else {
      byRoot.set(c.id, { file: c.path ?? undefined, line: c.line ?? c.original_line ?? undefined, notes: [note] });
    }
  }

  const threads = [...byRoot.values()];

  for (const r of reviews) {
    if (!r.body?.trim() || r.state === 'PENDING') continue;
    const verdict = r.state ? `${r.state.toLowerCase().replace(/_/g, ' ')}: ` : '';
    threads.push({ notes: [{ author: r.user?.login, body: `${verdict}${r.body}` }] });
  }

  for (const c of conversation) {
    threads.push({ notes: [{ author: c.user?.login, body: c.body ?? '' }] });
  }

  return pruneThreads(threads, commentMarker);
}

/**
 * 通过 GitHub REST API 获取 PR 数据（gh CLI 不可用时的回退路径）。
 */
async function fetchGitHubPRViaApi(owner: string, repo: string, number: string): Promise<MRData> {
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  log.debug(`fetchGitHubPR fallback: REST API ${owner}/${repo}#${number}`);

  // ── 1. PR 元信息 ──────────────────────────────────────────
  const pr = GitHubApiPRSchema.parse(await githubApiGet(`/repos/${owner}/${repo}/pulls/${number}`));

  // ── 2. 提交列表 ──────────────────────────────────────────
  const commitsRaw = await readPages(githubApiGet, `/repos/${owner}/${repo}/pulls/${number}/commits`, GitHubApiCommitSchema);

  const commits = commitsRaw.map((c) => ({
    hash: c.sha,
    message: c.commit.message.split('\n')[0],
  }));

  // ── 3. diff（Accept: application/vnd.github.v3.diff） ────
  const diff = await new Promise<string>((resolve, reject) => {
    const token = process.env['GITHUB_TOKEN'];

    const headers: OutgoingHttpHeaders = {
      'User-Agent': 'teamai-cli',
      'Accept': 'application/vnd.github.v3.diff',
    };

    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(
      { hostname: 'api.github.com', path: `/repos/${owner}/${repo}/pulls/${number}`, headers },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub API diff error ${res.statusCode}: ${body}`));

            return;
          }

          resolve(body.slice(0, 50000));
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('GitHub API diff timeout')); });
    req.end();
  });

  return {
    title: pr.title,
    description: pr.body ?? '',
    author: pr.user?.login,
    mergedAt: pr.merged_at ?? undefined,
    commits,
    diff,
    url,
  };
}

/**
 * 通过 gh CLI 获取 GitHub PR 的完整数据。
 *
 * gh CLI 不可用时自动回退到 GitHub REST API（支持公开仓库，无需 token）。
 *
 * 评审 threads（diff 评论、review 结论、会话评论）随后通过同一条路径读取，
 * 失败非致命（#1187）。
 *
 * @param url - GitHub PR 完整 web URL，例如 https://github.com/owner/repo/pull/123
 * @param opts - 是否读取评审 threads（默认读取）
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法或两种方式均失败时
 */
export async function fetchGitHubPR(url: string, opts: MRFetchOptions = {}): Promise<MRData> {
  const { owner, repo, number } = parseGitHubPRUrl(url);
  const repoArg = `${owner}/${repo}`;

  log.debug(`fetchGitHubPR: ${repoArg}#${number}`);

  let mr: MRData;
  let get: ApiGet;

  // ── 优先尝试 gh CLI ──────────────────────────────────────
  try {
    const viewResult = ghExec([
      'pr',
      'view',
      number,
      '--repo',
      repoArg,
      '--json',
      'title,body,author,mergedAt,commits',
    ]);

    if (viewResult.status !== 0) {
      throw new Error(`gh pr view failed (${viewResult.status}): ${viewResult.stderr || viewResult.stdout}`);
    }

    const prView = GhPRViewSchema.parse(JSON.parse(viewResult.stdout));

    const diffResult = ghExec(
      ['pr', 'diff', number, '--repo', repoArg],
      { maxBuffer: 50 * 1024 * 1024 },
    );

    if (diffResult.status !== 0) {
      throw new Error(`gh pr diff failed (${diffResult.status}): ${diffResult.stderr || diffResult.stdout}`);
    }

    const rawDiff = diffResult.stdout;

    mr = {
      title: prView.title,
      description: prView.body ?? '',
      author: prView.author?.login,
      mergedAt: prView.mergedAt ?? undefined,
      commits: (prView.commits ?? []).map((c) => ({
        hash: c.oid,
        message: c.messageHeadline,
      })),
      diff: rawDiff.slice(0, 50000),
      url,
    };
    get = ghApiGet;
  } catch {
    // gh CLI 不可用或失败，回退到 REST API
    log.debug('gh CLI unavailable, falling back to GitHub REST API');
    // ── 回退：GitHub REST API ────────────────────────────────
    mr = await fetchGitHubPRViaApi(owner, repo, number);
    get = githubApiGet;
  }

  // ── 评审 threads（失败非致命） ───────────────────────────
  if (opts.discussions !== false) {
    try {
      mr.discussions = await fetchGitHubThreads(get, owner, repo, number, opts.commentMarker);
    } catch (err) {
      log.warn(`Review threads not read (${err instanceof Error ? err.message : String(err)}); the learning is extracted without them`);
    }
  }

  return mr;
}

