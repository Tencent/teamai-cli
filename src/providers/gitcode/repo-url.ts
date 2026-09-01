import type { RepoInfo } from '../types.js';

/**
 * Git host for GitCode repos. Fixed to the public platform gitcode.com — this
 * provider does not support self-hosted GitCode Enterprise (out of scope; see
 * docs/designs/gitcode-provider.md §8). The REST API lives on a *separate*
 * host (api.gitcode.com), handled in gitcode-api.ts.
 */
export const GITCODE_HOST = 'gitcode.com';

/**
 * Parse user input into a standardized RepoInfo structure for GitCode.
 *
 * Supports:
 *   - Short format:  `owner/repo`
 *   - HTTPS URL:     `https://gitcode.com/owner/repo(.git)`, tolerating trailing
 *                    web-route segments (`/tree/main`, `/pulls/1`, …)
 *   - SSH URL:       `git@gitcode.com:owner/repo(.git)`
 *
 * GitCode namespaces are single-level (a user or an organization), so exactly
 * two leading path segments are taken as `owner/repo`; anything after is a web
 * route and is ignored. Unlike GitLab there is no subgroup nesting and no `/-/`
 * route separator (GitCode uses GitHub/Gitee-style `/owner/repo/pulls/1`).
 */
export function parseGitCodeRepoInput(input: string): RepoInfo {
  const trimmed = input.trim();

  // Strip a leading scheme+host (HTTPS) or scp-style `git@host:` prefix, then
  // split into path segments. The first two segments are owner/repo; the rest
  // are web-route noise.
  const withoutPrefix = trimmed
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^git@[^:]+:/i, '')
    .replace(/^\/+/, '');

  const segs = withoutPrefix.split('/').filter(Boolean);
  if (segs.length >= 2) {
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/i, '');
    if (owner && repo) {
      return buildRepoInfo(owner, repo);
    }
  }

  throw new Error(
    `Unrecognized GitCode repo format: "${trimmed}"\n` +
      '  Supported formats:\n' +
      '    owner/repo\n' +
      `    https://${GITCODE_HOST}/owner/repo.git\n` +
      `    git@${GITCODE_HOST}:owner/repo.git`,
  );
}

function buildRepoInfo(owner: string, repo: string): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `https://${GITCODE_HOST}/${owner}/${repo}.git`,
    // GitCode's API addresses repos by the plain `owner/repo` path (Gitee-style),
    // not a URL-encoded id. Kept for interface parity with other providers.
    projectId: `${owner}/${repo}`,
  };
}
