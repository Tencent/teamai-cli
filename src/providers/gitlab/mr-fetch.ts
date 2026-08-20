import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { gitlabFetch } from './rest-auth.js';

/** GitLab MR URL parse result */
interface ParsedGitLabMR {
  /** Project full path, e.g. `group/subgroup/repo` */
  projectPath: string;
  /** MR internal id (iid) */
  mrIid: string;
}

/**
 * Parse a GitLab MR URL into project full path + MR iid.
 *
 * Supported: `https://<host>/<group>/<repo>/-/merge_requests/<iid>`
 * GitLab prefixes project sub-paths with `/-/`; older/short forms without the
 * `/-/` separator are also accepted. The group portion may be nested.
 * Throws on parse failure.
 */
export function parseGitLabMRUrl(url: string): ParsedGitLabMR {
  // Modern GitLab: .../<path>/-/merge_requests/<iid>
  const dashMatch = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (dashMatch) {
    return { projectPath: dashMatch[1], mrIid: dashMatch[2] };
  }
  // Fallback without the /-/ separator
  const plainMatch = url.match(/^https?:\/\/[^/]+\/(.+?)\/merge_requests\/(\d+)/);
  if (plainMatch) {
    return { projectPath: plainMatch[1], mrIid: plainMatch[2] };
  }
  throw new Error(`Invalid GitLab MR URL: ${url}`);
}

/** GitLab REST API MR metadata (used fields only) */
interface GitLabMR {
  iid: number;
  title: string;
  description: string | null;
  author: { username: string };
  merged_at?: string | null;
  updated_at?: string | null;
}

/** GitLab REST API commit item (used fields only) */
interface GitLabCommit {
  id: string;
  title: string;
}

/** /changes payload */
interface GitLabChangesResponse {
  changes?: Array<{ diff: string }>;
}

/**
 * Fetch full MR data via the GitLab REST API (`<host>/api/v4`).
 *
 *   1. GET /projects/{enc}/merge_requests/{iid}          → metadata
 *   2. GET /projects/{enc}/merge_requests/{iid}/commits  → commit list
 *   3. GET /projects/{enc}/merge_requests/{iid}/changes  → diff (best-effort)
 *
 * Auth and scheme fallback are handled by gitlabFetch.
 *
 * @param url - GitLab MR web URL, e.g. https://gitlab.com/group/repo/-/merge_requests/42
 * @throws Error when the URL is malformed or the metadata call fails
 */
export async function fetchGitLabMR(url: string): Promise<MRData> {
  const { projectPath, mrIid } = parseGitLabMRUrl(url);
  const enc = encodeURIComponent(projectPath);
  log.debug(`fetchGitLabMR: ${projectPath}!${mrIid}`);

  // ── 1. metadata ────────────────────────────────────────
  const resp = await gitlabFetch(`/projects/${enc}/merge_requests/${mrIid}`);
  if (!resp.ok) {
    throw new Error(`GitLab API error ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const mr = (await resp.json()) as GitLabMR;

  // ── 2. commits (best-effort) ───────────────────────────
  let commits: Array<{ hash: string; message: string }> = [];
  try {
    const commitsResp = await gitlabFetch(
      `/projects/${enc}/merge_requests/${mrIid}/commits?per_page=50`,
    );
    if (commitsResp.ok) {
      const raw = (await commitsResp.json()) as GitLabCommit[];
      commits = raw.map((c) => ({ hash: c.id, message: c.title }));
    }
  } catch (err) {
    log.debug(`GitLab MR commits fetch failed: ${(err as Error).message}`);
  }

  // ── 3. diff (best-effort, truncated to 50KB) ───────────
  let diff = '';
  try {
    const diffResp = await gitlabFetch(`/projects/${enc}/merge_requests/${mrIid}/changes`);
    if (diffResp.ok) {
      const diffData = (await diffResp.json()) as GitLabChangesResponse;
      const fileDiffs = diffData.changes ?? [];
      diff = fileDiffs.map((c) => c.diff).join('\n').slice(0, 50000);
    } else {
      log.debug(`GitLab MR diff fetch failed (${diffResp.status}); diff will be empty`);
    }
  } catch (err) {
    log.debug(`GitLab MR diff fetch error; diff will be empty: ${(err as Error).message}`);
  }

  return {
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author?.username,
    mergedAt: mr.merged_at ?? mr.updated_at ?? undefined,
    commits,
    diff,
    url,
  };
}
