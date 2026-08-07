import { gfGetOAuthToken } from './gf-cli.js';
import { log } from '../../utils/logger.js';

/** Authentication scheme accepted by the git.woa.com REST API. */
export type TGitAuthScheme = 'private-token' | 'bearer';

/** Base URL for the TGit REST API (git.woa.com/api/v3). */
const TGIT_API_BASE = 'https://git.woa.com/api/v3';

/**
 * The auth scheme confirmed to work earlier this process.
 *
 * Once a request succeeds after a scheme fallback, we cache the working
 * scheme so subsequent calls skip the failed attempt.
 */
let cachedScheme: TGitAuthScheme | null = null;

/**
 * Resolve the TGit REST credential and its matching auth scheme.
 *
 * A `TGIT_TOKEN` env var is treated as a git.woa.com Personal Access Token
 * (works with the `PRIVATE-TOKEN` header). Otherwise the OAuth token stored
 * in ~/.netrc by `gf auth login` is used (works with `Authorization: Bearer`).
 *
 * @returns the token and the auth scheme it requires
 * @throws Error when no credential is available
 */
export function getTGitToken(): { token: string; scheme: TGitAuthScheme } {
  const envToken = process.env['TGIT_TOKEN'];
  if (envToken && envToken.length > 0) {
    return { token: envToken, scheme: 'private-token' };
  }

  const oauthToken = gfGetOAuthToken();
  if (oauthToken) {
    return { token: oauthToken, scheme: 'bearer' };
  }

  throw new Error(
    'No TGit credentials found. Set the TGIT_TOKEN environment variable ' +
    '(a git.woa.com Personal Access Token) or run `gf auth login`.',
  );
}

/**
 * Build an authenticated git.woa.com clone/fetch URL, or null when no usable
 * git credential exists.
 *
 * IMPORTANT — git protocol vs REST API use different credentials on TGit:
 *
 * - **git-over-HTTPS (clone/fetch)** only accepts the OAuth token from
 *   `gf auth login` (stored in ~/.netrc), presented as in-URL basic-auth
 *   `https://oauth2:<token>@…`. This is the only form git.woa.com's git
 *   endpoint honours.
 * - A `TGIT_TOKEN` **Personal Access Token is REST-API-only** — git.woa.com's
 *   git endpoint rejects it in every form (in-URL basic-auth *and*
 *   `PRIVATE-TOKEN` header both get a 401 `www-authenticate: Basic`). So the
 *   PAT is deliberately ignored here; it is used only by {@link tgitFetch}.
 *
 * Consequently a stray `TGIT_TOKEN` in the environment must NOT shadow the
 * OAuth token for clone — doing so is exactly the bug this function prevents.
 *
 * @param httpsUrl - the base `https://git.woa.com/…` clone URL (no credentials)
 * @returns the authenticated URL, or null when only a PAT / nothing is available
 */
export function tgitGitCloneUrl(httpsUrl: string): string | null {
  const oauthToken = gfGetOAuthToken();
  if (!oauthToken) {
    return null;
  }
  return httpsUrl.replace(/^https:\/\//, `https://oauth2:${oauthToken}@`);
}

/**
 * Like {@link getTGitToken} but returns null instead of throwing when no
 * credential is available (lets callers choose a no-token fallback path).
 */
export function tryGetTGitToken(): { token: string; scheme: TGitAuthScheme } | null {
  try {
    return getTGitToken();
  } catch {
    return null;
  }
}

/**
 * Build the authorization header for the given token and scheme.
 *
 * @param token  - the credential value
 * @param scheme - 'bearer' or 'private-token'
 * @returns a header object carrying the credential
 */
export function tgitAuthHeaders(token: string, scheme: TGitAuthScheme): Record<string, string> {
  if (scheme === 'bearer') {
    return { Authorization: `Bearer ${token}` };
  }
  return { 'PRIVATE-TOKEN': token };
}

/**
 * Fetch a path from the TGit REST API with automatic auth-scheme handling.
 *
 * The token and its resolved scheme come from {@link getTGitToken}, unless a
 * working scheme was cached earlier this process (then the cache wins). On a
 * 401/403 the request is retried once with the opposite scheme; if that
 * succeeds the working scheme is cached for later calls.
 *
 * @param path - API path beginning with '/', appended to git.woa.com/api/v3
 * @param init - optional fetch init; its headers and signal are respected
 * @returns the final Response (callers inspect status themselves)
 * @throws Error when no TGit credential is available
 */
export async function tgitFetch(path: string, init?: RequestInit): Promise<Response> {
  const { token, scheme: resolvedScheme } = getTGitToken();
  const scheme = cachedScheme ?? resolvedScheme;
  const url = `${TGIT_API_BASE}${path}`;

  const callerHeaders = { ...(init?.headers as Record<string, string> | undefined) };
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...callerHeaders };

  // A fresh timeout signal per attempt when the caller supplied none: an
  // already-fired timeout signal cannot be reused for the fallback retry.
  const doFetch = (activeScheme: TGitAuthScheme): Promise<Response> => fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...tgitAuthHeaders(token, activeScheme) },
    signal: init?.signal ?? AbortSignal.timeout(15000),
  });

  const resp = await doFetch(scheme);
  if (resp.status !== 401 && resp.status !== 403) {
    return resp;
  }

  // Auth rejected — retry once with the opposite scheme.
  const altScheme: TGitAuthScheme = scheme === 'bearer' ? 'private-token' : 'bearer';
  log.debug(`TGit auth scheme "${scheme}" rejected (${resp.status}); retrying with "${altScheme}"`);
  const altResp = await doFetch(altScheme);
  if (altResp.status !== 401 && altResp.status !== 403) {
    cachedScheme = altScheme;
    return altResp;
  }
  // Both schemes failed: the retry did not help, so the original status is the
  // meaningful one (e.g. a genuine 403 authorized-but-forbidden, not a scheme
  // mismatch). Returning it avoids inverting the caller's 401-vs-403 remedy.
  return resp;
}
