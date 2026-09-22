import { spawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { log } from '../../utils/logger.js';
import { resolveCliPath } from '../../utils/cli-path.js';
import { isInteractive } from '../../utils/prompt.js';

// ─── Constants ───────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

// ─── gh CLI detection ────────────────────────────────────

/**
 * Absolute path to the `gh` executable if available on PATH, else null.
 *
 * Not `which gh`: on Windows that lands on Git's `which`, which prints an MSYS
 * path (`/c/Program Files/GitHub CLI/gh`) that Node resolves as
 * `C:\c\Program Files\...` — `spawnSync` then fails with ENOENT, i.e.
 * `isGhInstalled()` answered "installed" while every `ghExec()` returned
 * status 1 with an empty stderr. `resolveCliPath` uses the native `where` on
 * Windows and accepts only a launchable path (`.exe` / `.cmd` / `.bat`).
 */
function getGhPath(): string | null {
  return resolveCliPath('gh');
}

/** Check whether the gh CLI is installed and on PATH. */
export function isGhInstalled(): boolean {
  return getGhPath() !== null;
}

/**
 * Execute a gh CLI command.
 * Returns { stdout, stderr, status }.
 *
 * Launches through cross-spawn rather than the native `spawnSync`, for the same
 * reason `callClaude` does: a `gh` that npm installed is a `.cmd` shim, and Node
 * cannot execute `.cmd` directly (EINVAL). Resolving the path alone is not
 * enough — `pickWindowsCommand` accepts `.cmd`, so the launcher has to be able
 * to run what it resolves.
 */
export function ghExec(
  args: string[],
  options?: { inheritStdio?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { stdout: string; stderr: string; status: number } {
  const ghPath = getGhPath();
  if (!ghPath) {
    throw new Error(
      'gh CLI not found. Install it from https://cli.github.com/ or set GITHUB_TOKEN environment variable.',
    );
  }

  log.debug(`gh exec: ${ghPath} ${args.join(' ')}`);

  if (options?.inheritStdio) {
    const result = crossSpawn.sync(ghPath, args, {
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return { stdout: '', stderr: '', status: result.status ?? 1 };
  }

  const result = crossSpawn.sync(ghPath, args, {
    env: { ...process.env, ...options?.env },
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: options?.cwd,
    ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
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

  // `gh auth login --web` inherits stdio and waits for a browser device flow.
  // Without a person at a terminal that is a job stuck until gh's deadline
  // (issue #711), so refuse up front and name the credential that would work.
  if (!isInteractive()) {
    throw new Error(
      'GitHub authentication unavailable without a terminal. ' +
        'Export GITHUB_TOKEN (or GH_TOKEN) with "repo" scope, ' +
        'or run `gh auth login` in an interactive shell first.',
    );
  }

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
 * HTTP Basic auth value for a GitHub token, passed to git as
 * `-c http.extraHeader=...` so the token never appears in the clone URL.
 * Mirrors the value clone.ts builds for its github clone path.
 */
function ghAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${encoded}`;
}

/** Local-config key under which the credential helper is persisted. */
const GH_HELPER_KEY = 'credential.https://github.com.helper';

/** Credential helper that resolves the token from the environment at run time. */
const GH_ENV_CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN:-$GH_TOKEN}"; }; f';

/**
 * The credential helper persisted into the clone so later `git push` / `git
 * pull` authenticate without the token being stored in `.git/config`.
 *
 * The helper is picked so that it resolves the SAME token ghGetOAuthToken()
 * used for the clone:
 *  - an env token is set → read that env var at run time, with the same
 *    precedence ghGetOAuthToken() applies (GITHUB_TOKEN before GH_TOKEN).
 *    `gh auth git-credential` is NOT equivalent here: gh reads GH_TOKEN first —
 *    the reverse order — so with both set the clone and the push right after it
 *    could authenticate as two different accounts.
 *  - no env token → the clone token came from gh's own login, so let `gh auth
 *    git-credential` resolve it at run time.
 * Either way only the command is persisted, never the token.
 */
function ghCredentialHelper(): string {
  return ghCredentialHelperFor(getGhPath(), Boolean(getGitHubToken()));
}

/**
 * The helper to persist given the resolved `gh` path and whether an env token is
 * set. Split out so the decision rule can be asserted in a unit test: reaching
 * the gh branch would otherwise require spawning a real `gh` (ghExec goes
 * through cross-spawn).
 *
 * The gh branch uses the ABSOLUTE path rather than a bare `gh`, and that is not
 * cosmetic: `resolveCliPath` falls back to `bash -lc` / `zsh -lc`, a LOGIN shell
 * that sources profiles, while git runs `!`-helpers through a non-login `sh -c`
 * that does not. A `gh` reachable only from a login shell (nvm, ~/.local/bin …)
 * therefore resolves at detection time and still fails the first push with
 * "gh: command not found". The quotes keep paths containing spaces intact.
 */
export function ghCredentialHelperFor(ghPath: string | null, hasEnvToken: boolean): string {
  if (hasEnvToken || !ghPath) return GH_ENV_CREDENTIAL_HELPER;
  return `!"${ghPath}" auth git-credential`;
}

/**
 * Strip anything that could carry the credential out of git's combined output
 * before it is embedded in an exception message.
 *
 * Two shapes matter:
 *  - a token embedded in a URL (`https://x-access-token:<token>@…`), matched
 *    generically in case a caller ever hands us such a URL;
 *  - the exact `Authorization: Basic <base64>` value passed via
 *    `-c http.extraHeader`. Git prints its own argv at start-up when a trace2
 *    sink is enabled (`GIT_TRACE2`, `GIT_TRACE2_EVENT`, `GIT_TRACE2_PERF`), so
 *    a failed clone echoes the whole `-c` argument back on stderr. Base64 is
 *    reversible, i.e. that is the token in disguise. (Plain `GIT_TRACE` does
 *    not print argv, and git redacts the header it sends on the wire — but the
 *    trace2 sinks do print argv, verified on git 2.x.)
 *
 * Redacting by VALUE rather than by pattern is deliberate: it covers the argv
 * form, the JSON `argv` array GIT_TRACE2_EVENT emits, and anything else git
 * may decide to print, without having to enumerate those shapes.
 */
export function redactCredential(output: string, token: string | null): string {
  let redacted = output.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
  if (token) {
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    redacted = redacted.split(encoded).join('***');
    redacted = redacted.split(token).join('***');
  }
  return redacted;
}

/** Run `git config --local …` in `cwd`. */
function gitConfigLocal(cwd: string, ...args: string[]) {
  return spawnSync('git', ['config', '--local', ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    windowsHide: true,
  });
}

/**
 * Clone a GitHub repo to localPath.
 *
 * The token is injected for the clone itself via `http.extraHeader` rather than
 * embedded in the URL, so it never reaches `remote.origin.url`: `git remote -v`,
 * `git config --list` and a copied `.git/config` all stay free of the token.
 *
 * A `-c` option applies to that one invocation only, so the credential source is
 * then persisted to the clone's local config as a credential helper — the
 * push/pull that `init` runs right after cloning then authenticate without the
 * token being stored anywhere on disk. Throws RepoNotFoundError when the remote
 * does not exist.
 */
export function ghRepoClone(repo: string, localPath: string): void {
  const token = ghGetOAuthToken();
  const cloneUrl = `https://github.com/${repo}.git`;

  // `-c <key>=<val>` is a git-level option, so it must precede `clone`.
  const args: string[] = [];
  if (token) {
    args.push('-c', `http.extraHeader=${ghAuthHeader(token)}`);
  }
  args.push('clone', cloneUrl, localPath);

  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
  });

  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (
    allOutput.includes('not found') ||
    allOutput.includes('does not exist') ||
    allOutput.includes('Repository not found')
  ) {
    throw new RepoNotFoundError(repo);
  }
  if (result.status !== 0) {
    const sanitized = redactCredential(allOutput, token);
    throw new Error(`git clone failed: ${sanitized.trim()}`);
  }

  // Persist the credential source into the clone: the `-c` above covered only
  // the clone itself, so without this the push/pull that follow would have no
  // credentials for a remote URL that (deliberately) carries none.
  //
  // `credential.helper` is multi-valued: git accumulates helpers from system,
  // global and local config and calls them in order, so a plain --local write
  // would only APPEND to a helper the user already has globally (Git Credential
  // Manager, say) — which would answer first and authenticate as the wrong
  // account. Reset the inherited list for github.com first (empty value), then
  // add ours: the same two steps `gh auth setup-git` performs. Scoped to
  // github.com so helpers configured for other hosts are left untouched.
  if (token) {
    const reset = gitConfigLocal(localPath, '--replace-all', GH_HELPER_KEY, '');
    const persisted =
      reset.status === 0
        ? gitConfigLocal(localPath, '--add', GH_HELPER_KEY, ghCredentialHelper())
        : reset;
    if (persisted.status !== 0) {
      log.warn(
        `Could not persist the GitHub credential helper: ${(persisted.stderr ?? '').trim()}. Push/pull may prompt for credentials.`,
      );
    }
  }
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
  /** Hard timeout (ms) for the `gh pr create` subprocess; kills it at the OS
   * level once exceeded. spawnSync blocks the event loop, so withTimeout cannot
   * interrupt it — this is the only way to bound a stalled PR creation. */
  spawnTimeoutMs?: number;
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

  const result = ghExec(args, { cwd: opts.cwd, ...(opts.spawnTimeoutMs ? { timeoutMs: opts.spawnTimeoutMs } : {}) });
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
