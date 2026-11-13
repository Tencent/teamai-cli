import type { RepoInfo } from '../types.js';

/**
 * Git host for Codeup (阿里云云效代码管理) repos. Fixed to the public platform
 * codeup.aliyun.com — this provider does not support private deployments. The
 * OpenAPI lives on a separate host (openapi-rdc.aliyuncs.com), handled in
 * codeup-api.ts.
 */
export const CODEUP_HOST = 'codeup.aliyun.com';

/**
 * Path segments that start a web route rather than the repo path proper —
 * the browser's URLs for a repo's merge requests, file browser, commits and
 * settings append them after the repo path, so everything from the first
 * match onward is dropped. Only consulted once at least two path segments
 * (a usable `owner/repo`) have been collected.
 */
const WEB_ROUTE_SEGMENTS = new Set([
  'change',
  'changeRequest',
  'changeRequests',
  'tree',
  'blob',
  'commits',
  'commit',
  'branches',
  'tags',
  'releases',
  'compare',
  'settings',
  'overview',
  'files',
  'pipeline',
  'wiki',
  'snippets',
  'members',
  'pull',
  'pulls',
]);

/**
 * Parse user input into a standardized RepoInfo structure for Codeup.
 *
 * Supports:
 *   - Short format:  `org/group/repo` (Codeup namespaces nest under an
 *                    organization, so at least `owner/repo` and commonly
 *                    `org/team/repo` — the path is kept whole)
 *   - HTTPS URL:     `https://codeup.aliyun.com/org/group/repo(.git)`,
 *                    tolerating trailing web-route segments
 *                    (`/changeRequest/list`, `/tree/master`, …)
 *   - SSH URL:       `git@codeup.aliyun.com:org/group/repo(.git)`
 *
 * Codeup repo paths are multi-level (organization → optional nested groups →
 * repo), unlike GitCode/GitLab's fixed owner/repo shape. The full path is
 * therefore preserved: `owner` holds the first segment, `repo` the remaining
 * path, so `${owner}/${repo}` — the form init.ts and push.ts pass back to the
 * provider — reproduces the complete `org/group/repo` path.
 */
export function parseCodeupRepoInput(input: string): RepoInfo {
  const trimmed = input.trim();

  // Strip a leading scheme+host prefix, then split into path segments:
  //   - `ssh://[user@]host[:port]/…`  → drop through the first slash after host
  //   - `https?://host/…`             → drop scheme+host
  //   - scp-style `git@host:…`        → drop `git@host:`
  const withoutPrefix = trimmed
    .replace(/^ssh:\/\/[^/]+\//i, '')
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^[^@\s]+@[^:\s]+:/i, '')
    .replace(/^\/+/, '');

  const allSegs = withoutPrefix.split('/').filter(Boolean);

  // Cut at the first web-route segment, but never before owner/repo (two
  // segments) are collected — a group may legitimately share a web-route name.
  const cut = allSegs.findIndex((seg, i) => i >= 2 && WEB_ROUTE_SEGMENTS.has(seg));
  const segs = cut === -1 ? allSegs : allSegs.slice(0, cut);

  if (segs.length >= 2) {
    const owner = segs[0];
    const repo = segs.slice(1).join('/').replace(/\.git$/i, '');

    if (owner && repo) {
      return buildRepoInfo(owner, repo);
    }
  }

  throw new Error(
    `Unrecognized Codeup repo format: "${trimmed}"\n` +
      '  Supported formats:\n' +
      '    org/repo (or org/group/repo)\n' +
      `    https://${CODEUP_HOST}/org/group/repo.git\n` +
      `    git@${CODEUP_HOST}:org/group/repo.git`,
  );
}

function buildRepoInfo(owner: string, repo: string): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `https://${CODEUP_HOST}/${owner}/${repo}.git`,
    // Codeup's OpenAPI addresses repos by the numeric repository ID, or by the
    // URL-encoded full path (org%2Fgroup%2Frepo) on read endpoints.
    projectId: `${owner}/${repo}`,
  };
}
