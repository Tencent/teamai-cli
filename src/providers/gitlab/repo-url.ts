import type { RepoInfo } from '../types.js';
import { getGitLabHost } from './rest-auth.js';

/**
 * Escape a string for safe interpolation into a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse user input into a standardized RepoInfo structure for GitLab.
 *
 * Supports:
 *   - Short format: `owner/repo` or `group/subgroup/repo`
 *   - HTTPS URL:    `https://gitlab.com/owner/repo.git`
 *   - SSH URL:      `git@gitlab.com:owner/repo.git`
 *
 * The host is gitlab.com by default, or the value of `TEAMAI_GITLAB_HOST` for a
 * self-hosted instance. GitLab groups may be nested arbitrarily deep, so the
 * owner portion may contain multiple path segments (e.g. `group/subgroup`).
 */
export function parseGitLabRepoInput(input: string): RepoInfo {
  const trimmed = input.trim();
  const host = getGitLabHost();
  const hostRe = escapeRegExp(host);

  // HTTPS URL — owner path may contain multiple segments
  const httpsMatch = trimmed.match(
    new RegExp(`^https?://${hostRe}/(.+)/([^/]+?)(?:\\.git)?/?$`),
  );
  if (httpsMatch) {
    return buildRepoInfo(host, httpsMatch[1], httpsMatch[2]);
  }

  // SSH URL — owner path may contain multiple segments
  const sshMatch = trimmed.match(
    new RegExp(`^git@${hostRe}:(.+)/([^/]+?)(?:\\.git)?/?$`),
  );
  if (sshMatch) {
    return buildRepoInfo(host, sshMatch[1], sshMatch[2]);
  }

  // Short format: owner/repo or group/subgroup/repo
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*)\/([A-Za-z0-9_.\-]+)$/,
  );
  if (shortMatch) {
    return buildRepoInfo(host, shortMatch[1], shortMatch[2]);
  }

  throw new Error(
    `Unrecognized GitLab repo format: "${trimmed}"\n` +
      '  Supported formats:\n' +
      '    owner/repo\n' +
      '    group/subgroup/repo\n' +
      `    https://${host}/owner/repo.git\n` +
      `    git@${host}:owner/repo.git`,
  );
}

function buildRepoInfo(host: string, owner: string, repo: string): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `https://${host}/${owner}/${repo}.git`,
    // GitLab addresses a project by the URL-encoded full path `group/repo`.
    projectId: encodeURIComponent(`${owner}/${repo}`),
  };
}
