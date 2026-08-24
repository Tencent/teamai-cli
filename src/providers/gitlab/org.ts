import type { OrgRepoInfo } from '../types.js';
import { getGitLabToken, gitlabBaseUrl } from './gitlab-api.js';

/** 响应体最大 50 MB，防止恶意服务器返回超大响应导致 OOM */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_REPOS = 200;

interface GitLabProjectApiItem {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string | null;
  http_url_to_repo: string;
  default_branch?: string | null;
  archived?: boolean;
  last_activity_at?: string;
  star_count?: number;
}

/** 将 GitLab API 返回的 project 条目映射为 OrgRepoInfo。 */
function mapItem(item: GitLabProjectApiItem): OrgRepoInfo {
  return {
    url: item.http_url_to_repo,
    fullName: item.path_with_namespace,
    name: item.name,
    description: item.description ?? undefined,
    primaryLanguage: undefined,
    archived: item.archived ?? false,
    stars: item.star_count,
    pushedAt: item.last_activity_at,
  };
}

/**
 * 列出 GitLab group / subgroup 下的所有 projects（轻量元信息）。
 *
 * 实现：调用 GitLab REST API：
 *   GET /api/v4/groups/<encoded-path>/projects?per_page=100&page=N
 *
 * 分页直到响应数组长度 < per_page 或累计达到 maxRepos。
 *
 * @param group   组路径（如 "team-org" / "team/sub-group"）
 * @param opts.maxRepos  上限，默认 200
 * @throws Error
 *   - 缺 token：`Error('GitLab token unavailable: ...')`
 *   - group 不存在 / 无权限：`Error('GitLab group <path> not found or no access')`
 *   - 其他 HTTP 错误：`Error('GitLab API HTTP <code>: <text>')`
 */
export async function gitlabListOrgRepos(
  group: string,
  opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
  const token = getGitLabToken();
  if (!token) {
    throw new Error('GitLab token unavailable: set GITLAB_TOKEN (or GITLAB_PRIVATE_TOKEN / GITLAB_PAT).');
  }

  const maxRepos = opts?.maxRepos ?? DEFAULT_MAX_REPOS;
  const perPage = DEFAULT_PER_PAGE;
  const encodedGroup = encodeURIComponent(group);
  const headers = { 'PRIVATE-TOKEN': token, 'Accept': 'application/json' };

  const collected: OrgRepoInfo[] = [];
  let page = 1;

  while (collected.length < maxRepos) {
    // include_subgroups=true — GitLab defaults it to false, which would silently
    // drop every project nested under a subgroup of the requested group.
    const url = `${gitlabBaseUrl()}/api/v4/groups/${encodedGroup}/projects`
      + `?per_page=${perPage}&page=${page}&include_subgroups=true`;
    const resp = await fetch(url, { headers, redirect: 'manual' });

    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`Unexpected redirect from GitLab API: ${resp.status}`);
    }
    if (resp.status === 404) {
      throw new Error(`GitLab group ${group} not found or no access`);
    }
    if (!resp.ok) {
      throw new Error(`GitLab API HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    // 流式读取响应体，限制最大 50 MB 防止 OOM
    const reader = resp.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(`GitLab API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    const bodyText = Buffer.concat(chunks).toString('utf-8').trim();
    if (!bodyText) break;
    let items: GitLabProjectApiItem[];
    try {
      items = JSON.parse(bodyText) as GitLabProjectApiItem[];
    } catch {
      throw new Error(`GitLab API returned a malformed project list for group ${group}`);
    }
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      collected.push(mapItem(item));
      if (collected.length >= maxRepos) break;
    }

    if (items.length < perPage) break;
    page++;
  }

  return collected;
}
