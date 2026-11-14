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
 * match onward is dropped — but only in a pasted browser URL, and only when
 * the segment carries a sub-path (see parseCodeupRepoInput). Only consulted
 * once at least two path segments (a usable `owner/repo`) have been collected.
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

/** The git transport a URL form asks for: its scheme, or null for the bare `org/group/repo` form. */
export type CodeupTransport = 'https' | 'ssh';

/**
 * The transport of the input as typed: https for an http(s) URL, ssh for an
 * ssh:// or scp-style URL, null for the bare path form, whose transport
 * codeupCloneTransport defaults.
 */
export function codeupInputTransport(input: string): CodeupTransport | null {
  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) return 'https';

  if (/^ssh:\/\//i.test(trimmed) || /^[^@\s]+@[^:\s]+:/i.test(trimmed)) return 'ssh';

  return null;
}

/** The host an explicit URL form names (https, ssh:// or scp-style), or null for the bare path form. */
function urlHost(input: string): string | null {
  const url = /^(?:ssh|https?):\/\/(?:[^@/\s]+@)?([^:/\s]+)/i.exec(input);

  if (url) return url[1].toLowerCase();

  const scp = /^[^@\s]+@([^:\s]+):/i.exec(input);

  return scp ? scp[1].toLowerCase() : null;
}

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

  // `--provider codeup` with another platform's URL must not send the Codeup
  // token to that host's API nor parse its path as a Codeup repo.
  const host = urlHost(trimmed);

  if (host !== null && host !== CODEUP_HOST) {
    throw new Error(
      `Refusing to parse a repo URL on "${host}" as Codeup: only ${CODEUP_HOST} is supported.`,
    );
  }

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
  const browserUrl = /^https?:\/\//i.test(trimmed);

  // Only a pasted browser URL carries web-route suffixes; a clone URL (any SSH
  // form, or a path ending in `.git`) and the bare short form never do — there
  // a route-like segment is a genuine nested group (`org/team/files/repo`).
  // Even in a browser URL, strip only from a route segment with a sub-path
  // after it (`/tree/master`, `/changeRequest/list`): a route-named last
  // segment is more often a repo of that name, and cutting a real path short
  // silently resolves a different repo instead of failing.
  const stripsRoutes = browserUrl && !/\.git\/?$/i.test(withoutPrefix);

  const cut = stripsRoutes
    ? allSegs.findIndex((seg, i) => i >= 2 && i < allSegs.length - 1 && WEB_ROUTE_SEGMENTS.has(seg))
    : -1;

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
