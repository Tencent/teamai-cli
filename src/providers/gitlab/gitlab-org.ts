import type { OrgRepoInfo } from '../types.js';
import { getGitLabToken, gitlabAuthHeaders, gitlabApiBase } from './rest-auth.js';
import { log } from '../../utils/logger.js';

const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_REPOS = 200;
// Cap the response body at 50 MB to guard against a hostile server OOMing us.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

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

/** Read a fetch response body with a hard size cap. */
async function readCapped(resp: Response): Promise<string> {
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
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * List all projects under a GitLab group (including subgroups).
 *
 * Uses `GET /groups/<encoded-path>/projects?include_subgroups=true`, paginating
 * until a short page or the maxRepos cap is reached.
 *
 * @param group   group full path (e.g. "team-org" / "team/sub-group")
 * @param opts.maxRepos  cap, default 200
 * @throws Error
 *   - missing token → from getGitLabToken()
 *   - group not found / no access → `GitLab group <path> not found or no access`
 *   - other HTTP error → `GitLab API HTTP <code>: <text>`
 */
export async function gitlabListOrgRepos(
  group: string,
  opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
  const { token, scheme } = getGitLabToken();

  const maxRepos = opts?.maxRepos ?? DEFAULT_MAX_REPOS;
  const perPage = DEFAULT_PER_PAGE;
  const encodedGroup = encodeURIComponent(group);
  const apiBase = gitlabApiBase();

  const headers = {
    ...gitlabAuthHeaders(token, scheme),
    Accept: 'application/json',
  };

  const collected: OrgRepoInfo[] = [];
  let page = 1;

  while (collected.length < maxRepos) {
    const url =
      `${apiBase}/groups/${encodedGroup}/projects` +
      `?include_subgroups=true&per_page=${perPage}&page=${page}`;
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

    const bodyText = await readCapped(resp);
    const items = JSON.parse(bodyText) as GitLabProjectApiItem[];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      collected.push(mapItem(item));
      if (collected.length >= maxRepos) break;
    }

    if (items.length < perPage) break;
    page++;
  }

  log.debug(`gitlabListOrgRepos: ${group} → ${collected.length} projects`);
  return collected;
}
