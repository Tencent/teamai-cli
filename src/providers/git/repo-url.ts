import type { RepoInfo } from '../types.js';

const SUPPORTED_URL_HINT =
  'expected https://host/group/repo.git, ssh://git@host/group/repo.git, or git@host:group/repo.git';

function invalidRepoUrl(reason?: string): Error {
  const detail = reason ? `: ${reason}` : '';
  return new Error(`Invalid Git repo URL${detail} (${SUPPORTED_URL_HINT})`);
}

function parsePath(rawPath: string): { owner: string; repo: string; fullPath: string } {
  const cleanPath = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const segments = cleanPath.split('/').filter(Boolean);

  if (
    segments.length < 2
    || segments.some((segment) => segment === '.' || segment === '..' || /[\s\\]/.test(segment))
  ) {
    throw invalidRepoUrl('repository paths need an owner/group and a repository name');
  }

  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  return { owner, repo, fullPath: `${owner}/${repo}` };
}

function buildRepoInfo(owner: string, repo: string, remoteUrl: string): RepoInfo {
  return {
    owner,
    repo,
    // RepoInfo predates generic Git hosts. For this provider the field stores
    // the canonical clone URL, which may use HTTPS or SSH.
    httpsUrl: remoteUrl,
    projectId: encodeURIComponent(`${owner}/${repo}`),
  };
}

/** Parse a full HTTPS or SSH clone URL for an arbitrary Git host. */
export function parseGenericGitRepoInput(input: string): RepoInfo {
  const trimmed = input.trim();

  if (/^http:\/\//i.test(trimmed)) {
    throw invalidRepoUrl('plain HTTP is not supported; use HTTPS or SSH');
  }

  if (/^https:\/\//i.test(trimmed) || /^ssh:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw invalidRepoUrl();
    }

    const httpCredentials = /^https?:$/i.test(parsed.protocol) && (parsed.username || parsed.password);
    if (!parsed.hostname || parsed.password || httpCredentials) {
      throw new Error(
        'Invalid Git repo URL. Do not embed credentials in the URL; '
        + 'configure a Git credential helper or SSH key instead.',
      );
    }
    if (parsed.search || parsed.hash) {
      throw invalidRepoUrl('query strings and fragments are not supported');
    }

    const { owner, repo, fullPath } = parsePath(parsed.pathname);
    const auth = parsed.username ? `${parsed.username}@` : '';
    const remoteUrl = `${parsed.protocol}//${auth}${parsed.host}/${fullPath}.git`;
    return buildRepoInfo(owner, repo, remoteUrl);
  }

  const scpMatch = trimmed.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scpMatch) {
    const [, user, host, rawPath] = scpMatch;
    // A colon in the SSH user field means embedded credentials
    // (e.g. "oauth2:token@host:path"); a real SSH login never contains one.
    if (user.includes(':')) {
      throw new Error(
        'Invalid Git repo URL. Do not embed credentials in the URL; '
        + 'configure a Git credential helper or SSH key instead.',
      );
    }
    const { owner, repo, fullPath } = parsePath(rawPath);
    return buildRepoInfo(owner, repo, `${user}@${host}:${fullPath}.git`);
  }

  throw invalidRepoUrl();
}
