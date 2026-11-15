/**
 * The GitHub REST API root: `GITHUB_API_URL`, which GitHub Actions sets to the GitHub Enterprise server's API, else
 * github.com's. It lives here, not in `gh-cli.ts`, so a test that mocks all of `gh-cli.ts` still gets the real value.
 */
export function githubApiUrl(): string {
  return (process.env['GITHUB_API_URL']?.trim() || 'https://api.github.com').replace(/\/+$/, '');
}
