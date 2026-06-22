import { execSync } from 'node:child_process';
import https from 'node:https';

import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';

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

/** gh pr view 返回的提交结构 */
interface GhCommit {
  oid: string;
  messageHeadline: string;
}

/** gh pr view 返回的 JSON 结构（仅使用的字段） */
interface GhPRView {
  title: string;
  body: string;
  author: { login: string };
  mergedAt: string | null;
  commits: GhCommit[];
}

/** GitHub REST API PR 响应（仅使用的字段） */
interface GitHubApiPR {
  title: string;
  body: string | null;
  merged_at: string | null;
  user: { login: string };
}

/** GitHub REST API Commit 响应（仅使用的字段） */
interface GitHubApiCommit {
  sha: string;
  commit: { message: string };
}

/**
 * 通过 Node.js 内置 https 模块调用 GitHub REST API。
 *
 * 支持公开仓库无需 token；如有 GITHUB_TOKEN 环境变量则自动携带以提高限流上限。
 */
async function githubApiGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const token = process.env['GITHUB_TOKEN'];
    const headers: Record<string, string> = {
      'User-Agent': 'teamai-cli',
      'Accept': 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(
      { hostname: 'api.github.com', path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
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

/**
 * 通过 GitHub REST API 获取 PR 数据（gh CLI 不可用时的回退路径）。
 */
async function fetchGitHubPRViaApi(owner: string, repo: string, number: string): Promise<MRData> {
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  log.debug(`fetchGitHubPR fallback: REST API ${owner}/${repo}#${number}`);

  // ── 1. PR 元信息 ──────────────────────────────────────────
  const pr = await githubApiGet(`/repos/${owner}/${repo}/pulls/${number}`) as GitHubApiPR;

  // ── 2. 提交列表 ──────────────────────────────────────────
  const commitsRaw = await githubApiGet(
    `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=50`,
  ) as GitHubApiCommit[];
  const commits = commitsRaw.map((c) => ({
    hash: c.sha,
    message: c.commit.message.split('\n')[0],
  }));

  // ── 3. diff（Accept: application/vnd.github.v3.diff） ────
  const diff = await new Promise<string>((resolve, reject) => {
    const token = process.env['GITHUB_TOKEN'];
    const headers: Record<string, string> = {
      'User-Agent': 'teamai-cli',
      'Accept': 'application/vnd.github.v3.diff',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(
      { hostname: 'api.github.com', path: `/repos/${owner}/${repo}/pulls/${number}`, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').slice(0, 50000)));
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
 * @param url - GitHub PR 完整 web URL，例如 https://github.com/owner/repo/pull/123
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法或两种方式均失败时
 */
export async function fetchGitHubPR(url: string): Promise<MRData> {
  const { owner, repo, number } = parseGitHubPRUrl(url);
  const repoArg = `${owner}/${repo}`;

  log.debug(`fetchGitHubPR: ${repoArg}#${number}`);

  // ── 优先尝试 gh CLI ──────────────────────────────────────
  try {
    const viewOutput = execSync(
      `gh pr view ${number} --repo ${repoArg} --json title,body,author,mergedAt,commits`,
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
    );
    const prView = JSON.parse(viewOutput) as GhPRView;

    const rawDiff = execSync(
      `gh pr diff ${number} --repo ${repoArg}`,
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
    );

    return {
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
  } catch {
    // gh CLI 不可用或失败，回退到 REST API
    log.debug('gh CLI unavailable, falling back to GitHub REST API');
  }

  // ── 回退：GitHub REST API ────────────────────────────────
  return fetchGitHubPRViaApi(owner, repo, number);
}


/** GitHub PR URL 解析结果 */
interface ParsedGitHubPR {
  owner: string;
  repo: string;
  number: string;
}

