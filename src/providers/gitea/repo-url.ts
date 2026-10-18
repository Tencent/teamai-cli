import type { RepoInfo } from '../types.js';

// GITEA_URL → instance boundary → repository / PR → canonical transport URL.

/** Resolve the configured instance without losing its scheme, port or subpath. */
export function giteaBaseUrl(): string {
  const raw = process.env.GITEA_URL?.trim();
  if (!raw) throw new Error('Set GITEA_URL to the full Gitea instance URL, e.g. http://gitea.example.com:3000.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid GITEA_URL: expected a full HTTP(S) instance URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid GITEA_URL: use HTTP(S) without credentials, query or fragment.');
  }
  const override = process.env.TEAMAI_GITEA_HOST?.trim().toLowerCase();
  if (override && override !== url.host && override !== url.hostname) {
    throw new Error('TEAMAI_GITEA_HOST and GITEA_URL must name the same instance host. SSH aliases are not supported.');
  }
  return url.href.replace(/\/+$/, '');
}

export function giteaApiBase(): string {
  return `${giteaBaseUrl()}/api/v1`;
}

/** Detection is only a routing hint; parsing below checks the complete boundary. */
export function isConfiguredGiteaHost(host: string): boolean {
  const raw = process.env.GITEA_URL?.trim();
  const override = process.env.TEAMAI_GITEA_HOST?.trim().toLowerCase();
  try {
    const url = raw ? new URL(giteaBaseUrl()) : null;
    return [url?.host, url?.hostname, override].some((candidate) => candidate === host.toLowerCase());
  } catch {
    return false;
  }
}

function component(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded === '.' || decoded === '..' || /[\s/\\?#]/.test(decoded)) {
    throw new Error('Invalid Gitea owner or repository name.');
  }
  return decoded;
}

/** Validate HTTP URLs before any token or Git header can be sent. */
export function assertGiteaHttpUrl(input: string): URL {
  const base = new URL(giteaBaseUrl());
  const url = new URL(input);
  const prefix = base.pathname.replace(/\/+$/, '');
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error('Gitea URL does not match the configured instance origin and base path.');
  }
  return url;
}

/** Parse a single-level owner/repo, HTTP(S), ssh:// or scp-style remote. */
export function parseGiteaRepoInput(input: string): RepoInfo {
  const raw = input.trim();
  const base = new URL(giteaBaseUrl());
  let path = raw;
  let ssh: URL | undefined;
  if (/^https?:\/\//i.test(raw)) {
    const url = assertGiteaHttpUrl(raw);
    path = url.pathname.slice(base.pathname.replace(/\/+$/, '').length + 1);
  } else if (/^ssh:\/\//i.test(raw) || /^[^@\s/:]+@[^:\s/]+:/.test(raw)) {
    const scp = raw.match(/^([^@\s/:]+)@([^:\s/]+):(.+)$/);
    ssh = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : raw);
    if (ssh.protocol !== 'ssh:' || ssh.hostname !== base.hostname || ssh.password || ssh.search || ssh.hash) {
      throw new Error('Gitea SSH URL must use the configured hostname without a password.');
    }
    path = ssh.pathname.replace(/^\//, '');
  } else if (raw.includes('://') || raw.includes('@') || raw.startsWith('/')) {
    throw new Error('Invalid Gitea repository URL.');
  }
  const segments = path.replace(/\/+$/, '').split('/');
  if (segments.length !== 2 && !(segments.length === 4 && segments[2] === 'pulls' && /^[1-9]\d*$/.test(segments[3]))) {
    throw new Error('Invalid Gitea repository: expected owner/repo or an instance URL ending in /pulls/<number>.');
  }
  const owner = component(segments[0]);
  const repo = component(segments[1].replace(/\.git$/i, ''));
  const projectId = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let cloneUrl = `${giteaBaseUrl()}/${projectId}.git`;
  if (ssh) {
    ssh.pathname = `/${projectId}.git`;
    cloneUrl = ssh.href;
  }
  return { owner, repo, projectId, httpsUrl: cloneUrl };
}

export function parseGiteaPrUrl(input: string): RepoInfo & { number: number } {
  const url = assertGiteaHttpUrl(input);
  const match = url.pathname.match(/\/pulls\/([1-9]\d*)\/?$/);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Invalid Gitea PR URL.');
  return { ...parseGiteaRepoInput(input), number: Number(match[1]) };
}

/** Build API paths from parsed names, never from an unchecked absolute URL. */
export function giteaRepoPath(repo: string): string {
  return `/repos/${parseGiteaRepoInput(repo).projectId}`;
}
