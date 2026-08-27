import { spawnSync } from 'node:child_process';
import { GITLAB_HOST } from './repo-url.js';
import { sanitizeGitUrl } from '../../utils/redact.js';

/**
 * GitLab REST API client (API v4).
 *
 * GitLab (including self-hosted / enterprise instances) has a clean REST API,
 * so unlike the TGit/CNB providers this one needs no external CLI — only a
 * Personal Access Token.
 *
 * Auth follows standard GitLab env-var conventions:
 *   - `GITLAB_URL`: base URL of the instance (default https://gitlab.com)
 *   - `GITLAB_TOKEN` (primary), `GITLAB_PRIVATE_TOKEN`, `GITLAB_PAT` (aliases)
 *
 * The token is sent via the `PRIVATE-TOKEN` header (GitLab PAT scheme).
 */

// ─── Config ──────────────────────────────────────────────

/**
 * Base URL of the GitLab instance, e.g. https://gitlab.com or a self-hosted host.
 *
 * Resolved lazily rather than at module load: an invalid GITLAB_URL must fail
 * the GitLab operation that needs it, not crash every module that transitively
 * imports this one (clone.ts, doctor.ts, …). Reading env at call time also
 * keeps the value testable.
 */
export function gitlabBaseUrl(): string {
  return resolveGitLabBaseUrl();
}

/** Base URL for REST API calls (GitLab mounts the API under /api/v4). */
function gitlabApiBase(): string {
  return `${gitlabBaseUrl()}/api/v4`;
}

function resolveGitLabBaseUrl(): string {
  const gitlabUrl = process.env.GITLAB_URL?.trim();
  if (gitlabUrl) {
    // Reject a value `new URL()` cannot parse (most often a missing scheme).
    // Without this the API base and GITLAB_HOST silently disagree: repo-url.ts
    // falls back to gitlab.com while every fetch here throws "Failed to parse
    // URL" from deep inside undici.
    try {
      const parsed = new URL(gitlabUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new Error(
        `Invalid GITLAB_URL: "${gitlabUrl}". Expected a full base URL including the ` +
          'scheme, e.g. https://gitlab.example.com',
      );
    }
    return gitlabUrl.replace(/\/+$/, '');
  }
  return `https://${GITLAB_HOST}`;
}

/** Resolve the GitLab token from env, honouring the documented aliases. */
export function getGitLabToken(): string | null {
  // Trim and treat blank as absent: CI often declares GITLAB_TOKEN with an unset
  // secret (empty string), and `$(cat token)` leaves a trailing newline that
  // undici rejects as an invalid header value.
  for (const raw of [
    process.env.GITLAB_TOKEN,
    process.env.GITLAB_PRIVATE_TOKEN,
    process.env.GITLAB_PAT,
  ]) {
    const token = raw?.trim();
    if (token) return token;
  }
  return null;
}

function requireToken(): string {
  const token = getGitLabToken();
  if (!token) {
    throw new Error(
      'GitLab authentication unavailable. Set the GITLAB_TOKEN environment variable ' +
        '(a GitLab Personal Access Token with `api` scope). GITLAB_PRIVATE_TOKEN and ' +
        'GITLAB_PAT are accepted as aliases.',
    );
  }
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'PRIVATE-TOKEN': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── Auth ────────────────────────────────────────────────

/** True when a GitLab token is configured (no network check). */
export function gitlabIsAuthenticated(): boolean {
  return getGitLabToken() !== null;
}

/** Fetch the authenticated GitLab username, or null when unavailable. */
export async function gitlabWhoami(): Promise<string | null> {
  const token = getGitLabToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${gitlabApiBase()}/user`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { username?: string };
    return data.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure GitLab is usable. Unlike TGit/CNB there is no CLI to install — only a
 * token is needed, which `authenticate` verifies.
 */
export async function ensureGitLabAvailable(): Promise<void> {
  const token = getGitLabToken();
  if (token) return;
  throw new Error(
    'GitLab authentication unavailable. Set GITLAB_TOKEN (or GITLAB_PRIVATE_TOKEN / GITLAB_PAT).',
  );
}

// ─── Repo operations ─────────────────────────────────────

export class GitLabRepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on GitLab.`);
    this.name = 'GitLabRepoNotFoundError';
  }
}

/**
 * Build the git clone URL WITHOUT credentials.
 *
 * Derived from the instance base URL rather than re-assembled from GITLAB_HOST,
 * so a self-hosted instance keeps its scheme (`http://` internal deployments),
 * its port, and any relative-URL-root prefix (`https://example.com/gitlab`).
 * The token is injected out-of-band via `http.extraHeader` (see gitlabRepoClone)
 * so it never lands in the remote URL, and therefore is not persisted to the
 * cloned repo's `.git/config` (where a URL-embedded credential would remain for
 * every later fetch/push). This mirrors the http.extraHeader approach already
 * used in clone.ts.
 */
function cloneUrl(repo: string): string {
  const base = gitlabBaseUrl().replace(/\/+$/, '');
  return `${base}/${repo}.git`;
}

/**
 * HTTP Basic auth header for a GitLab PAT (username fixed to `oauth2`), passed
 * to git via `-c http.extraHeader=...` so the token stays out of the URL.
 */
function gitlabAuthHeaderArg(token: string): string {
  const encoded = Buffer.from(`oauth2:${token}`).toString('base64');
  return `http.extraHeader=Authorization: Basic ${encoded}`;
}

/**
 * Clone a GitLab repo to localPath. The token is injected via http.extraHeader
 * rather than embedded in the remote URL, so it is not persisted to
 * `.git/config` for subsequent git operations.
 */
export function gitlabRepoClone(repo: string, localPath: string): void {
  const token = getGitLabToken();
  // `-c <key>=<val>` is a git-level option and must precede the `clone`
  // subcommand, matching the http.extraHeader pattern in clone.ts.
  const args: string[] = [];
  if (token) {
    args.push('-c', gitlabAuthHeaderArg(token));
  }
  args.push('clone', cloneUrl(repo), localPath);

  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (result.status === 0) return;

  // "not found" / "could not be found" indicate the repo does not exist (or the
  // token cannot see it). Auth failures are handled below as a generic error.
  if (
    allOutput.includes('not found')
    || allOutput.includes('does not exist')
    || allOutput.includes('Repository not found')
    || allOutput.includes('could not be found')
  ) {
    throw new GitLabRepoNotFoundError(repo);
  }

  // Redact any credentials git may have echoed back, using the shared helper so
  // coverage stays consistent with the rest of the codebase.
  const sanitized = sanitizeGitUrl(allOutput);
  throw new Error(`git clone failed: ${sanitized.trim()}`);
}

/**
 * Resolve a namespace path (group or group/subgroup) to its GitLab id.
 *
 * Looks the group up by its URL-encoded full path rather than searching, so a
 * common group name is not missed just because the exact match fell outside a
 * paginated `search=` result.
 */
async function resolveNamespaceId(owner: string, token: string): Promise<number | null> {
  const resp = await fetch(
    `${gitlabApiBase()}/groups/${encodeURIComponent(owner)}`,
    { headers: authHeaders(token), redirect: 'manual' },
  );
  if (!resp.ok) return null;
  const group = (await resp.json()) as { id?: number };
  return group.id ?? null;
}

/**
 * Create a private GitLab project. Uses the authenticated user's namespace when
 * `owner` matches the current user, otherwise resolves a group namespace.
 */
export async function gitlabCreateRepo(owner: string, repo: string): Promise<void> {
  const token = requireToken();
  const login = await gitlabWhoami();
  const body: Record<string, unknown> = { name: repo, path: repo, visibility: 'private' };

  if (!login || login.toLowerCase() !== owner.toLowerCase()) {
    const namespaceId = await resolveNamespaceId(owner, token);
    if (namespaceId === null) {
      // Posting without namespace_id would create the project under the
      // authenticated user instead, reporting success at the wrong location and
      // leaving a stray project behind.
      throw new Error(
        `Cannot create GitLab project: namespace "${owner}" was not found, or the token ` +
          'cannot see it. Check the group path and that the token has `api` scope.',
      );
    }
    body.namespace_id = namespaceId;
  }

  const resp = await fetch(`${gitlabApiBase()}/projects`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitLab project: ${resp.status} ${errBody}`);
  }
}

// ─── Merge requests ──────────────────────────────────────

export interface GitLabMrCreateOptions {
  /** Repository in "owner/repo" (or group/subgroup/repo) format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (usually 'main' or 'master') */
  target: string;
  /** MR title */
  title: string;
  /** MR description */
  description?: string;
  /** Reviewer usernames — resolved to GitLab user IDs (best-effort) */
  reviewers?: string[];
  /** Working directory (unused for the REST path, kept for interface parity) */
  cwd?: string;
}

interface GitLabUser {
  id: number;
  username: string;
}

/** Resolve reviewer usernames to GitLab user IDs (best-effort, skips misses). */
async function resolveReviewerIds(
  reviewers: string[] | undefined,
  token: string,
): Promise<number[]> {
  if (!reviewers?.length) return [];
  const ids: number[] = [];
  for (const username of reviewers) {
    try {
      const resp = await fetch(
        `${gitlabApiBase()}/users?username=${encodeURIComponent(username)}`,
        { headers: authHeaders(token), redirect: 'manual' },
      );
      if (!resp.ok) continue;
      const users = (await resp.json()) as GitLabUser[];
      const exact = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (exact) ids.push(exact.id);
    } catch {
      // Non-fatal: an unresolvable reviewer should not block MR creation.
    }
  }
  return ids;
}

/**
 * Create a Merge Request via the GitLab REST API.
 * Returns the MR web URL on success.
 */
export async function gitlabMrCreate(opts: GitLabMrCreateOptions): Promise<string> {
  const token = requireToken();
  const projectId = encodeURIComponent(opts.repo);

  const body: Record<string, unknown> = {
    source_branch: opts.source,
    target_branch: opts.target,
    title: opts.title,
  };
  if (opts.description) body.description = opts.description;

  const reviewerIds = await resolveReviewerIds(opts.reviewers, token);
  if (reviewerIds.length > 0) body.reviewer_ids = reviewerIds;

  const resp = await fetch(`${gitlabApiBase()}/projects/${projectId}/merge_requests`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitLab MR: ${resp.status} ${errBody}`);
  }

  const mr = (await resp.json()) as { web_url?: string; iid?: number };
  if (mr.web_url) return mr.web_url;
  if (mr.iid) return `${gitlabBaseUrl()}/${opts.repo}/-/merge_requests/${mr.iid}`;
  throw new Error('GitLab MR created but response did not include web_url.');
}
