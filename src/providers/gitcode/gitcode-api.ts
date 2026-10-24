import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PullRequestRef } from '../types.js';
import { GITCODE_HOST } from './repo-url.js';
import { getUserHome, legacyUserHome } from '../../utils/home.js';
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
  return path.join(getUserHome(), '.netrc');
}

/**
 * Every `~/.netrc` that may hold the token, most current first.
 *
 * `netrcPath()` follows `getUserHome()`; before that it followed
 * `os.homedir()`. A user whose `HOME` points elsewhere already has their token
 * in the older location, so reads fall back to it rather than reporting
 * "unauthenticated" and making them paste the token again. Writes always target
 * `netrcPath()`, so re-authenticating consolidates onto the current home.
 *
 * Returns an empty list when no home resolves at all — the same "no credential
 * found" outcome the caller had before, rather than an exception from a getter
 * that used to swallow everything.
 */
function netrcReadPaths(): string[] {
  let current: string;
  try {
    current = netrcPath();
  } catch {
    return [];
  }
  const paths = [current];
  const legacy = legacyUserHome();
  if (legacy) paths.push(path.join(legacy, '.netrc'));
  return paths;
}

/** Read the gitcode.com token from ~/.netrc, or null when absent/unreadable. */
export function readNetrcToken(): string | null {
  const pattern = new RegExp(
    `machine\\s+${GITCODE_HOST.replace('.', '\\.')}\\s+.*?password\\s+(\\S+)`,
  );
  for (const file of netrcReadPaths()) {
    try {
      const match = fs.readFileSync(file, 'utf-8').match(pattern);
      if (match?.[1]) return match[1];
    } catch {
      // Missing or unreadable here — try the next location.
    }
  }
  return null;
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
 * This mirrors the TGit (`oauth2:<token>@`) provider. GitHub used to embed the
 * token the same way, but #978 replaced that with a one-shot `http.extraHeader`
 * plus a URL-scoped `credential.helper`, so no token reaches `.git/config`
 * there any more.
 * GitCode's git-over-HTTPS endpoint accepts Basic `oauth2:<token>`
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
  const result = spawnSync('git', ['clone', cloneUrl(repo, token), localPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
  });
  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (result.status === 0) return;

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
  spawnTimeoutMs?: number;
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
    ...(opts.spawnTimeoutMs ? { signal: AbortSignal.timeout(opts.spawnTimeoutMs) } : {}),
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

// ─── Open pull request lookup ────────────────────────────

const LOOKUP_PAGE = 100;

/** A listed pull request; a state outside Gitee's three is one this cannot read. */
const GitCodeOpenPullSchema = z.object({
  html_url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

/**
 * The open pull request from `source` into `target` in `repo`, asked of the GitCode REST API with the token
 * `getGitCodeToken` resolves. A request from a fork with the same branch name is not it. Never prompts, and throws,
 * rather than answering none, when GitCode cannot be asked or answers in time, answers what this cannot read, fills a
 * whole page without it, or names a request on another host.
 */
export async function gitcodeFindOpenPull({ repo, source, target, timeoutMs }: PullRequestRef): Promise<string | undefined> {
  const token = requireToken();
  const query = new URLSearchParams({ state: 'open', head: source, base: target, per_page: String(LOOKUP_PAGE) });
  const resp = await fetch(`${gitcodeApiBase()}/repos/${repo}/pulls?${query}`, {
    headers: authHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`GitCode answered the open pull request lookup with HTTP ${resp.status}. Check GITCODE_TOKEN and its access to the repository.`);
  const pulls = z.array(GitCodeOpenPullSchema).safeParse(await resp.json().catch(() => undefined));
  if (!pulls.success) throw new Error('GitCode answered the open pull request lookup with data TeamAI cannot read.');
  const ours = (name: string | undefined): boolean => name?.toLowerCase() === repo.toLowerCase();
  const found = pulls.data.find((pull) => pull.state === 'open' && pull.head.ref === source && pull.base.ref === target
    && ours(pull.head.repo?.full_name) && ours(pull.base.repo.full_name));
  if (!found) {
    if (pulls.data.length >= LOOKUP_PAGE) throw new Error('GitCode listed more open pull requests than one page, so TeamAI cannot tell whether this branch has one.');
    return undefined;
  }
  if (!found.html_url.startsWith(`https://${GITCODE_HOST}/`)) throw new Error('GitCode answered the open pull request lookup with a URL on another host.');
  return found.html_url;
}
