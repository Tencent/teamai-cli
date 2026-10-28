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

// One deadline shared by the gh path and the REST path: the same org must not
// get a different wait depending on whether gh happens to be installed.
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether an error is a request deadline.
 *
 * The REST path gets a `DOMException` named `TimeoutError` from
 * `AbortSignal.timeout()`, and `ghApiPage` throws an `Error` with the same
 * name. Both transports have to recognise that name, so a deadline sends
 * exactly one request and does not fall back to /users.
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** Build an error named like the one `AbortSignal.timeout()` produces. */
function timeoutError(what: string): Error {
  const err = new Error(`${what} timed out after ${REQUEST_TIMEOUT_MS} ms`);
  err.name = 'TimeoutError';
  return err;
}

/**
 * Call one paginated URL through `gh api` and return the parsed array.
 *
 * `gh` has no deadline of its own: without `timeoutMs`, `spawnSync` waits
 * forever, and `gh` does not exit by itself behind a DNS blackhole or a stalled
 * proxy. Each call therefore gets a deadline, and the kill is translated into a
 * recognisable timeout error — otherwise the caller only sees a non-zero exit
 * with empty stderr, which is indistinguishable from `gh` failing silently.
 *
 * @param endpoint  Relative API path (without the base URL prefix)
 * @returns         Parsed JSON array; throws on failure
 */
function ghApiPage(endpoint: string): GhRepoApiItem[] {
  const result = ghExec(
    [
      'api',
      '-H', 'Accept: application/vnd.github+json',
      endpoint,
    ],
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  if (result.timedOut) {
    throw timeoutError(`gh api ${endpoint}`);
  }
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
// 响应体最大 50 MB，防止恶意服务器返回超大响应导致 OOM
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

async function fetchApiPage(url: string, token: string): Promise<GhRepoApiItem[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // redirect: 'manual' 防止跟随重定向到内网地址（SSRF）
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal,
  });
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error(`Unexpected redirect from GitHub API: ${resp.status}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (signal.aborted) throw signal.reason;
    throw new Error(`GitHub API error ${resp.status}: ${body}`);
  }

  // 流式读取响应体，限制最大 50 MB 防止 OOM
  const reader = resp.body?.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        throw signal.aborted ? signal.reason : err;
      });
      if (done) break;
      received += value.length;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`GitHub API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(body) as GhRepoApiItem[];
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
  opts?: { maxRepos?: number; apiBaseUrl?: string },
): Promise<OrgRepoInfo[]> {
  const maxRepos = opts?.maxRepos ?? 200;
  const perPage = 100;
  const results: OrgRepoInfo[] = [];

  if (!opts?.apiBaseUrl && isGhInstalled()) {
    // 使用 gh CLI 分页拉取
    const tryEndpointPrefix = async (prefix: string, allowFallback = false): Promise<boolean> => {
      let page = 1;
      while (results.length < maxRepos) {
        // 不加 type=public，依赖调用者认证（gh CLI）可见范围；GitHub API 默认 type=all
        const endpoint = `${prefix}?per_page=${perPage}&page=${page}`;
        let items: GhRepoApiItem[];
        try {
          items = ghApiPage(endpoint);
        } catch (err) {
          // A deadline must not fall back: the second endpoint stalls in exactly
          // the same way, turning one 30 s wait into two.
          if (page === 1 && allowFallback && !isTimeoutError(err)) {
            log.debug(`gh api ${prefix} failed: ${String(err)}`);
            return false;
          }
          throw err;
        }
        // 第一页空视为 endpoint 不通（触发 fallback），而非"仓库为零"
        if (items.length === 0 && page === 1) return false;
        if (items.length === 0) break;
        results.push(...items.map(mapToOrgRepoInfo));
        if (items.length < perPage) break;
        page++;
      }
      return true;
    };

    const orgSuccess = await tryEndpointPrefix(`/orgs/${encodeURIComponent(org)}/repos`, true);
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

    const BASE = opts?.apiBaseUrl ?? 'https://api.github.com';
    const tryUrl = async (urlPrefix: string, allowFallback = false): Promise<boolean> => {
      let page = 1;
      while (results.length < maxRepos) {
        // 不加 type=public，依赖 GITHUB_TOKEN 可见范围；GitHub API 默认 type=all
        const url = `${urlPrefix}?per_page=${perPage}&page=${page}`;
        let items: GhRepoApiItem[];
        try {
          items = await fetchApiPage(url, token);
        } catch (err) {
          if (page === 1 && allowFallback && !isTimeoutError(err)) {
            log.debug(`fetch ${urlPrefix} failed: ${String(err)}`);
            return false;
          }
          throw err;
        }
        // 第一页空视为 endpoint 不通（触发 fallback），而非"仓库为零"
        if (items.length === 0 && page === 1) return false;
        if (items.length === 0) break;
        results.push(...items.map(mapToOrgRepoInfo));
        if (items.length < perPage) break;
        page++;
      }
      return true;
    };

    const orgSuccess = await tryUrl(`${BASE}/orgs/${encodeURIComponent(org)}/repos`, true);
    if (!orgSuccess) {
      await tryUrl(`${BASE}/users/${encodeURIComponent(org)}/repos`);
    }
  }

  return results.slice(0, maxRepos);
}
