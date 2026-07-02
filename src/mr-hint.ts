import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { gfGetOAuthToken } from './providers/tgit/gf-cli.js';
import { log } from './utils/logger.js';

// ─── MR Hint data flow ──────────────────────────────────
//
//  SessionStart hook
//      │
//      ▼
//  teamai mr-hint --stdin
//      │
//      ├─ Read STDIN { session_id }
//      ├─ getGitRemote(CWD) → remote URL
//      ├─ parseRemoteToRepo(url) → { provider, owner, repo }
//      ├─ listMergedMRs(provider, owner, repo, since)
//      │   ├─ TGit: REST API /api/v3/projects/:id/merge_requests
//      │   └─ GitHub: gh pr list --state merged --json
//      ├─ filter by hint cache (avoid re-hinting same MR)
//      └─ Has new MRs? → STDOUT JSON { hookSpecificOutput.additionalContext }
//

/** Days to look back for merged MRs. */
const LOOKBACK_DAYS = 7;

/** Max MRs to list per session. */
const MAX_MRS = 10;

/** Cache TTL: 30 days. After this, cache is cleared. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────

/** Minimal MR summary used for hint. */
export interface MRSummary {
  /** Provider-specific MR/PR identifier (iid for TGit, number for GitHub). */
  id: string;
  /** MR title. */
  title: string;
  /** MR web URL. */
  url: string;
  /** ISO 8601 merged timestamp. */
  mergedAt: string;
}

/** Persisted cache for a repo. */
interface HintCache {
  /** MR IDs that have already been hinted. */
  hintedMrIds: string[];
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
}

// ─── Cache helpers ───────────────────────────────────────

/**
 * Derive a filesystem-safe slug from a repo path.
 *
 * @param owner  Repository owner / group (may contain '/')
 * @param repo   Repository name
 * @returns      Slug safe for use in filenames
 */
function repoSlug(owner: string, repo: string): string {
  return `${owner}/${repo}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build cache file path: ~/.teamai/sessions/mr-hint-<slug>.json
 */
function getCachePath(owner: string, repo: string): string {
  return path.join(
    process.env.HOME ?? '',
    '.teamai',
    'sessions',
    `mr-hint-${repoSlug(owner, repo)}.json`,
  );
}

/**
 * Load hint cache from disk. Returns empty cache when missing or expired.
 */
function loadCache(owner: string, repo: string): HintCache {
  try {
    const raw = fs.readFileSync(getCachePath(owner, repo), 'utf-8');
    const parsed = JSON.parse(raw) as HintCache;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > CACHE_TTL_MS) {
      return { hintedMrIds: [], updatedAt: new Date().toISOString() };
    }
    return parsed;
  } catch {
    // cache missing or malformed — start fresh
    return { hintedMrIds: [], updatedAt: new Date().toISOString() };
  }
}

/**
 * Save hint cache to disk (best-effort, never throws).
 */
function saveCache(owner: string, repo: string, cache: HintCache): void {
  try {
    const cachePath = getCachePath(owner, repo);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    // best-effort
  }
}

// ─── Git remote detection ────────────────────────────────

/**
 * Get the `origin` remote URL for the given working directory.
 *
 * Returns null if not in a git repo or remote not configured.
 *
 * @param cwd  Working directory to inspect
 * @returns    Remote URL string, or null
 */
export function getGitRemote(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

// ─── Remote URL parsing ──────────────────────────────────

/** Parsed result from a git remote URL. */
export interface RemoteRepo {
  /** Git provider. */
  provider: 'tgit' | 'github';
  /** Owner or group path (may contain '/'). */
  owner: string;
  /** Repository name (last path segment). */
  repo: string;
}

/**
 * Parse a git remote URL into provider + owner/repo info.
 *
 * Supports HTTPS and SSH formats for git.woa.com (TGit) and github.com.
 *
 * @param remoteUrl  Full git remote URL
 * @returns          Parsed RemoteRepo, or null if unrecognized
 */
export function parseRemoteToRepo(remoteUrl: string): RemoteRepo | null {
  const url = remoteUrl.trim();

  // TGit HTTPS: https://git.woa.com/group/sub/repo.git
  const tgitHttps = url.match(/^https?:\/\/[^@]*git\.woa\.com\/(.+)\/([^/]+?)(?:\.git)?\/?$/);
  if (tgitHttps) {
    return { provider: 'tgit', owner: tgitHttps[1], repo: tgitHttps[2] };
  }

  // TGit SSH: git@git.woa.com:group/sub/repo.git
  const tgitSsh = url.match(/^git@git\.woa\.com:(.+)\/([^/]+?)(?:\.git)?\/?$/);
  if (tgitSsh) {
    return { provider: 'tgit', owner: tgitSsh[1], repo: tgitSsh[2] };
  }

  // GitHub HTTPS: https://github.com/owner/repo.git
  const ghHttps = url.match(/^https?:\/\/[^@]*github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ghHttps) {
    return { provider: 'github', owner: ghHttps[1], repo: ghHttps[2] };
  }

  // GitHub SSH: git@github.com:owner/repo.git
  const ghSsh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ghSsh) {
    return { provider: 'github', owner: ghSsh[1], repo: ghSsh[2] };
  }

  return null;
}

// ─── MR listing ─────────────────────────────────────────

/** TGit API MR object (subset of fields). */
interface TGitMR {
  iid: number;
  title: string;
  web_url: string;
  merged_at: string | null;
}

/**
 * List recently merged MRs from TGit REST API.
 *
 * Calls: GET /api/v3/projects/<encoded-path>/merge_requests?state=merged&...
 * Uses the OAuth token from gf credential store.
 *
 * @param owner   Owner or group path
 * @param repo    Repository name
 * @param since   Include only MRs merged after this date
 * @returns       Array of MRSummary, empty on any error
 */
async function listTGitMergedMRs(
  owner: string,
  repo: string,
  since: Date,
): Promise<MRSummary[]> {
  const token = gfGetOAuthToken();
  if (!token) {
    log.debug('mr-hint: no TGit token, skipping TGit MR check');
    return [];
  }

  const projectId = encodeURIComponent(`${owner}/${repo}`);
  const apiUrl =
    `https://git.woa.com/api/v3/projects/${projectId}/merge_requests` +
    `?state=merged&order_by=updated_at&sort=desc&per_page=${MAX_MRS}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      log.debug(`mr-hint: TGit API returned ${resp.status}`);
      return [];
    }
    const items = (await resp.json()) as TGitMR[];
    const sinceMs = since.getTime();
    return items
      .filter((mr) => mr.merged_at && new Date(mr.merged_at).getTime() >= sinceMs)
      .map((mr) => ({
        id: String(mr.iid),
        title: mr.title,
        url: mr.web_url,
        mergedAt: mr.merged_at!,
      }));
  } catch (err) {
    log.debug(`mr-hint: TGit API error: ${(err as Error).message}`);
    return [];
  }
}

/** GitHub PR object from gh CLI JSON output. */
interface GhPR {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

/** GitHub REST API pull request object (subset of fields used). */
interface GitHubRestPR {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  pull_request?: { merged_at: string | null };
}

/**
 * Fetch merged PRs from the GitHub REST API.
 *
 * Used as fallback when `gh` CLI is unavailable. Supports public repos
 * without a token; uses GITHUB_TOKEN env var when present to raise rate limits.
 *
 * @param owner  Repository owner
 * @param repo   Repository name
 * @param since  Include only PRs merged after this date
 * @returns      Array of MRSummary, empty on any error
 */
async function listGitHubMergedMRsViaREST(
  owner: string,
  repo: string,
  since: Date,
): Promise<MRSummary[]> {
  const token = process.env['GITHUB_TOKEN'];
  const headers: Record<string, string> = { 'User-Agent': 'teamai-cli', Accept: 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MAX_MRS}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      log.debug(`mr-hint: GitHub REST API returned ${resp.status}`);
      return [];
    }
    const items = (await resp.json()) as GitHubRestPR[];
    const sinceMs = since.getTime();
    return items
      .filter((pr) => pr.merged_at && new Date(pr.merged_at).getTime() >= sinceMs)
      .map((pr) => ({
        id: String(pr.number),
        title: pr.title,
        url: pr.html_url,
        mergedAt: pr.merged_at!,
      }));
  } catch (err) {
    log.debug(`mr-hint: GitHub REST API error: ${(err as Error).message}`);
    return [];
  }
}

/**
 * List recently merged PRs from GitHub.
 *
 * Primary path: `gh pr list` CLI.
 * Fallback: GitHub REST API (supports public repos without token).
 *
 * @param owner  Repository owner
 * @param repo   Repository name
 * @param since  Include only PRs merged after this date
 * @returns      Array of MRSummary, empty when all paths fail
 */
async function listGitHubMergedMRs(
  owner: string,
  repo: string,
  since: Date,
): Promise<MRSummary[]> {
  // ── Primary: gh CLI ──────────────────────────────────────
  try {
    const result = spawnSync(
      'gh',
      [
        'pr', 'list',
        '--repo', `${owner}/${repo}`,
        '--state', 'merged',
        '--limit', String(MAX_MRS),
        '--json', 'number,title,url,mergedAt',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 },
    );
    if (result.status === 0 && result.stdout.trim()) {
      const items = JSON.parse(result.stdout) as GhPR[];
      const sinceMs = since.getTime();
      return items
        .filter((pr) => pr.mergedAt && new Date(pr.mergedAt).getTime() >= sinceMs)
        .map((pr) => ({
          id: String(pr.number),
          title: pr.title,
          url: pr.url,
          mergedAt: pr.mergedAt,
        }));
    }
    log.debug(`mr-hint: gh pr list unavailable (status=${result.status}), falling back to REST API`);
  } catch (err) {
    log.debug(`mr-hint: gh CLI error: ${(err as Error).message}, falling back to REST API`);
  }

  // ── Fallback: GitHub REST API ────────────────────────────
  return listGitHubMergedMRsViaREST(owner, repo, since);
}

// ─── Hint message builder ────────────────────────────────

/**
 * Build the additionalContext hint message for AI.
 *
 * @param mrs  New merged MRs that have not been imported yet
 * @returns    Bilingual hint string
 */
export function buildHintMessage(mrs: MRSummary[]): string {
  const lines: string[] = [
    `[teamai:mr-hint] 发现 ${mrs.length} 个近期已合入但尚未提炼的 MR。`,
    '',
    '请在任务完成后告知用户，可运行以下命令将 MR 提炼为 learning 并更新 codebase.md：',
    '',
  ];

  for (const mr of mrs) {
    const date = mr.mergedAt.slice(0, 10);
    lines.push(`- ${mr.title}（merged: ${date}）`);
    lines.push(`  teamai import --from-mr ${mr.url}`);
  }

  lines.push('');
  lines.push('[teamai:mr-hint] Found merged MR(s) not yet imported into team knowledge base.');
  lines.push('Please remind the user to run `teamai import --from-mr <url>` when convenient.');

  return lines.join('\n');
}

// ─── Main entry point ────────────────────────────────────

/**
 * Entry point for `teamai mr-hint --stdin`.
 *
 * Called by the SessionStart hook. Reads STDIN for session metadata,
 * detects the git repo remote, queries recently merged MRs, and outputs
 * an additionalContext hint when unimported MRs are found.
 *
 * Behavior:
 * - Silently exits when TEAMAI_MR_HINT_DISABLED=1.
 * - Silently exits when CWD is not a git repo or remote is unrecognized.
 * - Silently exits when API/CLI calls fail (best-effort, non-blocking).
 * - Per-repo cache prevents re-hinting the same MR across sessions.
 */
/**
 * Core MR-hint computation: detect repo, query merged MRs, update cache, and
 * build the SessionStart hookSpecificOutput JSON. Returns null when there is
 * nothing to hint. Does NOT read STDIN — safe to call from the hook dispatcher
 * (which has already consumed STDIN) as well as from the standalone command.
 */
export async function computeMrHintOutput(): Promise<string | null> {
  if (process.env.TEAMAI_MR_HINT_DISABLED === '1') return null;

  // Detect git remote
  const rawCwd = process.env.TEAMAI_MR_HINT_CWD ?? process.cwd();
  const cwd = path.resolve(rawCwd);
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      // 不是目录，静默跳过（避免误报）
      return null;
    }
  } catch {
    // 路径不存在，静默跳过
    return null;
  }
  const remoteUrl = getGitRemote(cwd);
  if (!remoteUrl) {
    log.debug('mr-hint: no git remote, skipping');
    return null;
  }

  const repoInfo = parseRemoteToRepo(remoteUrl);
  if (!repoInfo) {
    log.debug(`mr-hint: unrecognized remote URL: ${remoteUrl}`);
    return null;
  }

  const { provider, owner, repo } = repoInfo;

  // Load cache to filter already-hinted MRs
  const cache = loadCache(owner, repo);
  const alreadyHinted = new Set(cache.hintedMrIds);

  // Query merged MRs from past LOOKBACK_DAYS days
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  let allMrs: MRSummary[] = [];

  if (provider === 'tgit') {
    allMrs = await listTGitMergedMRs(owner, repo, since);
  } else {
    allMrs = await listGitHubMergedMRs(owner, repo, since);
  }

  // Filter out already-hinted MRs
  const newMrs = allMrs.filter((mr) => !alreadyHinted.has(mr.id));
  if (newMrs.length === 0) {
    log.debug('mr-hint: no new merged MRs to hint');
    return null;
  }

  // Update cache with all MR IDs seen this round
  const updatedIds = [...alreadyHinted, ...newMrs.map((mr) => mr.id)];
  saveCache(owner, repo, { hintedMrIds: updatedIds, updatedAt: new Date().toISOString() });

  // Build additionalContext hint
  const hintText = buildHintMessage(newMrs);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: hintText,
    },
  });
}

export async function mrHint(): Promise<void> {
  // Drain STDIN when piped (hook invocation) so the caller doesn't block.
  // Session metadata is not yet used by the hint logic.
  if (!process.stdin.isTTY) {
    try {
      for await (const _chunk of process.stdin) {
        void _chunk;
      }
    } catch {
      // non-critical
    }
  }

  const output = await computeMrHintOutput();
  if (output) process.stdout.write(output + '\n');
}
