import { execSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from '../../utils/fs.js';
import { getUserHome, legacyUserHome } from '../../utils/home.js';
import { log, spinner } from '../../utils/logger.js';
import { isInteractive } from '../../utils/prompt.js';
import { getTeamaiHomeDir } from '../../types.js';
import { z } from 'zod';
import type { PullRequestRef } from '../types.js';
import { tgitFetch, tgitGitCloneUrl } from './rest-auth.js';
import { TGIT_HOST } from './repo-url.js';

/** Path where gf CLI is installed */
function gfInstallDir(): string {
  return path.join(getTeamaiHomeDir(), 'gf');
}
function gfBinPath(): string {
  return path.join(gfInstallDir(), 'gf', 'bin', 'gf');
}

/** Download base URL for gf CLI tarballs (HTTPS so the binary is fetched over TLS) */
const GF_DOWNLOAD_BASE = 'https://mirrors.tencent.com/repository/generic/gongfeng-cli/files/channels/stable';

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
  options?: { inheritStdio?: boolean; cwd?: string; timeoutMs?: number },
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
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return { stdout: '', stderr: '', status: result.status ?? 1 };
  }

  const result = spawnSync('bash', ['-c', cmd], {
    env: { ...process.env },
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

/**
 * Get the path to gf binary (installed location or system PATH).
 */
function getGfPath(): string {
  // Prefer our managed install
  try {
    const stat = execSync(`test -x "${gfBinPath()}" && echo ok`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (stat.trim() === 'ok') return gfBinPath();
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
 * Extract the expected SHA-256 from dumped HTTP response headers.
 *
 * The mirror answers a GET with a 302 to a BkRepo/COS backend whose object key
 * IS the artifact's SHA-256 (e.g. `location: https://…cos…/<sha256>?…`), and
 * that backend does not echo an `x-checksum-sha256` header. So we read the
 * digest from the redirect URL first, and fall back to the `x-checksum-sha256`
 * header for the case where the mirror serves the file directly (no redirect).
 * Returns null when neither is present.
 */
function parseExpectedSha256(headerText: string): string | null {
  // Content-addressed redirect target: last 64-hex token on any `location:` line.
  for (const line of headerText.split(/\r?\n/)) {
    if (/^location:/i.test(line)) {
      const hashes = line.match(/[0-9a-f]{64}/gi);
      if (hashes?.length) return hashes[hashes.length - 1].toLowerCase();
    }
  }
  // Direct-serve fallback: explicit checksum header.
  const header = headerText.match(/^x-checksum-sha256:\s*([0-9a-f]{64})\s*$/im);
  return header?.[1]?.toLowerCase() ?? null;
}

/**
 * Ensure gf CLI is installed. Downloads to ~/.teamai/gf/ if not found.
 *
 * The tarball is fetched over HTTPS to a temp file first (not piped straight
 * into tar), its SHA-256 is checked against the mirror's `x-checksum-sha256`
 * header, and only then is it extracted — so a truncated or corrupted download
 * is rejected before any bytes reach the archive extractor.
 */
export async function ensureGfInstalled(): Promise<void> {
  if (isGfInstalled()) {
    log.debug('gf CLI already installed');
    return;
  }

  const url = getGfDownloadUrl();
  const dir = gfInstallDir();
  // Unique temp names per attempt so concurrent installs cannot overwrite or
  // delete each other's download before it is hashed and extracted.
  const tmpId = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const tarballPath = path.join(dir, `gf-download.${tmpId}.tar.gz`);
  const headerPath = path.join(dir, `gf-download.${tmpId}.headers`);
  const spin = (await spinner('Installing gf CLI (工蜂命令行工具)...')).start();

  try {
    await ensureDir(dir);

    // Download the tarball to a temp file (over HTTPS), dumping response
    // headers so we can verify integrity before touching tar.
    execSync(
      `curl -fsSL -D "${headerPath}" -o "${tarballPath}" "${url}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 },
    );

    // Verify SHA-256 against the mirror's advertised digest (the content-
    // addressed redirect target, or the x-checksum-sha256 header). Fail closed:
    // if we cannot obtain an expected digest, we cannot vouch for the binary —
    // abort rather than extract and execute an unverified archive.
    const expected = parseExpectedSha256(fs.readFileSync(headerPath, 'utf-8'));
    if (!expected) {
      throw new Error(
        'gf CLI download integrity check failed (mirror advertised no SHA-256 digest)',
      );
    }
    const actual = createHash('sha256')
      .update(fs.readFileSync(tarballPath))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(
        `gf CLI download integrity check failed (sha256 mismatch: expected ${expected}, got ${actual})`,
      );
    }

    // Extract the verified tarball.
    execSync(`tar xz -f "${tarballPath}" -C "${dir}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Verify installation
    execSync(`test -x "${gfBinPath()}"`, { stdio: ['pipe', 'pipe', 'pipe'] });

    spin.succeed(`gf CLI installed to ${dir}`);
  } catch (e) {
    spin.fail(`Failed to install gf CLI: ${(e as Error).message}`);
    log.info(`You can install it manually from: ${url}`);
    log.info(`Extract to: ${dir}`);
    throw e;
  } finally {
    // Clean up temp files regardless of success/failure.
    try {
      fs.rmSync(tarballPath, { force: true });
      fs.rmSync(headerPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ─── Authentication ──────────────────────────────────────

/**
 * A neutral working directory for `gf auth` commands.
 *
 * `gf auth whoami` / `gf auth login` inspect the *current* git repository's
 * `origin` remote and scope the authentication check to that remote's host.
 * When teamai runs inside a repo whose origin is not git.woa.com (e.g. a GitHub
 * mirror), gf reports "not logged in" even though a valid git.woa.com token
 * exists — so teamai wrongly re-triggers interactive login and fails.
 *
 * Running these commands from the system temp dir (which is not a git repo)
 * removes the cwd dependency, so the host-scoped credential is found reliably
 * regardless of where teamai was invoked.
 */
const AUTH_CWD = os.tmpdir();

/**
 * Check if gf is authenticated. Returns true if `gf auth whoami` succeeds.
 */
export function gfIsAuthenticated(): boolean {
  try {
    const result = gfExec(['auth', 'whoami'], { cwd: AUTH_CWD });
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
    const result = gfExec(['auth', 'whoami'], { cwd: AUTH_CWD });
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
  const result = gfExec(['auth', 'login'], { inheritStdio: true, cwd: AUTH_CWD });
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

  // `gf auth login` inherits stdio and waits for iOA / a browser device flow.
  // Without a person at a terminal that never completes (issue #711).
  //
  // Unlike the other providers there is no token to name here: a `TGIT_TOKEN`
  // PAT is REST-API-only, and git.woa.com's git endpoint rejects it in every
  // form (see {@link tgitGitCloneUrl}), so it can neither satisfy this check nor
  // clone. The only credential that works is the one `gf auth login` stores.
  if (!isInteractive()) {
    throw new Error(
      'TGit authentication unavailable without a terminal. ' +
        'Run `gf auth login` in an interactive shell first — this machine then ' +
        'reuses the credential it stores (TGIT_TOKEN is REST-API-only and ' +
        'cannot clone).',
    );
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
  // `gf` wrote this file when `~` still resolved to `os.homedir()`, so a user
  // whose HOME points elsewhere keeps working after the upgrade: read the
  // current location first, then the legacy one.
  let candidates: string[];
  try {
    candidates = [path.join(getUserHome(), '.netrc')];
    const legacy = legacyUserHome();
    if (legacy) candidates.push(path.join(legacy, '.netrc'));
  } catch {
    return null;
  }

  for (const netrcPath of candidates) {
    try {
      // `existsSync` first, as this reader has always done: it keeps the
      // "no ~/.netrc" case a cheap no-op rather than a thrown ENOENT. A file
      // that exists but cannot be read still falls through to the next
      // candidate via the `catch`.
      if (!fs.existsSync(netrcPath)) continue;
      const content = fs.readFileSync(netrcPath, 'utf-8');
      // Match: machine git.woa.com ... password <TOKEN>
      const match = content.match(
        /machine\s+git\.woa\.com\s+.*?password\s+(\S+)/,
      );
      if (match?.[1]) return match[1];
    } catch {
      // Missing or unreadable here — try the next location.
    }
  }
  return null;
}

/**
 * Create a repo on TGit using the REST API.
 * Authentication (token + scheme) is handled by {@link tgitFetch}.
 */
export async function gfCreateRepo(owner: string, repo: string): Promise<void> {
  // Look up namespace ID for the owner (group or user).
  // For multi-segment paths like "HyperAI/ElasticLLM", the API's `path` field
  // only contains the last segment ("ElasticLLM"), so we search by the last
  // segment and match against `full_path` which includes parent groups.
  const searchTerm = owner.includes('/') ? owner.split('/').pop()! : owner;
  const nsResp = await tgitFetch(`/namespaces?search=${encodeURIComponent(searchTerm)}`);
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

  const createResp = await tgitFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

/** True when `git clone` output indicates the remote repo does not exist. */
function gitOutputSaysRepoMissing(output: string): boolean {
  return output.includes('not found')
    || output.includes('does not exist')
    || output.includes('Repository not found');
}

/**
 * Clone a repo from git.woa.com.
 *
 * When an OAuth credential is available (from `gf auth login`), clone via
 * `git clone` with the token embedded as `oauth2:<token>@`. A `TGIT_TOKEN` PAT
 * is intentionally NOT used here: it is REST-API-only and git.woa.com's git
 * endpoint rejects it (see {@link tgitGitCloneUrl}). This path handles both
 * two-segment and multi-segment group paths uniformly.
 *
 * When no OAuth credential is available, fall back to `gf repo clone` (the
 * interactive/user path, which relies on gf's own stored auth).
 *
 * Throws RepoNotFoundError when the remote repo does not exist.
 */
export function gfRepoClone(repo: string, localPath: string): void {
  const cloneUrl = tgitGitCloneUrl(`https://git.woa.com/${repo}.git`);
  if (cloneUrl) {
    const result = spawnSync('git', ['clone', cloneUrl, localPath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      windowsHide: true,
    });
    const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
    if (gitOutputSaysRepoMissing(allOutput)) {
      throw new RepoNotFoundError(repo);
    }
    if (result.status !== 0) {
      // Sanitize output to avoid leaking the token
      const sanitized = allOutput.replace(/oauth2:[^@]+@/g, 'oauth2:***@');
      throw new Error(`git clone failed: ${sanitized.trim()}`);
    }
    return;
  }

  // No OAuth credential → fall back to `gf repo clone` (interactive/user path).
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
  /** Hard timeout (ms) for the `gf mr create` subprocess; kills it at the OS
   * level once exceeded. spawnSync blocks the event loop, so withTimeout cannot
   * interrupt it — this bounds a stalled MR creation. */
  spawnTimeoutMs?: number;
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

  const result = gfExec(args, { cwd: opts.cwd, ...(opts.spawnTimeoutMs ? { timeoutMs: opts.spawnTimeoutMs } : {}) });
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

// ─── Open merge request lookup ───────────────────────────

const LOOKUP_PAGE = 100;

const TGitOpenMrSchema = z.object({
  web_url: z.string(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number(),
  target_project_id: z.number(),
});

/**
 * The open merge request from `source` into `target` in project `repo`, asked of the git.woa.com REST API with the
 * credential `tgitFetch` resolves; a reopened request is open too. A request from a fork with the same branch name is
 * not it. Never prompts, and throws, rather than answering none, when TGit cannot be asked or answers in time, answers
 * what this cannot read, fills a whole page without it, or names a request on another host.
 */
export async function tgitFindOpenMr({ repo, source, target, timeoutMs }: PullRequestRef): Promise<string | undefined> {
  const query = new URLSearchParams({ state: 'opened', source_branch: source, target_branch: target, per_page: String(LOOKUP_PAGE) });
  const response = await tgitFetch(`/projects/${encodeURIComponent(repo)}/merge_requests?${query}`, {
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`TGit answered the open merge request lookup with HTTP ${response.status}. Check TGIT_TOKEN or the gf login and their access to the project.`);
  const requests = z.array(TGitOpenMrSchema).safeParse(await response.json().catch(() => undefined));
  if (!requests.success) throw new Error('TGit answered the open merge request lookup with data TeamAI cannot read.');
  const found = requests.data.find((mr) => (mr.state === 'opened' || mr.state === 'reopened') && mr.source_branch === source
    && mr.target_branch === target && mr.source_project_id === mr.target_project_id);
  if (!found) {
    if (requests.data.length >= LOOKUP_PAGE) throw new Error('TGit listed more open merge requests than one page, so TeamAI cannot tell whether this branch has one.');
    return undefined;
  }
  if (!found.web_url.startsWith(`https://${TGIT_HOST}/`)) throw new Error('TGit answered the open merge request lookup with a URL on another host.');
  return found.web_url;
}
