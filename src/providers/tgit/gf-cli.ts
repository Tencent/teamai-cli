import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathExists, ensureDir } from '../../utils/fs.js';
import { log, spinner } from '../../utils/logger.js';
import { TEAMAI_HOME } from '../../types.js';

/** Path where gf CLI is installed */
const GF_INSTALL_DIR = path.join(TEAMAI_HOME, 'gf');
const GF_BIN_PATH = path.join(GF_INSTALL_DIR, 'gf', 'bin', 'gf');

/** Download base URL for gf CLI tarballs */
const GF_DOWNLOAD_BASE = 'http://mirrors.tencent.com/repository/generic/gongfeng-cli/files/channels/stable';

// ─── Shell helpers ───────────────────────────────────────

/**
 * Shell-quote a string using single quotes.
 * Preserves literal newlines, spaces, and special characters.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── Core helpers ────────────────────────────────────────

/**
 * Execute a gf CLI command.
 * gf launcher is a bash script, so we wrap with `bash -c` for compatibility.
 * Returns { stdout, stderr, status }.
 */
export function gfExec(
  args: string[],
  options?: { inheritStdio?: boolean; cwd?: string },
): { stdout: string; stderr: string; status: number } {
  const gfPath = getGfPath();
  // Shell-quote every token (including the binary path) so values such as repo
  // paths, branch names, titles, and descriptions cannot inject shell
  // metacharacters (`;`, `|`, `$()`, …) into the `bash -c` string. Callers pass
  // raw values; quoting centrally here keeps every entry point safe.
  const cmd = [shellQuote(gfPath), ...args.map(shellQuote)].join(' ');
  log.debug(`gf exec: ${cmd}`);

  if (options?.inheritStdio) {
    const result = spawnSync('bash', ['-c', cmd], {
      stdio: 'inherit',
      env: { ...process.env },
      cwd: options.cwd,
    });
    return { stdout: '', stderr: '', status: result.status ?? 1 };
  }

  const result = spawnSync('bash', ['-c', cmd], {
    env: { ...process.env },
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

/**
 * Get the path to gf binary (installed location or system PATH).
 */
function getGfPath(): string {
  // Prefer our managed install
  try {
    const stat = execSync(`test -x "${GF_BIN_PATH}" && echo ok`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (stat.trim() === 'ok') return GF_BIN_PATH;
  } catch {
    // not installed locally
  }

  // Fall back to system PATH
  try {
    const which = execSync('which gf', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (which.trim()) return which.trim();
  } catch {
    // not in PATH
  }

  throw new Error(
    'gf CLI not found. Run `teamai init` to install it automatically.',
  );
}

// ─── Installation ────────────────────────────────────────

/**
 * Detect the download URL for the current platform.
 */
function getGfDownloadUrl(): string {
  const arch = os.arch(); // 'x64', 'arm64', etc.
  const platform = os.platform(); // 'darwin', 'linux'

  let osName: string;
  if (platform === 'darwin') {
    osName = 'darwin';
  } else if (platform === 'linux') {
    osName = 'linux';
  } else {
    throw new Error(`Unsupported platform: ${platform}. gf CLI only supports macOS and Linux.`);
  }

  let archName: string;
  if (arch === 'x64') {
    archName = 'x64';
  } else if (arch === 'arm64') {
    archName = 'arm64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}. gf CLI only supports x64 and arm64.`);
  }

  return `${GF_DOWNLOAD_BASE}/gf-${osName}-${archName}.tar.gz`;
}

/**
 * Check if gf is installed (either locally or in PATH). Returns true if available.
 */
export function isGfInstalled(): boolean {
  try {
    getGfPath();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure gf CLI is installed. Downloads to ~/.teamai/gf/ if not found.
 */
export async function ensureGfInstalled(): Promise<void> {
  if (isGfInstalled()) {
    log.debug('gf CLI already installed');
    return;
  }

  const url = getGfDownloadUrl();
  const spin = spinner('Installing gf CLI (工蜂命令行工具)...').start();

  try {
    await ensureDir(GF_INSTALL_DIR);

    // Download and extract tarball
    execSync(
      `curl -fsSL "${url}" | tar xz -C "${GF_INSTALL_DIR}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 },
    );

    // Verify installation
    execSync(`test -x "${GF_BIN_PATH}"`, { stdio: ['pipe', 'pipe', 'pipe'] });

    spin.succeed(`gf CLI installed to ${GF_INSTALL_DIR}`);
  } catch (e) {
    spin.fail(`Failed to install gf CLI: ${(e as Error).message}`);
    log.info(`You can install it manually from: ${url}`);
    log.info(`Extract to: ${GF_INSTALL_DIR}`);
    throw e;
  }
}

// ─── Authentication ──────────────────────────────────────

/**
 * Check if gf is authenticated. Returns true if `gf auth whoami` succeeds.
 */
export function gfIsAuthenticated(): boolean {
  try {
    const result = gfExec(['auth', 'whoami']);
    return result.status === 0 && result.stdout.includes('当前登录用户');
  } catch {
    return false;
  }
}

/**
 * Get the current authenticated username from `gf auth whoami`.
 * Output format: "当前登录用户：<username>"
 */
export function gfAuthWhoami(): string | null {
  try {
    const result = gfExec(['auth', 'whoami']);
    if (result.status !== 0) return null;

    // Parse "当前登录用户：<username>" or similar
    const output = result.stdout;
    const match = output.match(/当前登录用户[：:]\s*(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `gf auth login` interactively (inherits stdio for user interaction).
 * Supports iOA, browser device code flow, and manual token input.
 */
export function gfAuthLogin(): void {
  log.info('Starting gf authentication...');
  const result = gfExec(['auth', 'login'], { inheritStdio: true });
  if (result.status !== 0) {
    throw new Error('gf auth login failed. Please try again.');
  }
}

/**
 * Ensure user is authenticated. Checks whoami, triggers login if needed.
 * Returns the authenticated username.
 */
export function ensureAuthenticated(): string {
  // First check if already authenticated
  const username = gfAuthWhoami();
  if (username) {
    return username;
  }

  // Not authenticated — trigger interactive login
  gfAuthLogin();

  // Verify login succeeded
  const verifiedUsername = gfAuthWhoami();
  if (!verifiedUsername) {
    throw new Error('Authentication failed. Please run `teamai init` again.');
  }
  return verifiedUsername;
}

// ─── Repo operations ─────────────────────────────────────

/**
 * Retrieve the OAuth token that gf stored in ~/.netrc.
 *
 * gf CLI uses the netrc-parser library to persist tokens.  The entry
 * for git.woa.com looks like:
 *   machine git.woa.com login <user> password <token> ...
 *
 * We parse the file directly instead of relying on `git credential fill`,
 * which depends on a working git credential helper and may trigger
 * interactive password prompts.
 *
 * Returns null if no credential is found.
 */
export function gfGetOAuthToken(): string | null {
  try {
    const netrcPath = path.join(os.homedir(), '.netrc');
    if (!fs.existsSync(netrcPath)) return null;

    const content = fs.readFileSync(netrcPath, 'utf-8');
    // Match: machine git.woa.com ... password <TOKEN>
    const match = content.match(
      /machine\s+git\.woa\.com\s+.*?password\s+(\S+)/,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Create a repo on TGit using the REST API.
 * Uses the OAuth token from gf's credential store with Bearer auth.
 */
export async function gfCreateRepo(owner: string, repo: string): Promise<void> {
  const token = gfGetOAuthToken();
  if (!token) {
    throw new Error('Cannot retrieve OAuth token. Please run `gf auth login` first.');
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // Look up namespace ID for the owner (group or user).
  // For multi-segment paths like "HyperAI/ElasticLLM", the API's `path` field
  // only contains the last segment ("ElasticLLM"), so we search by the last
  // segment and match against `full_path` which includes parent groups.
  const searchTerm = owner.includes('/') ? owner.split('/').pop()! : owner;
  const nsResp = await fetch(
    `https://git.woa.com/api/v3/namespaces?search=${encodeURIComponent(searchTerm)}`,
    { headers: authHeaders },
  );
  if (!nsResp.ok) {
    throw new Error(`Failed to look up namespace "${owner}": ${nsResp.status}`);
  }
  const namespaces = (await nsResp.json()) as Array<{ id: number; path: string; full_path?: string }>;
  const ns = namespaces.find(
    (n) => (n.full_path ?? n.path).toLowerCase() === owner.toLowerCase(),
  );

  const body: Record<string, unknown> = { name: repo };
  if (ns) {
    body.namespace_id = ns.id;
  }

  const createResp = await fetch(
    'https://git.woa.com/api/v3/projects',
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    },
  );
  if (!createResp.ok) {
    const errBody = await createResp.text().catch(() => '');
    throw new Error(`Failed to create repo: ${createResp.status} ${errBody}`);
  }
}

/** Error subclass indicating the remote repo was not found. */
export class RepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on TGit.`);
    this.name = 'RepoNotFoundError';
  }
}

/**
 * Clone a repo using `gf repo clone`.
 * The remote URL will have the OAuth token embedded, so subsequent
 * git pull/push via simple-git will work without extra auth.
 *
 * For multi-segment group paths (e.g. "group/subgroup/repo"), `gf repo clone`
 * does not work — it only accepts two-segment "namespace/repo" format.
 * In that case we fall back to `git clone` with the OAuth token embedded in the URL.
 *
 * Throws RepoNotFoundError when the remote repo does not exist.
 */
export function gfRepoClone(repo: string, localPath: string): void {
  const segments = repo.split('/');

  // Multi-segment path: gf repo clone only supports "namespace/repo"
  if (segments.length > 2) {
    const token = gfGetOAuthToken();
    if (!token) {
      throw new Error('Cannot retrieve OAuth token for git clone. Please run `gf auth login` first.');
    }
    const cloneUrl = `https://oauth2:${token}@git.woa.com/${repo}.git`;
    const result = spawnSync('git', ['clone', cloneUrl, localPath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
    if (allOutput.includes('not found') || allOutput.includes('does not exist') || allOutput.includes('Repository not found')) {
      throw new RepoNotFoundError(repo);
    }
    if (result.status !== 0) {
      // Sanitize output to avoid leaking the token
      const sanitized = allOutput.replace(/oauth2:[^@]+@/g, 'oauth2:***@');
      throw new Error(`git clone failed: ${sanitized.trim()}`);
    }
    return;
  }

  const result = gfExec(['repo', 'clone', repo, localPath]);
  const allOutput = `${result.stderr} ${result.stdout}`;
  // Only match gf's own "not found" message, not git's object stats (e.g. "reused 404")
  if (allOutput.includes('未在工蜂找到') || allOutput.includes('不存在')) {
    throw new RepoNotFoundError(repo);
  }
  if (result.status !== 0) {
    throw new Error(`gf repo clone failed: ${result.stderr || result.stdout}`);
  }
}

// ─── Merge Request ───────────────────────────────────────

export interface GfMrCreateOptions {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (usually 'master') */
  target: string;
  /** MR title */
  title: string;
  /** MR description */
  description?: string;
  /** Reviewer usernames (gf accepts usernames directly, no ID lookup needed) */
  reviewers?: string[];
  /** Working directory for gf CLI (should be the team repo path) */
  cwd?: string;
}

/**
 * Create a Merge Request using `gf mr create`.
 * Returns the MR web URL on success.
 */
export function gfMrCreate(opts: GfMrCreateOptions): string {
  const args = [
    'mr', 'create',
    '-R', opts.repo,
    '-s', opts.source,
    '-T', opts.target,
    '-t', opts.title,
  ];

  if (opts.description) {
    args.push('-d', opts.description);
  }

  if (opts.reviewers && opts.reviewers.length > 0) {
    args.push('-r', opts.reviewers.join(','));
  }

  const result = gfExec(args, { cwd: opts.cwd });
  if (result.status !== 0) {
    const errMsg = result.stderr || result.stdout;
    throw new Error(`gf mr create failed: ${errMsg}`);
  }

  // Try to extract MR URL from output
  const output = result.stdout;
  const urlMatch = output.match(/https:\/\/git\.woa\.com\/[^\s]+merge_requests\/\d+/);
  if (urlMatch) {
    return urlMatch[0];
  }

  // Fallback: construct URL from repo and try to find MR number
  const mrNumMatch = output.match(/!(\d+)/);
  if (mrNumMatch) {
    return `https://git.woa.com/${opts.repo}/-/merge_requests/${mrNumMatch[1]}`;
  }

  // Could not extract MR URL — treat as failure
  throw new Error(`gf mr create succeeded but returned unexpected output: ${output}`);
}
