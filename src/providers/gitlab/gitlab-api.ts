import { spawnSync } from 'node:child_process';
import { log } from '../../utils/logger.js';
import {
  getGitLabHost,
  gitlabFetch,
  tryGetGitLabToken,
  gitlabGitCloneUrl,
} from './rest-auth.js';
import { parseGitLabRepoInput } from './repo-url.js';

/** Error indicating the remote repo was not found on GitLab. */
export class RepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on GitLab.`);
    this.name = 'RepoNotFoundError';
  }
}

// ─── Authentication state ────────────────────────────────

/** True when any usable GitLab credential (env token or glab CLI) is present. */
export function gitlabIsAuthenticated(): boolean {
  return tryGetGitLabToken() !== null;
}

interface GitLabUser {
  username: string;
}

/**
 * Query the authenticated user's username via `GET /user`.
 * Returns null on failure (no token, network error, invalid token).
 */
export async function gitlabWhoami(): Promise<string | null> {
  try {
    const resp = await gitlabFetch('/user');
    if (!resp.ok) return null;
    const data = (await resp.json()) as GitLabUser;
    return data.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure the user is authenticated. GitLab auth here is token-based (no
 * interactive OAuth flow of our own): the user exports GITLAB_TOKEN or logs in
 * via `glab auth login` beforehand. Returns the authenticated username.
 *
 * @throws Error with setup guidance when no credential resolves.
 */
export async function ensureGitLabAuthenticated(): Promise<string> {
  const username = await gitlabWhoami();
  if (username) return username;

  throw new Error(
    'GitLab authentication unavailable.\n' +
      '  Option 1: Export a Personal Access Token (needs "api" scope):\n' +
      '    export GITLAB_TOKEN=glpat-xxxxxxxx\n' +
      '  Option 2: Install the glab CLI and run `glab auth login` —\n' +
      '    https://gitlab.com/gitlab-org/cli\n' +
      (getGitLabHost() !== 'gitlab.com'
        ? `  For your self-hosted instance, TEAMAI_GITLAB_HOST=${getGitLabHost()} is set.\n`
        : '  For a self-hosted instance, set TEAMAI_GITLAB_HOST=gitlab.mycorp.com\n'),
  );
}

// ─── Repo operations ─────────────────────────────────────

/**
 * Clone a GitLab repo using `git clone` with an embedded token so subsequent
 * pull/push operations work without a separate credential helper.
 * Throws RepoNotFoundError when the remote does not exist.
 */
export function gitlabRepoClone(repo: string, localPath: string): void {
  const info = parseGitLabRepoInput(repo);
  const cloneUrl = gitlabGitCloneUrl(info.httpsUrl) ?? info.httpsUrl;

  const result = spawnSync('git', ['clone', cloneUrl, localPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });

  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (
    allOutput.includes('not found') ||
    allOutput.includes('does not exist') ||
    allOutput.includes('Repository not found') ||
    allOutput.includes('404')
  ) {
    throw new RepoNotFoundError(repo);
  }
  if (result.status !== 0) {
    // Never leak the token embedded in the clone URL into error output.
    const sanitized = allOutput.replace(/oauth2:[^@]+@/g, 'oauth2:***@');
    throw new Error(`git clone failed: ${sanitized.trim()}`);
  }
}

interface GitLabNamespace {
  id: number;
  full_path: string;
  kind: 'user' | 'group';
}

/**
 * Resolve a namespace (user or group) full path to its numeric id, required by
 * the project-creation API. Returns null when the namespace is not found or is
 * the caller's own user namespace (in which case no namespace_id is needed).
 */
async function resolveNamespaceId(owner: string): Promise<number | null> {
  const resp = await gitlabFetch(`/namespaces/${encodeURIComponent(owner)}`);
  if (!resp.ok) return null;
  const ns = (await resp.json()) as GitLabNamespace;
  return ns.id ?? null;
}

/**
 * Create a repo on GitLab via `POST /projects`.
 *  - If `owner` is a group, the project is created under that group's namespace.
 *  - If `owner` is the authenticated user, it is created under their namespace.
 * Throws on failure.
 */
export async function gitlabCreateRepo(owner: string, repo: string): Promise<void> {
  const body: Record<string, unknown> = {
    name: repo,
    path: repo,
    visibility: 'private',
  };

  // When the owner is not the caller's own username, treat it as a namespace
  // (group or another user) and resolve its id.
  const login = await gitlabWhoami();
  if (!login || login.toLowerCase() !== owner.toLowerCase()) {
    const nsId = await resolveNamespaceId(owner);
    if (nsId === null) {
      throw new Error(
        `Failed to create GitLab repo: namespace "${owner}" not found or not accessible.`,
      );
    }
    body.namespace_id = nsId;
  }

  const resp = await gitlabFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitLab repo: ${resp.status} ${errBody}`);
  }
}

// ─── Merge Request ───────────────────────────────────────

export interface GitLabMrCreateOptions {
  /** Repository in "owner/repo" (owner may be a nested group path) format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (e.g. 'master' or 'main') */
  target: string;
  /** MR title */
  title: string;
  /** MR description */
  description?: string;
  /** Reviewer usernames */
  reviewers?: string[];
}

interface GitLabMrResponse {
  web_url?: string;
  iid?: number;
}

interface GitLabUserLookup {
  id: number;
  username: string;
}

/**
 * Resolve reviewer usernames to numeric user ids. Unknown usernames are
 * silently skipped — a bad reviewer name must not block MR creation.
 */
async function resolveReviewerIds(usernames: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of usernames) {
    try {
      const resp = await gitlabFetch(`/users?username=${encodeURIComponent(name)}`);
      if (!resp.ok) continue;
      const users = (await resp.json()) as GitLabUserLookup[];
      const match = users.find((u) => u.username?.toLowerCase() === name.toLowerCase());
      if (match) ids.push(match.id);
    } catch {
      // Non-fatal — skip this reviewer.
    }
  }
  return ids;
}

/**
 * Create a Merge Request via `POST /projects/:id/merge_requests`.
 * Returns the MR web URL.
 */
export async function gitlabMrCreate(opts: GitLabMrCreateOptions): Promise<string> {
  const info = parseGitLabRepoInput(opts.repo);
  const projectId = info.projectId;

  const body: Record<string, unknown> = {
    source_branch: opts.source,
    target_branch: opts.target,
    title: opts.title,
    description: opts.description ?? '',
    remove_source_branch: true,
  };

  if (opts.reviewers && opts.reviewers.length > 0) {
    const reviewerIds = await resolveReviewerIds(opts.reviewers);
    if (reviewerIds.length > 0) {
      body.reviewer_ids = reviewerIds;
    }
  }

  const resp = await gitlabFetch(`/projects/${projectId}/merge_requests`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    // A duplicate MR for the same source/target is not a hard failure — surface
    // a helpful message but keep the wording aligned with other providers.
    throw new Error(`Failed to create GitLab MR: ${resp.status} ${errBody}`);
  }

  const mr = (await resp.json()) as GitLabMrResponse;
  if (!mr.web_url) {
    throw new Error('GitLab MR created but response did not include web_url.');
  }
  log.debug(`GitLab MR created: ${mr.web_url}`);
  return mr.web_url;
}
