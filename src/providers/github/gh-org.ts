import { log } from '../../utils/logger.js';
import type { OrgRepoInfo } from '../types.js';
import { ghExec, isGhInstalled, getGitHubToken } from './gh-cli.js';

// ─── GitHub API types ────────────────────────────────────

interface GhRepoApiItem {
  clone_url: string;
  full_name: string;
  name: string;
  description: string | null;
  language: string | null;
  archived: boolean;
  stargazers_count: number;
  pushed_at: string | null;
}

// ─── 分页辅助 ─────────────────────────────────────────────

/**
 * 通过 gh api 调用指定分页 URL 并返回解析后的数组。
 *
 * @param endpoint  相对 API 路径（不含 base URL 前缀）
 * @returns         解析后的 JSON 数组，失败抛出 Error
 */
function ghApiPage(endpoint: string): GhRepoApiItem[] {
  const result = ghExec([
    'api',
    '-H', 'Accept: application/vnd.github+json',
    endpoint,
  ]);
  if (result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as GhRepoApiItem[];
}

/**
 * 通过 GITHUB_TOKEN 直接调用 GitHub REST API 分页。
 *
 * @param url    完整 API URL
 * @param token  GitHub personal access token
 */
async function fetchApiPage(url: string, token: string): Promise<GhRepoApiItem[]> {
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub API error ${resp.status}: ${body}`);
  }
  return (await resp.json()) as GhRepoApiItem[];
}

// ─── 转换函数 ─────────────────────────────────────────────

/**
 * 将 GitHub API 返回的仓库对象映射为 OrgRepoInfo。
 */
function mapToOrgRepoInfo(item: GhRepoApiItem): OrgRepoInfo {
  return {
    url: item.clone_url,
    fullName: item.full_name,
    name: item.name,
    description: item.description ?? undefined,
    primaryLanguage: item.language ?? undefined,
    archived: item.archived,
    stars: item.stargazers_count,
    pushedAt: item.pushed_at ?? undefined,
  };
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 列出 GitHub org（或用户）下的所有仓库。
 *
 * 优先使用 gh CLI（`gh api /orgs/<org>/repos`），若无 gh CLI 则通过
 * GITHUB_TOKEN 直接调用 REST API。org 不存在时 fallback 到
 * `/users/<org>/repos`（用于用户账号）。
 *
 * 默认过滤掉 archived 仓库；分页拉取直至 maxRepos 上限。
 *
 * @param org      org 或用户名（裸名，不含 URL 前缀）
 * @param opts.maxRepos  最多返回的仓库数，默认 200
 * @returns        OrgRepoInfo 列表
 * @throws         API 调用失败且无法 fallback 时抛出 Error
 */
export async function ghListOrgRepos(
  org: string,
  opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
  const maxRepos = opts?.maxRepos ?? 200;
  const perPage = 100;
  const results: OrgRepoInfo[] = [];

  if (isGhInstalled()) {
    // 使用 gh CLI 分页拉取
    const tryEndpointPrefix = async (prefix: string): Promise<boolean> => {
      let page = 1;
      while (results.length < maxRepos) {
        const endpoint = `${prefix}?per_page=${perPage}&type=public&page=${page}`;
        let items: GhRepoApiItem[];
        try {
          items = ghApiPage(endpoint);
        } catch (err) {
          if (page === 1) {
            // 第一页失败，说明此 endpoint 不通
            log.debug(`gh api ${prefix} failed: ${String(err)}`);
            return false;
          }
          throw err;
        }
        if (items.length === 0) break;
        results.push(...items.map(mapToOrgRepoInfo));
        if (items.length < perPage) break;
        page++;
      }
      return true;
    };

    const orgSuccess = await tryEndpointPrefix(`/orgs/${encodeURIComponent(org)}/repos`);
    if (!orgSuccess) {
      // fallback: user repos
      await tryEndpointPrefix(`/users/${encodeURIComponent(org)}/repos`);
    }
  } else {
    // 使用 GITHUB_TOKEN 直接调用 REST API
    const token = getGitHubToken();
    if (!token) {
      throw new Error(
        'GitHub authentication unavailable: gh CLI not found and GITHUB_TOKEN not set.',
      );
    }

    const BASE = 'https://api.github.com';
    const tryUrl = async (urlPrefix: string): Promise<boolean> => {
      let page = 1;
      while (results.length < maxRepos) {
        const url = `${urlPrefix}?per_page=${perPage}&type=public&page=${page}`;
        let items: GhRepoApiItem[];
        try {
          items = await fetchApiPage(url, token);
        } catch (err) {
          if (page === 1) {
            log.debug(`fetch ${urlPrefix} failed: ${String(err)}`);
            return false;
          }
          throw err;
        }
        if (items.length === 0) break;
        results.push(...items.map(mapToOrgRepoInfo));
        if (items.length < perPage) break;
        page++;
      }
      return true;
    };

    const orgSuccess = await tryUrl(`${BASE}/orgs/${encodeURIComponent(org)}/repos`);
    if (!orgSuccess) {
      await tryUrl(`${BASE}/users/${encodeURIComponent(org)}/repos`);
    }
  }

  return results.slice(0, maxRepos);
}
