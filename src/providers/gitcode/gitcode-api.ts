import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GITCODE_HOST } from './repo-url.js';
import { spawnGit, pinUrlCredential } from '../../utils/git.js';
import { sanitizeGitUrl } from '../../utils/redact.js';

/**
 * GitCode (gitcode.com) REST API client.
 *
 * GitCode uses a Gitee/AtomGit-style v5 REST API — NOT GitLab-style — so this
 * provider is modelled on gitlab/ structurally but differs in every dialect
 * detail (all verified against the live API):
 *
 *   - API base is a SEPARATE host: https://api.gitcode.com/api/v5
 *   - A Personal Access Token authenticates every REST call via the
 *     `Authorization: Bearer` header.
 *   - whoami returns `login` (not GitLab's `username`).
 *   - PR create is `POST /repos/{owner}/{repo}/pulls` with `head`/`base`/
 *     `title`/`body`, response `html_url` (web path uses `/pull/` singular).
 *
 * Auth token resolution (highest precedence first):
 *   1. `GITCODE_TOKEN` env var (primary)
 *   2. `GC_TOKEN` env var (alias — matches the gitcode-cli convention)
 *   3. `~/.netrc` entry `machine gitcode.com … password <token>`
 */

// ─── Config ──────────────────────────────────────────────

const GITCODE_API_BASE = 'https://api.gitcode.com/api/v5';

export function gitcodeApiBase(): string {
  return GITCODE_API_BASE;
}

// ─── Token resolution ────────────────────────────────────

/** Resolve the GitCode PAT from env, then ~/.netrc. Returns null when absent. */
export function getGitCodeToken(): string | null {
  for (const raw of [process.env.GITCODE_TOKEN, process.env.GC_TOKEN]) {
    const token = raw?.trim();
    if (token) return token;
  }
  return readNetrcToken();
}

function requireToken(): string {
  const token = getGitCodeToken();
  if (!token) {
    throw new Error(
      'GitCode authentication unavailable. Set GITCODE_TOKEN (a GitCode Personal ' +
        'Access Token), or run `teamai init` to paste one interactively. GC_TOKEN is ' +
        'accepted as an alias.',
    );
  }
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── ~/.netrc credential storage ─────────────────────────
//
// Reused (not reinvented) as the credential store: git reads ~/.netrc natively
// for HTTPS clone/push, and the TGit provider already persists tokens here.
// Entry format: `machine gitcode.com login oauth2 password <token>`.

function netrcPath(): string {
  return path.join(os.homedir(), '.netrc');
}

/** Read the gitcode.com token from ~/.netrc, or null when absent/unreadable. */
export function readNetrcToken(): string | null {
  try {
    const content = fs.readFileSync(netrcPath(), 'utf-8');
    const match = content.match(
      new RegExp(`machine\\s+${GITCODE_HOST.replace('.', '\\.')}\\s+.*?password\\s+(\\S+)`),
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the token to ~/.netrc (mode 0600). Replaces any existing gitcode.com
 * entry so re-authenticating overwrites rather than duplicates.
 */
export function writeNetrcToken(token: string): void {
  const file = netrcPath();
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // no existing file — start fresh
  }
  const filtered = existing
    .split('\n')
    .filter((line) => !new RegExp(`^machine\\s+${GITCODE_HOST.replace('.', '\\.')}\\b`).test(line.trim()))
    .join('\n')
    .replace(/\n+$/, '');

  const entry = `machine ${GITCODE_HOST} login oauth2 password ${token}`;
  const next = filtered ? `${filtered}\n${entry}\n` : `${entry}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

// ─── Auth ────────────────────────────────────────────────

/** True when a GitCode token is configured (no network check). */
export function gitcodeIsAuthenticated(): boolean {
  return getGitCodeToken() !== null;
}

/** Fetch the authenticated GitCode username (`login`), or null when unavailable. */
export async function gitcodeWhoami(): Promise<string | null> {
  const token = getGitCodeToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${gitcodeApiBase()}/user`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}

// ─── Repo operations ─────────────────────────────────────

export class GitCodeRepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on GitCode.`);
    this.name = 'GitCodeRepoNotFoundError';
  }
}

/**
 * Build the clone URL for the team repo, embedding the PAT as `oauth2:<token>@`
 * basic-auth so the credential PERSISTS to `.git/config` and later `git push`
 * (branch + PR flow) authenticates without a separate credential helper.
 *
 * This mirrors the GitHub (`x-access-token:<token>@`) and TGit (`oauth2:<token>@`)
 * providers. GitCode's git-over-HTTPS endpoint accepts Basic `oauth2:<token>`
 * but REJECTS `Authorization: Bearer` (verified live) — so an in-URL credential,
 * not a Bearer header, is required. The token lives only in the private team-repo
 * clone under ~/.teamai/team-repo.
 */
function cloneUrl(repo: string, token: string | null): string {
  if (token) {
    return `https://oauth2:${token}@${GITCODE_HOST}/${repo}.git`;
  }
  return `https://${GITCODE_HOST}/${repo}.git`;
}

/** Redact an embedded oauth2 token from git output before logging/throwing. */
function redactCloneOutput(output: string): string {
  return sanitizeGitUrl(output.replace(/oauth2:[^@]+@/g, 'oauth2:***@')).trim();
}

/**
 * Clone a GitCode repo to localPath. The token is embedded in the remote URL so
 * subsequent pull/push operations work (see cloneUrl).
 */
export function gitcodeRepoClone(repo: string, localPath: string): void {
  const token = getGitCodeToken();
  const result = spawnGit(['clone', cloneUrl(repo, token), localPath], {
    credentialInUrl: token !== null,
  });
  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (result.status === 0) {
    if (token) pinUrlCredential(localPath);
    return;
  }

  if (
    allOutput.includes('not found')
    || allOutput.includes('does not exist')
    || allOutput.includes('Repository not found')
    || allOutput.includes('could not be found')
    || /\b404\b/.test(allOutput)
  ) {
    throw new GitCodeRepoNotFoundError(repo);
  }

  throw new Error(`git clone failed: ${redactCloneOutput(allOutput)}`);
}

/**
 * Create a private GitCode repo. Uses the authenticated user's namespace when
 * `owner` matches the current user (`POST /user/repos`), otherwise creates it
 * under an organization (`POST /orgs/{org}/repos`).
 */
export async function gitcodeCreateRepo(owner: string, repo: string): Promise<void> {
  const token = requireToken();
  const login = await gitcodeWhoami();

  const isOrg = !login || login.toLowerCase() !== owner.toLowerCase();
  const endpoint = isOrg
    ? `${gitcodeApiBase()}/orgs/${encodeURIComponent(owner)}/repos`
    : `${gitcodeApiBase()}/user/repos`;

  const body: Record<string, unknown> = { name: repo, private: true, auto_init: true };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitCode repo: ${resp.status} ${errBody}`);
  }
}

// ─── Pull requests ───────────────────────────────────────

export interface GitCodePullCreateOptions {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (usually 'main' or 'master') */
  target: string;
  /** PR title */
  title: string;
  /** PR description */
  description?: string;
  /** Working directory (unused for the REST path, kept for interface parity) */
  cwd?: string;
}

/**
 * Create a pull request via the GitCode REST API.
 * `POST /repos/{owner}/{repo}/pulls` with Gitee-style body { head, base, title, body }.
 * Returns the PR web URL (`html_url`) on success.
 */
export async function gitcodePullCreate(opts: GitCodePullCreateOptions): Promise<string> {
  const token = requireToken();

  const body: Record<string, unknown> = {
    title: opts.title,
    head: opts.source,
    base: opts.target,
  };
  if (opts.description) body.body = opts.description;

  const resp = await fetch(`${gitcodeApiBase()}/repos/${opts.repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitCode PR: ${resp.status} ${errBody}`);
  }

  const pr = (await resp.json()) as { html_url?: string; number?: number };
  if (pr.html_url) return pr.html_url;
  // Fallback when html_url is absent: GitCode's PR web path uses `/pull/`
  // (singular), verified against the live API — not `/pulls/`.
  if (pr.number) return `https://${GITCODE_HOST}/${opts.repo}/pull/${pr.number}`;
  throw new Error('GitCode PR created but response did not include html_url.');
}
