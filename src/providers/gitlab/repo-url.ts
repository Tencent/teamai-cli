import type { RepoInfo } from '../types.js';

/**
 * Git host for GitLab repos. Defaults to the public platform gitlab.com.
 *
 * Self-hosted / enterprise instances are supported two ways:
 *   - `GITLAB_URL` (standard GitLab env var): used to derive the host, e.g.
 *     `https://gitlab.example.com` → `gitlab.example.com`.
 *   - `TEAMAI_GITLAB_HOST`: direct host override (mirrors TEAMAI_CNB_HOST).
 *   - An explicit full URL in parseRepoInput always wins over both.
 */
export const GITLAB_HOST = resolveGitLabHost();

function resolveGitLabHost(): string {
  const direct = process.env.TEAMAI_GITLAB_HOST?.trim();
  if (direct) return direct;

  const gitlabUrl = process.env.GITLAB_URL?.trim();
  if (gitlabUrl) {
    try {
      const host = new URL(gitlabUrl).host;
      if (host) return host;
    } catch {
      // ignore malformed GITLAB_URL — fall through to default host
    }
  }
  return 'gitlab.com';
}

/**
 * Parse user input into a standardized RepoInfo structure for GitLab.
 * Supports:
 *   - Short format: `owner/repo` or `group/subgroup/repo`
 *   - HTTPS URL / SSH URL: host may be any self-hosted GitLab instance
 *   - Self-hosted URLs on any host (derived from GITLAB_URL / TEAMAI_GITLAB_HOST)
 *
 * The owner portion may contain multiple path segments (GitLab supports
 * subgroups), e.g. `group/subgroup/repo`.
 */
export function parseGitLabRepoInput(input: string): RepoInfo {
  const trimmed = stripGitLabRoutePath(input.trim());

  // Full URL — host is taken from the URL itself (covers self-hosted instances).
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    return buildRepoInfo(httpsMatch[1], httpsMatch[2], httpsMatch[3]);
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    return buildRepoInfo(sshMatch[1], sshMatch[2], sshMatch[3]);
  }

  // Short format: owner/repo or group/subgroup/repo (host = configured default)
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*)\/([A-Za-z0-9_.\-]+)$/,
  );
  if (shortMatch) {
    return buildRepoInfo(GITLAB_HOST, shortMatch[1], shortMatch[2]);
  }

  throw new Error(
    `Unrecognized GitLab repo format: "${trimmed}"\n` +
      '  Supported formats:\n' +
      '    owner/repo\n' +
      '    group/subgroup/repo\n' +
      `    https://${GITLAB_HOST}/owner/repo.git\n` +
      `    git@${GITLAB_HOST}:owner/repo.git`,
  );
}

/**
 * Strip GitLab's `/-/` route separator and everything after it.
 *
 * Every GitLab web URL past the project root carries one — `/-/tree/main`,
 * `/-/merge_requests/42`, `/-/blob/...`. Without this, the greedy owner group in
 * the URL patterns happily swallows the route, so pasting a URL straight from
 * the browser yields `owner: 'org/repo/-/tree', repo: 'main'` instead of an
 * error. `/-/` is never a legal part of a namespace or project path.
 */
function stripGitLabRoutePath(input: string): string {
  const marker = input.indexOf('/-/');
  return marker === -1 ? input : input.slice(0, marker);
}

function buildRepoInfo(host: string, owner: string, repo: string): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `https://${host}/${owner}/${repo}.git`,
    projectId: encodeURIComponent(`${owner}/${repo}`),
  };
}
