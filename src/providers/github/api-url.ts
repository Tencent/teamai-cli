/** `GITHUB_SERVER_URL`, which GitHub Actions sets beside `GITHUB_API_URL`, else github.com. */
function githubServer(): URL {
  const server = process.env['GITHUB_SERVER_URL']?.trim();

  return new URL(server && URL.canParse(server) ? server : 'https://github.com');
}

function githubServerHost(): string {
  return githubServer().host.toLowerCase();
}

/**
 * The REST API root of the `GITHUB_SERVER_URL` server: `GITHUB_API_URL`, which GitHub Actions sets, else where GitHub
 * serves it, api.github.com for github.com and `/api/v3` on a GitHub Enterprise Server.
 */
function githubApiUrl(): string {
  const api = process.env['GITHUB_API_URL']?.trim();

  if (api) return api.replace(/\/+$/, '');
  const server = githubServer();

  return server.host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `${server.origin}/api/v3`;
}

/** The REST API root for a repository on `host`: the `GITHUB_SERVER_URL` server's for that host, else github.com's. */
export function githubApiUrlFor(host: string): string {
  return host.toLowerCase() === githubServerHost() ? githubApiUrl() : 'https://api.github.com';
}

export function githubEnvToken(): string | null {
  return process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? null;
}

/** The token for a repository on `host`: `GITHUB_TOKEN` or `GH_TOKEN` on the server `GITHUB_SERVER_URL` names, else none. */
export function githubTokenFor(host: string): string | null {
  return host.toLowerCase() === githubServerHost() ? githubEnvToken() : null;
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
