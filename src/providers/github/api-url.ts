/**
 * The GitHub REST API root: `GITHUB_API_URL`, which GitHub Actions sets to the GitHub Enterprise server's API, else
 * github.com's.
 */
function githubApiUrl(): string {
  return (process.env['GITHUB_API_URL']?.trim() || 'https://api.github.com').replace(/\/+$/, '');
}

/** The host of `GITHUB_SERVER_URL`, which GitHub Actions sets beside `GITHUB_API_URL`, else github.com. */
function githubServerHost(): string {
  const server = process.env['GITHUB_SERVER_URL']?.trim();

  return server && URL.canParse(server) ? new URL(server).host.toLowerCase() : 'github.com';
}

/**
 * The REST API root for a repository on `host`: `GITHUB_API_URL` for the server `GITHUB_SERVER_URL` names, github.com's
 * for github.com, so a token meant for an Enterprise server never goes to the other.
 */
export function githubApiUrlFor(host: string): string {
  return host.toLowerCase() === githubServerHost() ? githubApiUrl() : 'https://api.github.com';
}

/** A pull request on github.com or on the server `GITHUB_SERVER_URL` names. */
export interface GitHubPull {
  host: string;
  owner: string;
  repo: string;
  number: string;
}

/** Parses `https://<host>/<owner>/<repo>/pull/<number>`; null when the URL is no pull request or its host no GitHub. */
export function parseGitHubPullUrl(url: string): GitHubPull | null {
  const match = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

  if (!match) return null;
  const host = match[1].toLowerCase();

  if (host !== 'github.com' && host !== githubServerHost()) return null;

  return { host, owner: match[2], repo: match[3], number: match[4] };
}
