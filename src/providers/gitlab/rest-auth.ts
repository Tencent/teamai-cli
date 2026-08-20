import { execSync } from 'node:child_process';
import { log } from '../../utils/logger.js';

/**
 * GitLab git host. Defaults to the public platform gitlab.com.
 *
 * `TEAMAI_GITLAB_HOST` overrides it for a self-hosted / enterprise GitLab
 * instance (e.g. `gitlab.mycorp.com`). Read at call time (not module load) so
 * tests and long-running processes pick up the current environment.
 */
export function getGitLabHost(): string {
  return process.env.TEAMAI_GITLAB_HOST?.trim() || 'gitlab.com';
}

/** Base URL for the GitLab REST API (modern v4 API). */
export function gitlabApiBase(): string {
  return `https://${getGitLabHost()}/api/v4`;
}

/**
 * Authentication scheme accepted by the GitLab REST API.
 *
 * - `private-token`: a Personal / Project Access Token via the `PRIVATE-TOKEN`
 *   header. This is the common CI credential.
 * - `bearer`: an OAuth2 access token via `Authorization: Bearer`.
 */
export type GitLabAuthScheme = 'private-token' | 'bearer';

/**
 * The auth scheme confirmed to work earlier this process. Once a request
 * succeeds after a scheme fallback we cache it so later calls skip the miss.
 */
let cachedScheme: GitLabAuthScheme | null = null;

/** Reset the cached auth scheme (test helper). */
export function resetGitLabAuthCache(): void {
  cachedScheme = null;
}

/**
 * Read a GitLab token from the environment.
 *
 * `GITLAB_TOKEN` is the primary variable; `GL_TOKEN` and `CI_JOB_TOKEN`
 * (GitLab CI's built-in job token) are accepted as fallbacks so pipelines work
 * without extra configuration.
 */
export function getGitLabEnvToken(): string | null {
  return (
    process.env.GITLAB_TOKEN ??
    process.env.GL_TOKEN ??
    process.env.CI_JOB_TOKEN ??
    null
  );
}

/**
 * Retrieve an OAuth token via the `glab` CLI, when installed and logged in.
 * Returns null when glab is unavailable or holds no token.
 */
export function glabGetToken(): string | null {
  try {
    const out = execSync('glab auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const token = out.trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a GitLab credential and its matching auth scheme.
 *
 * An env token (`GITLAB_TOKEN` / `GL_TOKEN` / `CI_JOB_TOKEN`) is treated as a
 * Personal/Project Access Token (`PRIVATE-TOKEN` header). Otherwise the token
 * from `glab auth token` is used as an OAuth2 bearer token.
 *
 * @throws Error when no credential is available
 */
export function getGitLabToken(): { token: string; scheme: GitLabAuthScheme } {
  const envToken = getGitLabEnvToken();
  if (envToken && envToken.length > 0) {
    return { token: envToken, scheme: 'private-token' };
  }

  const glabToken = glabGetToken();
  if (glabToken) {
    return { token: glabToken, scheme: 'bearer' };
  }

  throw new Error(
    'No GitLab credentials found. Set the GITLAB_TOKEN environment variable ' +
      '(a GitLab Personal Access Token with "api" scope) or run `glab auth login`.',
  );
}

/**
 * Like {@link getGitLabToken} but returns null instead of throwing when no
 * credential is available.
 */
export function tryGetGitLabToken(): { token: string; scheme: GitLabAuthScheme } | null {
  try {
    return getGitLabToken();
  } catch {
    return null;
  }
}

/**
 * Build an authenticated GitLab clone/fetch URL, or null when no credential is
 * available.
 *
 * GitLab accepts both PATs and OAuth tokens presented as in-URL basic-auth with
 * the `oauth2` username (`https://oauth2:<token>@host/…`), so a single form
 * works for either credential kind.
 *
 * @param httpsUrl - the base `https://<host>/…` clone URL (no credentials)
 */
export function gitlabGitCloneUrl(httpsUrl: string): string | null {
  const cred = tryGetGitLabToken();
  if (!cred) return null;
  return httpsUrl.replace(/^https:\/\//, `https://oauth2:${cred.token}@`);
}

/** Build the authorization header for the given token and scheme. */
export function gitlabAuthHeaders(token: string, scheme: GitLabAuthScheme): Record<string, string> {
  if (scheme === 'bearer') {
    return { Authorization: `Bearer ${token}` };
  }
  return { 'PRIVATE-TOKEN': token };
}

/**
 * Fetch a path from the GitLab REST API with automatic auth-scheme handling.
 *
 * The token and its resolved scheme come from {@link getGitLabToken}, unless a
 * working scheme was cached earlier this process. On a 401 the request is
 * retried once with the opposite scheme; a success there caches the scheme.
 *
 * @param path - API path beginning with '/', appended to `<host>/api/v4`
 * @param init - optional fetch init; its headers and signal are respected
 * @returns the final Response (callers inspect status themselves)
 * @throws Error when no GitLab credential is available
 */
export async function gitlabFetch(path: string, init?: RequestInit): Promise<Response> {
  const { token, scheme: resolvedScheme } = getGitLabToken();
  const scheme = cachedScheme ?? resolvedScheme;
  const url = `${gitlabApiBase()}${path}`;

  const callerHeaders = { ...(init?.headers as Record<string, string> | undefined) };
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...callerHeaders };

  const doFetch = (activeScheme: GitLabAuthScheme): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: { ...baseHeaders, ...gitlabAuthHeaders(token, activeScheme) },
      signal: init?.signal ?? AbortSignal.timeout(15000),
    });

  const resp = await doFetch(scheme);
  if (resp.status !== 401) {
    return resp;
  }

  // Auth rejected — retry once with the opposite scheme.
  const altScheme: GitLabAuthScheme = scheme === 'bearer' ? 'private-token' : 'bearer';
  log.debug(`GitLab auth scheme "${scheme}" rejected (401); retrying with "${altScheme}"`);
  const altResp = await doFetch(altScheme);
  if (altResp.status !== 401) {
    cachedScheme = altScheme;
    return altResp;
  }
  return resp;
}
