import { execSync } from 'node:child_process';
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

/**
 * 通过 gh CLI 获取 GitHub PR 的完整数据。
 *
 * 依次执行：
 *   1. `gh pr view` 获取元信息与提交列表
 *   2. `gh pr diff`  获取 diff 内容（截断至 50KB）
 *
 * @param url - GitHub PR 完整 web URL，例如 https://github.com/owner/repo/pull/123
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法或 gh CLI 调用失败时
 */
export async function fetchGitHubPR(url: string): Promise<MRData> {
  const { owner, repo, number } = parseGitHubPRUrl(url);
  const repoArg = `${owner}/${repo}`;

  log.debug(`fetchGitHubPR: ${repoArg}#${number}`);

  // ── 1. 获取元信息与提交列表 ───────────────────────────────
  let prView: GhPRView;
  try {
    const viewOutput = execSync(
      `gh pr view ${number} --repo ${repoArg} --json title,body,author,mergedAt,commits`,
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
    );
    prView = JSON.parse(viewOutput) as GhPRView;
  } catch (err) {
    throw new Error(`Failed to fetch GitHub PR: ${(err as Error).message}`);
  }

  // ── 2. 获取 diff ─────────────────────────────────────────
  let diff: string;
  try {
    const rawDiff = execSync(
      `gh pr diff ${number} --repo ${repoArg}`,
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
    );
    // 截断至约 50KB（50000 字符）
    diff = rawDiff.slice(0, 50000);
  } catch (err) {
    throw new Error(`Failed to fetch GitHub PR: ${(err as Error).message}`);
  }

  // ── 3. 组装结果 ──────────────────────────────────────────
  return {
    title: prView.title,
    description: prView.body ?? '',
    author: prView.author?.login,
    mergedAt: prView.mergedAt ?? undefined,
    commits: (prView.commits ?? []).map((c) => ({
      hash: c.oid,
      message: c.messageHeadline,
    })),
    diff,
    url,
  };
}
