import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { getGitLabToken } from './gitlab-api.js';
import { GITLAB_HOST } from './repo-url.js';

/** GitLab MR URL 解析结果 */
interface ParsedGitLabMR {
  /** API base derived from the MR URL's own origin, e.g. https://host/api/v4 */
  apiBase: string;
  projectPath: string;
  mrIid: string;
}

/**
 * 从 GitLab MR URL 解析出 group / project / MR IID。
 *
 * 支持格式：https://<host>/<group>/<project>/-/merge_requests/<id>
 * group 可以是多级路径（如 group/subgroup）。
 * 解析失败时抛出 Error。
 */
function parseGitLabMRUrl(url: string): ParsedGitLabMR {
  const match = url.match(/^(https?):\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/i);
  if (!match) {
    throw new Error(`Invalid GitLab MR URL: ${url}`);
  }
  const scheme = match[1].toLowerCase();
  const host = match[2];
  const projectPath = match[3];
  if (!projectPath.includes('/')) {
    throw new Error(`Invalid GitLab MR URL: ${url}`);
  }
  // Only ever send the token to the *configured* instance. We still derive the
  // API base from the URL's own origin (so a self-hosted instance keeps its
  // scheme/port), but the host component must match GITLAB_HOST — otherwise a
  // hand-crafted MR URL on an attacker-controlled host would receive the PAT
  // (SSRF / credential exfiltration). The host compare is case-insensitive and
  // strips a leading `www.`; ports must match exactly.
  if (!hostMatchesConfigured(host)) {
    throw new Error(
      `Refusing to fetch GitLab MR from "${host}": it does not match the configured ` +
        `GitLab instance "${GITLAB_HOST}". Set GITLAB_URL / TEAMAI_GITLAB_HOST to this ` +
        `instance if it is trusted.`,
    );
  }
  return {
    apiBase: `${scheme}://${host}/api/v4`,
    projectPath,
    mrIid: match[4],
  };
}

/** Normalize a host for comparison: lowercase, drop a leading `www.`. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * True when `urlHost` (host[:port] from an MR URL) refers to the same instance
 * as the configured GITLAB_HOST. GITLAB_HOST may itself carry a port.
 */
function hostMatchesConfigured(urlHost: string): boolean {
  return normalizeHost(urlHost) === normalizeHost(GITLAB_HOST);
}

/** GitLab REST API 返回的 MR 元信息（仅使用的字段） */
interface GitLabMR {
  title: string;
  description: string | null;
  author: { username: string };
  merged_at?: string | null;
}

/** GitLab REST API 返回的 commit（仅使用的字段） */
interface GitLabCommit {
  id: string;
  title: string;
}

/** /changes 接口的 diff 载荷：`changes` 数组，每项含 `diff` 字段 */
interface GitLabChangesResponse {
  changes?: Array<{ diff: string }>;
}

/** 鉴权头（GitLab PAT 用 PRIVATE-TOKEN）。 */
function authHeaders(token: string): Record<string, string> {
  return { 'PRIVATE-TOKEN': token, 'Accept': 'application/json' };
}

/**
 * 通过 GitLab REST API（<host>/api/v4）获取 MR 的完整数据。
 *
 *   1. GET /projects/{enc}/merge_requests/{iid} 获取元信息
 *   2. GET /projects/{enc}/merge_requests/{iid}/commits 获取提交列表
 *   3. GET /projects/{enc}/merge_requests/{iid}/changes 获取 diff
 *      （截断至 50KB，失败非致命）
 *
 * @param url - GitLab MR 完整 web URL，例如
 *   https://gitlab.com/group/repo/-/merge_requests/456
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法、未配置 token 或 API 调用失败时
 */
export async function fetchGitLabMR(url: string): Promise<MRData> {
  const { apiBase, projectPath, mrIid } = parseGitLabMRUrl(url);
  const token = getGitLabToken();
  if (!token) {
    throw new Error('GITLAB_TOKEN is not set.');
  }

  const enc = encodeURIComponent(projectPath);
  const headers = authHeaders(token);
  log.debug(`fetchGitLabMR: ${projectPath}!${mrIid}`);

  // ── 1. 获取元信息 ──────────────────────────────────────────
  const resp = await fetch(`${apiBase}/projects/${enc}/merge_requests/${mrIid}`, {
    headers,
    redirect: 'manual',
  });
  if (!resp.ok) {
    throw new Error(`GitLab API error ${resp.status}: ${await resp.text()}`);
  }
  const mr = (await resp.json()) as GitLabMR;

  // ── 2. 获取提交列表（失败非致命） ──────────────────────────
  let commits: Array<{ hash: string; message: string }> = [];
  try {
    const commitsResp = await fetch(
      `${apiBase}/projects/${enc}/merge_requests/${mrIid}/commits?per_page=50`,
      { headers, redirect: 'manual' },
    );
    if (commitsResp.ok) {
      const raw = (await commitsResp.json()) as GitLabCommit[];
      commits = raw.map((c) => ({ hash: c.id, message: c.title }));
    }
  } catch (err) {
    log.debug(`GitLab MR commits 获取异常，commits 将为空：${(err as Error).message}`);
  }

  // ── 3. 获取 diff（截断至 50KB，失败非致命） ────────────────
  let diff = '';
  try {
    const diffResp = await fetch(
      `${apiBase}/projects/${enc}/merge_requests/${mrIid}/changes`,
      { headers, redirect: 'manual' },
    );
    if (diffResp.ok) {
      const diffData = (await diffResp.json()) as GitLabChangesResponse;
      diff = (diffData.changes ?? []).map((c) => c.diff).join('\n').slice(0, 50000);
    } else {
      log.debug(`GitLab MR diff 获取失败（${diffResp.status}），diff 将为空`);
    }
  } catch (err) {
    log.debug(`GitLab MR diff 获取异常，diff 将为空：${(err as Error).message}`);
  }

  return {
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author?.username,
    mergedAt: mr.merged_at ?? undefined,
    commits,
    diff,
    url,
  };
}
