import type { OrgRepoInfo } from '../types.js';
import { gfGetOAuthToken } from './gf-cli.js';
import { log } from '../../utils/logger.js';

const TGIT_API_BASE = 'https://git.woa.com/api/v3';
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_REPOS = 200;
// 响应体最大 50 MB，防止恶意服务器返回超大响应导致 OOM
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

interface TgitProjectApiItem {
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

/**
 * 将工蜂 API 返回的 project 条目映射为 OrgRepoInfo。
 *
 * primaryLanguage 在列 projects 接口不直接返回，P6.0 留空。
 */
function mapItem(item: TgitProjectApiItem): OrgRepoInfo {
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
 * 列出工蜂 group / 子 group 下的所有 projects（轻量元信息）。
 *
 * 实现：复用 gfGetOAuthToken 取 token，调用工蜂 GitLab 风格 API：
 *   GET /api/v3/groups/<encoded-path>/projects?per_page=100&page=N
 *
 * 分页直到响应数组长度 < per_page 或累计达到 maxRepos。
 *
 * @param group   组路径（如 "team-org" / "team/sub-group"）
 * @param opts.maxRepos  上限，默认 200
 * @throws Error
 *   - 缺 token：`Error('TGit token unavailable: ...')`
 *   - group 不存在 / 无权限：`Error('TGit group <path> not found or no access')`
 *   - 其他 HTTP 错误：`Error('TGit API HTTP <code>: <text>')`
 */
export async function gfListOrgRepos(
    group: string,
    opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
    const token = gfGetOAuthToken();
    if (!token) {
        throw new Error(
            'TGit token unavailable: configure ~/.netrc for git.woa.com or set TAI_PAT_TOKEN',
        );
    }

    const maxRepos = opts?.maxRepos ?? DEFAULT_MAX_REPOS;
    const perPage = DEFAULT_PER_PAGE;
    const encodedGroup = encodeURIComponent(group);

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
    };

    const collected: OrgRepoInfo[] = [];

    // 策略 1: 尝试 /groups/<id>/projects 分页接口（标准 GitLab API）
    let useProjectsEndpoint = true;
    let page = 1;

    while (useProjectsEndpoint && collected.length < maxRepos) {
        const url = `${TGIT_API_BASE}/groups/${encodedGroup}/projects?per_page=${perPage}&page=${page}`;
        const resp = await fetch(url, { headers, redirect: 'manual' });

        if (resp.status >= 300 && resp.status < 400) {
            throw new Error(`Unexpected redirect from TGit API: ${resp.status}`);
        }
        if (resp.status === 404) {
            // 工蜂部分版本不支持 /groups/<id>/projects，fallback 到策略 2
            useProjectsEndpoint = false;
            break;
        }
        if (!resp.ok) {
            throw new Error(`TGit API HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
        }

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
                    throw new Error(`TGit API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
                }
                chunks.push(value);
            }
        }
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        const items = JSON.parse(bodyText) as TgitProjectApiItem[];
        if (!Array.isArray(items) || items.length === 0) break;

        for (const item of items) {
            collected.push(mapItem(item));
            if (collected.length >= maxRepos) break;
        }

        if (items.length < perPage) break;
        page++;
    }

    // 策略 2: 从 /groups/<id> 响应中提取内嵌 projects 数组（工蜂兼容）
    if (!useProjectsEndpoint && collected.length === 0) {
        const url = `${TGIT_API_BASE}/groups/${encodedGroup}`;
        const resp = await fetch(url, { headers, redirect: 'manual' });

        if (resp.status >= 300 && resp.status < 400) {
            throw new Error(`Unexpected redirect from TGit API: ${resp.status}`);
        }
        if (resp.status === 404) {
            throw new Error(`TGit group ${group} not found or no access`);
        }
        if (!resp.ok) {
            throw new Error(`TGit API HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
        }

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
                    throw new Error(`TGit API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
                }
                chunks.push(value);
            }
        }
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        const groupData = JSON.parse(bodyText) as { projects?: TgitProjectApiItem[] };

        if (groupData.projects && Array.isArray(groupData.projects)) {
            for (const item of groupData.projects) {
                collected.push(mapItem(item));
                if (collected.length >= maxRepos) break;
            }
        } else {
            throw new Error(`TGit group ${group} not found or no access`);
        }
    }

    log.debug(`gfListOrgRepos: ${group} 共 ${collected.length} 项`);
    return collected;
}
