import { execSync, spawnSync } from 'node:child_process';
import { log, spinner } from '../../utils/logger.js';
import type { RepoInfo } from '../types.js';

/**
 * Thin wrapper around the CNB (cnb.cool) OpenAPI CLI — `@cnbcool/cnb-cli`.
 *
 * Mirrors the shape of tgit/gf-cli.ts: delegate auth + repo + PR operations to
 * the platform's own CLI. CNB's CLI is a plain binary (not a bash launcher), so
 * we invoke it via spawnSync with an args array — no shell, so repo paths /
 * branch names / titles cannot inject shell metacharacters.
 *
 * Auth has two paths, matching how the GitHub provider treats GITHUB_TOKEN:
 *   - Interactive (dev laptop): `cnb login` (OAuth2 device flow) stores a token;
 *     `cnb git-credential` then serves it to git.
 *   - Headless (CI): a `CNB_TOKEN` env var is honored directly, so no login step.
 */

/**
 * Git host for CNB repos. Defaults to the public community platform, cnb.cool —
 * the only host this provider is tested against. `TEAMAI_CNB_HOST` overrides it
 * for a self-hosted / enterprise CNB deployment (e.g. an internal instance); such
 * setups must also point the `cnb` CLI at their own API via `CNB_API_ENDPOINT`
 * (see @cnbcool/cnb-cli), which this wrapper does not manage.
 */
export const CNB_HOST = process.env.TEAMAI_CNB_HOST?.trim() || 'cnb.cool';

// ─── Core exec ───────────────────────────────────────────

/** Run a `cnb` subcommand. Returns { stdout, stderr, status }. */
export function cnbExec(
  args: string[],
  options?: { inheritStdio?: boolean; cwd?: string },
): { stdout: string; stderr: string; status: number } {
  log.debug(`cnb exec: cnb ${args.join(' ')}`);
  if (options?.inheritStdio) {
    const r = spawnSync('cnb', args, { stdio: 'inherit', env: { ...process.env }, cwd: options.cwd });
    return { stdout: '', stderr: '', status: r.status ?? 1 };
  }
  const r = spawnSync('cnb', args, {
    env: { ...process.env },
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: options?.cwd,
  });
  return {
    stdout: (r.stdout ?? '').toString().trim(),
    stderr: (r.stderr ?? '').toString().trim(),
    status: r.status ?? 1,
  };
}

/**
 * The `cnb` CLI exits 0 even when the API returns a 4xx/5xx — it just prints the
 * status in the response body. So a non-zero CLI exit is not enough; we also
 * scan the printed `status:` and throw on an error code. Without this, failures
 * (e.g. a 412 "cannot delete via Open API") would look like success.
 */
export function assertCnbApiOk(out: string, action: string): void {
  const m = out.match(/(?:^|["\s])status["\s:]+\s*(\d{3})\b/);
  if (!m) return; // no HTTP status in output — nothing to assert
  const code = Number(m[1]);
  if (code >= 400) {
    const em = out.match(/errmsg["\s:]+\s*"?([^"\n]+)/i);
    throw new Error(`cnb ${action} failed (HTTP ${code})${em ? `: ${em[1].trim()}` : ''}`);
  }
}

// ─── Installation ────────────────────────────────────────

export function isCnbInstalled(): boolean {
  try {
    execSync('which cnb', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Ensure the CNB CLI is available; install globally via npm if missing. */
export async function ensureCnbInstalled(): Promise<void> {
  if (isCnbInstalled()) {
    log.debug('cnb CLI already installed');
    return;
  }
  const spin = spinner('Installing cnb CLI (@cnbcool/cnb-cli)...').start();
  try {
    execSync('npm install -g @cnbcool/cnb-cli', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    if (!isCnbInstalled()) throw new Error('cnb not found on PATH after install');
    spin.succeed('cnb CLI installed');
  } catch (e) {
    spin.fail(`Failed to install cnb CLI: ${(e as Error).message}`);
    log.info('Install it manually: npm install -g @cnbcool/cnb-cli');
    throw e;
  }
}

// ─── Authentication ──────────────────────────────────────

/**
 * Read a non-interactive access token from the environment (CI path).
 * Parallels the GitHub provider's GITHUB_TOKEN / GH_TOKEN handling.
 */
export function getCnbToken(): string | null {
  return process.env.CNB_TOKEN ?? process.env.CNB_ACCESS_TOKEN ?? null;
}

/** Authenticated if an env token is present, or `cnb status` reports logged-in. */
export function cnbIsAuthenticated(): boolean {
  if (getCnbToken()) return true;
  try {
    const r = cnbExec(['status']);
    return r.status === 0 && (r.stdout.includes('已登录') || /logged\s*in/i.test(r.stdout));
  } catch {
    return false;
  }
}

/**
 * Current *account* username. Prefer the API (the real account, e.g. "eyre"):
 * the `cnb` CLI prints YAML, and CNB_USERNAME is often just the git-credential
 * placeholder ("cnb"), so we parse `username:` out of the response and only fall
 * back to the env var as a last resort. Returns null when undeterminable.
 */
export function cnbWhoami(): string | null {
  try {
    const r = cnbExec(['users', 'get-user-info']);
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/(?:^|\n)\s*(?:username|login)\s*:\s*"?([^\s"]+)/i);
      if (m) return m[1];
    }
  } catch {
    // fall through to env
  }
  return process.env.CNB_USERNAME?.trim() || null;
}

/** Trigger the interactive OAuth2 device-flow login. */
export function cnbLogin(): void {
  log.info('Starting cnb authentication (OAuth2 device flow)...');
  const r = cnbExec(['login'], { inheritStdio: true });
  if (r.status !== 0) throw new Error('cnb login failed. Please try again.');
}

/** Ensure authenticated; trigger login if needed. Returns the username. */
export function ensureCnbAuthenticated(): string {
  if (cnbIsAuthenticated()) {
    const u = cnbWhoami();
    if (u) return u;
  }
  cnbLogin();
  const u = cnbWhoami();
  if (!u) throw new Error('CNB authentication failed. Please run `teamai init` again.');
  return u;
}

// ─── Repo operations ─────────────────────────────────────

export class CnbRepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on CNB.`);
    this.name = 'CnbRepoNotFoundError';
  }
}

/** Parse a CNB repo URL or bare `owner/repo` (owner may be a nested group path). */
export function cnbParseRepoInput(input: string): RepoInfo {
  const s = input.trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^git@[^:]+:/i, '')
    .replace(/\/+$/, '') // drop trailing slash(es) first, so `.git` below still anchors
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const segs = s.split('/').filter(Boolean);
  if (segs.length < 2) {
    throw new Error(`Invalid CNB repo: "${input}" (expected owner/repo or a cnb.cool URL)`);
  }
  const repo = segs[segs.length - 1];
  const owner = segs.slice(0, -1).join('/');
  const full = `${owner}/${repo}`;
  return {
    owner,
    repo,
    httpsUrl: `https://${CNB_HOST}/${full}.git`,
    projectId: encodeURIComponent(full),
  };
}

/**
 * Clone via git. With a CNB_TOKEN we embed Basic creds in the URL (CI path);
 * otherwise we let git call `cnb git-credential` (interactive-login path).
 */
export function cnbRepoClone(repo: string, localPath: string): void {
  const token = getCnbToken();
  let args: string[];
  if (token) {
    const url = `https://cnb:${token}@${CNB_HOST}/${repo}.git`;
    args = ['clone', url, localPath];
  } else {
    args = ['-c', 'credential.helper=!cnb git-credential', 'clone', `https://${CNB_HOST}/${repo}.git`, localPath];
  }
  const r = spawnSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
  const out = `${r.stderr ?? ''} ${r.stdout ?? ''}`;
  if (/not found|does not exist|Repository not found|404/i.test(out)) {
    throw new CnbRepoNotFoundError(repo);
  }
  if (r.status !== 0) {
    const sanitized = out.replace(/cnb:[^@]+@/g, 'cnb:***@').trim();
    throw new Error(`git clone failed: ${sanitized}`);
  }
}

/** Create a repo: `cnb repositories create-repo --slug <owner> --name <repo>`. */
export async function cnbCreateRepo(owner: string, repo: string): Promise<void> {
  const r = cnbExec(['repositories', 'create-repo', '--slug', owner, '--name', repo]);
  if (r.status !== 0) {
    throw new Error(`cnb create-repo failed: ${r.stderr || r.stdout}`);
  }
  assertCnbApiOk(r.stdout, 'create-repo');
}

// ─── Pull requests ───────────────────────────────────────

export interface CnbPullCreateOptions {
  repo: string;
  source: string;
  target: string;
  title: string;
  description?: string;
  cwd?: string;
}

/**
 * Create a pull request: `cnb pulls post-pull`. Returns the PR web URL.
 * Parses the CLI's JSON response; falls back to constructing the URL from the
 * PR number. (Exact response fields/URL path should be confirmed against a live
 * CNB instance.)
 */
export function cnbPullCreate(opts: CnbPullCreateOptions): string {
  const args = [
    'pulls', 'post-pull',
    '--repo', opts.repo,
    '--head', opts.source,
    '--base', opts.target,
    '--title', opts.title,
  ];
  if (opts.description) args.push('--body', opts.description);

  const r = cnbExec(args, { cwd: opts.cwd });
  if (r.status !== 0) {
    throw new Error(`cnb post-pull failed: ${r.stderr || r.stdout}`);
  }
  assertCnbApiOk(r.stdout, 'post-pull');

  // The CLI prints YAML (not JSON), so parse defensively with regexes: prefer a
  // URL in the response, else build one from the PR number.
  const out = r.stdout;
  const urlMatch = out.match(/https?:\/\/[^\s"']+\/(?:pull|pulls|merge_requests)\/\d+/i)
    ?? out.match(/(?:^|\n)\s*(?:url|web_url|html_url)\s*:\s*"?(https?:\/\/[^\s"']+)/i);
  if (urlMatch) return urlMatch[urlMatch.length - 1];
  const numMatch = out.match(/(?:^|\n)\s*(?:number|iid)\s*:\s*"?(\d+)/i);
  if (numMatch) return `https://${CNB_HOST}/${opts.repo}/-/pulls/${numMatch[1]}`;
  throw new Error(`cnb post-pull succeeded but returned unexpected output: ${out}`);
}
