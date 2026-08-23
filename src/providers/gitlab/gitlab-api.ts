import { spawnSync } from 'node:child_process';
import { GITLAB_HOST } from './repo-url.js';

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

/** Base URL of the GitLab instance, e.g. https://gitlab.com or a self-hosted host. */
export const GITLAB_BASE_URL = resolveGitLabBaseUrl();

/** Base URL for REST API calls (GitLab mounts the API under /api/v4). */
const GITLAB_API_BASE = `${GITLAB_BASE_URL}/api/v4`;

function resolveGitLabBaseUrl(): string {
  const gitlabUrl = process.env.GITLAB_URL?.trim();
  if (gitlabUrl) {
    return gitlabUrl.replace(/\/+$/, '');
  }
  return `https://${GITLAB_HOST}`;
}

/** Resolve the GitLab token from env, honouring the documented aliases. */
export function getGitLabToken(): string | null {
  return (
    process.env.GITLAB_TOKEN
    ?? process.env.GITLAB_PRIVATE_TOKEN
    ?? process.env.GITLAB_PAT
    ?? null
  );
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
    const resp = await fetch(`${GITLAB_API_BASE}/user`, {
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

/** Build a git clone URL embedding the token (oauth2 scheme, per GitLab docs). */
function cloneUrl(repo: string): string {
  const token = getGitLabToken();
  if (token) {
    const auth = `oauth2:${token}`;
    return `https://${auth}@${GITLAB_HOST}/${repo}.git`;
  }
  return `${GITLAB_BASE_URL}/${repo}.git`;
}

/**
 * Clone a GitLab repo to localPath. Embeds the token in the remote URL so
 * subsequent git ops work without extra auth.
 */
export function gitlabRepoClone(repo: string, localPath: string): void {
  const result = spawnSync('git', ['clone', cloneUrl(repo), localPath], {
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

  const sanitized = allOutput.replace(/oauth2:[^@]+@/g, 'oauth2:***@');
  throw new Error(`git clone failed: ${sanitized.trim()}`);
}

/** Resolve a namespace path (user or group/subgroup) to its GitLab id. */
async function resolveNamespaceId(owner: string, token: string): Promise<number | null> {
  const resp = await fetch(
    `${GITLAB_API_BASE}/namespaces?search=${encodeURIComponent(owner)}&per_page=20`,
    { headers: authHeaders(token), redirect: 'manual' },
  );
  if (!resp.ok) return null;
  const namespaces = (await resp.json()) as Array<{ id: number; full_path: string }>;
  const exact = namespaces.find((n) => n.full_path.toLowerCase() === owner.toLowerCase());
  return exact?.id ?? null;
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
    if (namespaceId !== null) {
      body.namespace_id = namespaceId;
    }
  }

  const resp = await fetch(`${GITLAB_API_BASE}/projects`, {
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
        `${GITLAB_API_BASE}/users?username=${encodeURIComponent(username)}`,
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

  const resp = await fetch(`${GITLAB_API_BASE}/projects/${projectId}/merge_requests`, {
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
  if (mr.iid) return `${GITLAB_BASE_URL}/${opts.repo}/-/merge_requests/${mr.iid}`;
  throw new Error('GitLab MR created but response did not include web_url.');
}
