import type { OrgRepoInfo } from '../types.js';
import { getGitCodeToken, gitcodeApiBase } from './gitcode-api.js';
import { GITCODE_HOST } from './repo-url.js';

const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_REPOS = 200;

/** GitCode API 返回的 repo 条目（仅使用的字段）。 */
interface GitCodeRepoApiItem {
  name: string;
  full_name: string;
  path?: string;
  description?: string | null;
  html_url?: string;
  archived?: boolean;
  updated_at?: string;
  stargazers_count?: number;
}

function mapItem(item: GitCodeRepoApiItem): OrgRepoInfo {
  const fullName = item.full_name;
  return {
    url: item.html_url ?? `https://${GITCODE_HOST}/${fullName}.git`,
    fullName,
    name: item.name,
    description: item.description ?? undefined,
    primaryLanguage: undefined,
    archived: item.archived ?? false,
    stars: item.stargazers_count,
    pushedAt: item.updated_at,
  };
}

/**
 * 列出 GitCode 组织下的所有仓库（轻量元信息）。
 *
 * 实现：GET /api/v5/orgs/<org>/repos?per_page=100&page=N，分页至数组长度 < per_page
 * 或累计达到 maxRepos。
 *
 * @param org   组织名
 * @param opts.maxRepos  上限，默认 200
 * @throws Error 缺 token / org 不存在 / 其他 HTTP 错误
 */
export async function gitcodeListOrgRepos(
  org: string,
  opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
  const token = getGitCodeToken();
  if (!token) {
    throw new Error('GitCode token unavailable: set GITCODE_TOKEN (or GC_TOKEN).');
  }

  const maxRepos = opts?.maxRepos ?? DEFAULT_MAX_REPOS;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  const collected: OrgRepoInfo[] = [];
  let page = 1;

  while (collected.length < maxRepos) {
    const url = `${gitcodeApiBase()}/orgs/${encodeURIComponent(org)}/repos`
      + `?per_page=${DEFAULT_PER_PAGE}&page=${page}`;
    const resp = await fetch(url, { headers, redirect: 'manual' });

    if (resp.status === 404) {
      throw new Error(`GitCode org ${org} not found or no access`);
    }
    if (!resp.ok) {
      throw new Error(`GitCode API HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    const items = (await resp.json()) as GitCodeRepoApiItem[];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      collected.push(mapItem(item));
      if (collected.length >= maxRepos) break;
    }

    if (items.length < DEFAULT_PER_PAGE) break;
    page++;
  }

  return collected;
}
