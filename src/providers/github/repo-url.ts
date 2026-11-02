import type { RepoInfo } from '../types.js';

const GITHUB_HOST = 'github.com';

/**
 * Parse user input into a standardized RepoInfo structure for GitHub.
 * Supports:
 *   - Short format: `owner/repo`
 *   - HTTPS URL:    `https://github.com/owner/repo.git`
 *   - SSH URL:      `git@github.com:owner/repo.git`
 *
 * GitHub does not allow multi-segment owners (no subgroups), so we reject
 * inputs with more than one slash in the owner portion.
 */
export function parseGitHubRepoInput(input: string): RepoInfo {
  const trimmed = input.trim();

  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );

  if (httpsMatch) {
    return buildRepoInfo(httpsMatch[1], httpsMatch[2]);
  }

  const sshMatch = trimmed.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );

  if (sshMatch) {
    return buildRepoInfo(sshMatch[1], sshMatch[2]);
  }

  // Short format: owner/repo (single slash only, no subgroups on GitHub)
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );

  if (shortMatch) {
    return buildRepoInfo(shortMatch[1], shortMatch[2]);
  }

  throw new Error(
    `Unrecognized GitHub repo format: "${trimmed}"\n` +
      '  Supported formats:\n' +
      '    owner/repo\n' +
      `    https://${GITHUB_HOST}/owner/repo.git\n` +
      `    git@${GITHUB_HOST}:owner/repo.git`,
  );
}

function buildRepoInfo(owner: string, repo: string): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `https://${GITHUB_HOST}/${owner}/${repo}.git`,
    projectId: `${owner}/${repo}`,
  };
}
