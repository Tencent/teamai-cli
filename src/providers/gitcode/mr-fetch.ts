import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { getGitCodeToken, gitcodeApiBase } from './gitcode-api.js';
import { GITCODE_HOST } from './repo-url.js';

/** GitCode PR URL 解析结果 */
interface ParsedGitCodePR {
  owner: string;
  repo: string;
  number: string;
}

/**
 * 从 GitCode PR URL 解析出 owner / repo / PR number。
 *
 * 支持 Gitee 风格 URL：https://gitcode.com/<owner>/<repo>/(pull|pulls|merge_requests)/<number>
 * host 必须为 gitcode.com——避免把 token 发往任意 host（SSRF / 凭据外泄）。
 * 解析失败时抛出 Error。
 */
function parseGitCodePRUrl(url: string): ParsedGitCodePR {
  const match = url.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull|pulls|merge_requests)\/(\d+)/i,
  );
  if (!match) {
    throw new Error(`Invalid GitCode PR URL: ${url}`);
  }
  const host = match[1].toLowerCase().replace(/^www\./, '');
  if (host !== GITCODE_HOST) {
    throw new Error(
      `Refusing to fetch GitCode PR from "${match[1]}": only ${GITCODE_HOST} is supported.`,
    );
  }
  return { owner: match[2], repo: match[3], number: match[4] };
}

/** GitCode REST API 返回的 PR 元信息（仅使用的字段） */
interface GitCodePR {
  title: string;
  body: string | null;
  user: { login: string };
  merged_at?: string | null;
}

/** GitCode REST API 返回的 commit（仅使用的字段） */
interface GitCodeCommit {
  sha: string;
  commit?: { message?: string };
}

function authHeaders(token: string): Record<string, string> {
  return { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
}

/**
 * 通过 GitCode REST API（api.gitcode.com/api/v5）获取 PR 的完整数据。
 *
 *   1. GET /repos/{o}/{r}/pulls/{n}                 元信息
 *   2. GET /repos/{o}/{r}/pulls/{n}/commits         提交列表（失败非致命）
 *   3. GET /repos/{o}/{r}/pulls/{n}/files           diff（截断 50KB，失败非致命）
 *
 * @param url - GitCode PR 完整 web URL
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 非法、未配置 token 或元信息调用失败时
 */
export async function fetchGitCodeMR(url: string): Promise<MRData> {
  const { owner, repo, number } = parseGitCodePRUrl(url);
  const token = getGitCodeToken();
  if (!token) {
    throw new Error('GITCODE_TOKEN is not set.');
  }

  const base = `${gitcodeApiBase()}/repos/${owner}/${repo}/pulls/${number}`;
  const headers = authHeaders(token);
  log.debug(`fetchGitCodeMR: ${owner}/${repo}#${number}`);

  // ── 1. 元信息 ─────────────────────────────────────────────
  const resp = await fetch(base, { headers, redirect: 'manual' });
  if (!resp.ok) {
    throw new Error(`GitCode API error ${resp.status}: ${await resp.text()}`);
  }
  const pr = (await resp.json()) as GitCodePR;

  // ── 2. 提交列表（失败非致命） ─────────────────────────────
  let commits: Array<{ hash: string; message: string }> = [];
  try {
    const commitsResp = await fetch(`${base}/commits?per_page=50`, { headers, redirect: 'manual' });
    if (commitsResp.ok) {
      const raw = (await commitsResp.json()) as GitCodeCommit[];
      commits = raw.map((c) => ({
        hash: c.sha,
        message: (c.commit?.message ?? '').split('\n')[0],
      }));
    }
  } catch (err) {
    log.debug(`GitCode PR commits 获取异常，commits 将为空：${(err as Error).message}`);
  }

  // ── 3. diff（截断 50KB，失败非致命） ──────────────────────
  let diff = '';
  try {
    const filesResp = await fetch(`${base}/files`, { headers, redirect: 'manual' });
    if (filesResp.ok) {
      const files = (await filesResp.json()) as Array<{ patch?: string; diff?: string }>;
      diff = files
        .map((f) => f.patch ?? f.diff ?? '')
        .filter(Boolean)
        .join('\n')
        .slice(0, 50000);
    } else {
      log.debug(`GitCode PR diff 获取失败（${filesResp.status}），diff 将为空`);
    }
  } catch (err) {
    log.debug(`GitCode PR diff 获取异常，diff 将为空：${(err as Error).message}`);
  }

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
