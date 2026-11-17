/**
 * The GitHub REST API root: `GITHUB_API_URL` when set — GitHub Actions sets it to
 * an Enterprise server's API, which serves under a prefix such as /api/v3 — else
 * github.com's.
 *
 * Every REST call reads this, so a deployment pointed at an Enterprise host
 * reaches it whether the call goes through `gh` or straight to the API.
 */
export function githubApiUrl(): string {
  return (process.env['GITHUB_API_URL']?.trim() || 'https://api.github.com').replace(/\/+$/, '');
}
