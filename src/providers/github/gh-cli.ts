import { execSync, spawnSync } from 'node:child_process';
import { spawnGit, pinUrlCredential } from '../../utils/git.js';
import { log, spinner } from '../../utils/logger.js';

// ─── Constants ───────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

// ─── Shell helpers ───────────────────────────────────────

/** Shell-quote a string using single quotes. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── gh CLI detection ────────────────────────────────────

/** Returns the full path to gh if available on PATH, else null. */
function getGhPath(): string | null {
  try {
    const which = execSync('which gh', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = which.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Check whether the gh CLI is installed and on PATH. */
export function isGhInstalled(): boolean {
  return getGhPath() !== null;
}

/**
 * Execute a gh CLI command.
 * Returns { stdout, stderr, status }.
 */
export function ghExec(
  args: string[],
  options?: { inheritStdio?: boolean; cwd?: string; env?: NodeJS.ProcessEnv },
): { stdout: string; stderr: string; status: number } {
  const ghPath = getGhPath();
  if (!ghPath) {
    throw new Error(
      'gh CLI not found. Install it from https://cli.github.com/ or set GITHUB_TOKEN environment variable.',
    );
  }

  log.debug(`gh exec: ${ghPath} ${args.join(' ')}`);

  if (options?.inheritStdio) {
    const result = spawnSync(ghPath, args, {
      stdio: 'inherit',
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd,
    });
    return { stdout: '', stderr: '', status: result.status ?? 1 };
  }

  const result = spawnSync(ghPath, args, {
    env: { ...process.env, ...(options?.env ?? {}) },
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: options?.cwd,
  });

  return {
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
    status: result.status ?? 1,
  };
}

// ─── Installation guidance ───────────────────────────────

/**
 * Ensure gh CLI is available, or fall back to GITHUB_TOKEN env var.
 * Unlike gf, we don't auto-download gh — it's widely packaged by OS package managers.
 */
export async function ensureGhAvailable(): Promise<void> {
  if (isGhInstalled()) {
    log.debug('gh CLI detected');
    return;
  }

  if (getGitHubToken()) {
    log.debug('GITHUB_TOKEN env var detected — will use REST API directly');
    return;
  }

  throw new Error(
    'GitHub authentication unavailable.\n' +
      '  Option 1 (recommended): Install gh CLI — https://cli.github.com/\n' +
      '    macOS:   brew install gh\n' +
      '    Linux:   see https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n' +
      '  Option 2: Export a personal access token — GITHUB_TOKEN=ghp_... (needs "repo" scope)',
  );
}

// ─── Authentication ──────────────────────────────────────

/**
 * Read GITHUB_TOKEN / GH_TOKEN from environment.
 * Returns null if neither is set.
 */
export function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

/**
 * Retrieve an OAuth token via gh CLI (falls back to GITHUB_TOKEN env var).
 * Returns null when neither source yields a token.
 *
 * `gh auth token` prints the active token to stdout when the user is logged in.
 */
export function ghGetOAuthToken(): string | null {
  const envToken = getGitHubToken();
  if (envToken) return envToken;

  if (!isGhInstalled()) return null;

  try {
    const result = ghExec(['auth', 'token']);
    if (result.status !== 0) return null;
    const token = result.stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Check if the user is currently authenticated with GitHub.
 * True if either gh CLI has a live session or GITHUB_TOKEN is exported.
 */
export function ghIsAuthenticated(): boolean {
  if (getGitHubToken()) return true;
  if (!isGhInstalled()) return false;
  try {
    const result = ghExec(['auth', 'status']);
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Query the authenticated user's login via REST API.
 * Returns null on failure (no token, network error, invalid token).
 */
export async function ghFetchLogin(token: string): Promise<string | null> {
  try {
    const resp = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the authenticated username. Prefer `gh api user` (works without leaking
 * token to subprocess), fall back to REST API call with GITHUB_TOKEN.
 */
export async function ghAuthWhoami(): Promise<string | null> {
  if (isGhInstalled()) {
    try {
      const result = ghExec(['api', 'user', '-q', '.login']);
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
    } catch {
      // fall through to token-based path
    }
  }

  const token = getGitHubToken();
  if (token) {
    return ghFetchLogin(token);
  }
  return null;
}

/**
 * Run `gh auth login` interactively. Only works if gh CLI is installed.
 */
export function ghAuthLogin(): void {
  if (!isGhInstalled()) {
    throw new Error(
      'Cannot start interactive login: gh CLI is not installed.\n' +
        'Install gh from https://cli.github.com/ or export GITHUB_TOKEN.',
    );
  }
  log.info('Starting GitHub authentication via gh CLI...');
  const result = ghExec(['auth', 'login', '--web', '--git-protocol', 'https'], {
    inheritStdio: true,
  });
  if (result.status !== 0) {
    throw new Error('gh auth login failed. Please try again.');
  }
}

/**
 * Ensure the user is authenticated. Triggers interactive login if needed.
 * Returns the authenticated username.
 */
export async function ensureGhAuthenticated(): Promise<string> {
  const existing = await ghAuthWhoami();
  if (existing) return existing;

  // Need to log in — only possible via gh CLI
  ghAuthLogin();

  const verified = await ghAuthWhoami();
  if (!verified) {
    throw new Error('GitHub authentication failed. Please run `teamai init` again.');
  }
  return verified;
}

// ─── Repo operations ─────────────────────────────────────

/** Error indicating the remote repo was not found on GitHub. */
export class RepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on GitHub.`);
    this.name = 'RepoNotFoundError';
  }
}

/**
 * Clone a GitHub repo using `git clone` with an embedded OAuth token so
 * subsequent pull/push operations work without a separate credential helper.
 * Throws RepoNotFoundError when the remote does not exist.
 */
export function ghRepoClone(repo: string, localPath: string): void {
  const token = ghGetOAuthToken();
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;

  const result = spawnGit(['clone', cloneUrl, localPath], { credentialInUrl: Boolean(token) });

  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (
    allOutput.includes('not found') ||
    allOutput.includes('does not exist') ||
    allOutput.includes('Repository not found')
  ) {
    throw new RepoNotFoundError(repo);
  }
  if (result.status !== 0) {
    const sanitized = allOutput.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    throw new Error(`git clone failed: ${sanitized.trim()}`);
  }
  if (token) pinUrlCredential(localPath);
}

/**
 * Create a repo on GitHub via REST API.
 *  - If `owner` matches the authenticated user, use `POST /user/repos`
 *  - Otherwise treat `owner` as an organization and use `POST /orgs/:org/repos`
 * Throws on failure.
 */
export async function ghCreateRepo(owner: string, repo: string): Promise<void> {
  const token = ghGetOAuthToken();
  if (!token) {
    throw new Error(
      'Cannot retrieve GitHub token. Run `gh auth login` or export GITHUB_TOKEN.',
    );
  }

  const authHeaders = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const login = await ghFetchLogin(token);
  const isOwnerSelf = login && login.toLowerCase() === owner.toLowerCase();
  const endpoint = isOwnerSelf
    ? `${GITHUB_API}/user/repos`
    : `${GITHUB_API}/orgs/${encodeURIComponent(owner)}/repos`;

  const body = {
    name: repo,
    private: true,
    auto_init: false,
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create GitHub repo: ${resp.status} ${errBody}`);
  }
}

// ─── Pull Request ────────────────────────────────────────

export interface GhPrCreateOptions {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (e.g. 'master' or 'main') */
  target: string;
  /** PR title */
  title: string;
  /** PR description */
  description?: string;
  /** Reviewer usernames */
  reviewers?: string[];
  /** Working directory (the team repo local path) */
  cwd?: string;
}

/**
 * Create a Pull Request.
 * Prefers `gh pr create` so reviewer requests, output formatting, and errors
 * are consistent with what the user sees elsewhere. Falls back to REST API
 * when gh CLI is not installed but GITHUB_TOKEN is set.
 * Returns the PR web URL.
 */
export async function ghPrCreate(opts: GhPrCreateOptions): Promise<string> {
  if (isGhInstalled()) {
    return ghPrCreateViaCli(opts);
  }
  if (getGitHubToken()) {
    return ghPrCreateViaApi(opts);
  }
  throw new Error(
    'Cannot create PR: gh CLI is not installed and GITHUB_TOKEN is not set.',
  );
}

function ghPrCreateViaCli(opts: GhPrCreateOptions): string {
  const args = [
    'pr',
    'create',
    '-R',
    opts.repo,
    '-B',
    opts.target,
    '-H',
    opts.source,
    '-t',
    opts.title,
  ];

  if (opts.description) {
    args.push('-b', opts.description);
  } else {
    // gh requires a body; use title as placeholder body
    args.push('-b', opts.title);
  }

  if (opts.reviewers && opts.reviewers.length > 0) {
    args.push('-r', opts.reviewers.join(','));
  }

  const result = ghExec(args, { cwd: opts.cwd });
  if (result.status !== 0) {
    const errMsg = result.stderr || result.stdout;
    throw new Error(`gh pr create failed: ${errMsg}`);
  }

  const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  throw new Error(`gh pr create succeeded but returned unexpected output: ${result.stdout}`);
}

async function ghPrCreateViaApi(opts: GhPrCreateOptions): Promise<string> {
  const token = getGitHubToken();
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set.');
  }

  const authHeaders = {
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const resp = await fetch(
    `${GITHUB_API}/repos/${opts.repo}/pulls`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: opts.title,
        body: opts.description ?? opts.title,
        head: opts.source,
        base: opts.target,
      }),
    },
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create PR: ${resp.status} ${errBody}`);
  }

  const pr = (await resp.json()) as { html_url?: string; number?: number };

  // Request reviewers in a separate call (GitHub REST API design)
  if (opts.reviewers && opts.reviewers.length > 0 && pr.number) {
    try {
      await fetch(
        `${GITHUB_API}/repos/${opts.repo}/pulls/${pr.number}/requested_reviewers`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ reviewers: opts.reviewers }),
        },
      );
    } catch {
      // Non-fatal: PR is created; reviewer request failure shouldn't block.
    }
  }

  if (!pr.html_url) {
    throw new Error('PR created but response did not include html_url.');
  }
  return pr.html_url;
}
