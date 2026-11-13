import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { getTGitToken, tgitFetch } from './providers/tgit/rest-auth.js';
import { getGitHubToken } from './providers/github/gh-cli.js';
import { log } from './utils/logger.js';
import { lenientList } from './utils/json.js';
import { getUserHome } from './utils/home.js';
import { getRemoteUrl } from './utils/git.js';
import { readJson, writeJsonAtomic } from './utils/fs.js';
import { type LocalConfig, JsonObjectSchema } from './types.js';
import type { SessionRun } from './launch-context.js';
import { WorkflowOffers, type Proposal } from './workflow-offers.js';
import type { OutputSchema } from './workflow/types.js';
import { DefaultFolders, type DefaultFolder, type TextLanguage } from './default-folders.js';

// ─── MR Hint data flow ──────────────────────────────────
//
//  SessionStart hook: its background pass where the tool gets a
//  UserPromptSubmit hook, else its foreground, or `teamai mr-hint --stdin`
//      │
//      ├─ Read STDIN { session_id }
//      ├─ getRemoteUrl(CWD) → remote URL
//      ├─ parseRemoteToRepo(url) → { provider, owner, repo }
//      ├─ listMergedMRs(provider, owner, repo, since)
//      │   ├─ TGit: REST API /api/v3/projects/:id/merge_requests
//      │   └─ GitHub: gh pr list --state merged --json
//      ├─ filter by hint cache (avoid re-hinting same MR)
//      └─ Has new MRs? → hookSpecificOutput.additionalContext, offering
//          teamai-import-from-mr where a hook may offer it, whose describe then
//          proposes the MRs this session was offered. The background pass
//          stashes it and the session's next UserPromptSubmit shows it. The
//          cache records an MR as hinted when the hint is shown.
//

/** Cache TTL: 30 days. After this, cache is cleared. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The sessions whose offer the cache keeps, the latest ones. */
const OFFERED_SESSIONS = 20;

/** teamai's default that turns merged MRs into learnings, which the hint offers. */
const IMPORT_FROM_MR = 'teamai-import-from-mr';

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
const HintCacheSchema = z.object({
  /** MR IDs that have already been hinted. */
  hintedMrIds: lenientList(z.string()),
  /** ISO 8601 timestamp of last update. */
  updatedAt: z.string(),
  /**
   * The URLs of the MRs the hint listed to each session it offered teamai-import-from-mr, by session id, which describe
   * proposes to that session. An older cache holds only the session offered last.
   */
  offered: z.union([
    z.record(z.string(), lenientList(z.string())),
    z.object({ session: z.string(), urls: lenientList(z.string()) }).transform(({ session, urls }) => ({ [session]: urls })),
  ]).optional(),
});

type HintCache = z.infer<typeof HintCacheSchema>;

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
    getUserHome(),
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
    const parsed = HintCacheSchema.parse(JSON.parse(raw));
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
 * The offers of the cache once session `sessionId` is offered `urls`: read again, so a session of the repository that
 * saved its own offer since this one loaded the cache keeps it, and only the latest {@link OFFERED_SESSIONS} are kept.
 */
function offerTo(owner: string, repo: string, sessionId: string, urls: string[]): Record<string, string[]> {
  const others = Object.entries(loadCache(owner, repo).offered ?? {}).filter(([session]) => session !== sessionId);

  return Object.fromEntries([...others, [sessionId, urls] as const].slice(-OFFERED_SESSIONS));
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

/** The MRs a listing asks for: merged after `since`, at most `limit` of them (the API page size). */
interface MergedSince {
  readonly since: Date;
  readonly limit: number;
}

/** TGit API MR object (subset of fields). */
const TGitMRSchema = z.object({
  iid: z.number(),
  title: z.string(),
  web_url: z.string(),
  merged_at: z.string().nullable(),
});

/**
 * List recently merged MRs from TGit REST API.
 *
 * Calls: GET /api/v3/projects/<encoded-path>/merge_requests?state=merged&...
 * Uses the OAuth token from gf credential store.
 *
 * @param owner   Owner or group path
 * @param repo    Repository name
 * @param merged  Which MRs: merged after `since`, at most `limit` of them
 * @returns       Array of MRSummary, empty on any error
 */
async function listTGitMergedMRs(
  owner: string,
  repo: string,
  { since, limit }: MergedSince,
): Promise<MRSummary[]> {
  try {
    getTGitToken();
  } catch {
    log.debug('mr-hint: no TGit token, skipping TGit MR check');

    return [];
  }

  const projectId = encodeURIComponent(`${owner}/${repo}`);

  const apiPath =
    `/projects/${projectId}/merge_requests` +
    `?state=merged&order_by=updated_at&sort=desc&per_page=${limit}`;

  try {
    const resp = await tgitFetch(apiPath, {
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      log.debug(`mr-hint: TGit API returned ${resp.status}`);

      return [];
    }

    const items = lenientList(TGitMRSchema).parse(await resp.json());
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
    log.debug(`mr-hint: TGit API error: ${err instanceof Error ? err.message : String(err)}`);

    return [];
  }
}

/** GitHub PR object from gh CLI JSON output. */
const GhPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string(),
});

/** GitHub REST API pull request object (subset of fields used). */
const GitHubRestPRSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  merged_at: z.string().nullable(),
});

/**
 * Fetch merged PRs from the GitHub REST API.
 *
 * Used as fallback when `gh` CLI is unavailable. Supports public repos
 * without a token; uses GITHUB_TOKEN or GH_TOKEN env var when present to raise rate limits.
 *
 * @param owner   Repository owner
 * @param repo    Repository name
 * @param merged  Which PRs: merged after `since`, at most `limit` of them
 * @returns       Array of MRSummary, empty on any error
 */
async function listGitHubMergedMRsViaREST(
  owner: string,
  repo: string,
  { since, limit }: MergedSince,
): Promise<MRSummary[]> {
  const token = getGitHubToken();
  const baseHeaders = { 'User-Agent': 'teamai-cli', Accept: 'application/vnd.github+json' };
  const headers = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${limit}`;

  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });

    if (!resp.ok) {
      log.debug(`mr-hint: GitHub REST API returned ${resp.status}`);

      return [];
    }

    const items = lenientList(GitHubRestPRSchema).parse(await resp.json());
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
    log.debug(`mr-hint: GitHub REST API error: ${err instanceof Error ? err.message : String(err)}`);

    return [];
  }
}

/**
 * List recently merged PRs from GitHub.
 *
 * Primary path: `gh pr list` CLI.
 * Fallback: GitHub REST API (supports public repos without token).
 *
 * @param owner   Repository owner
 * @param repo    Repository name
 * @param merged  Which PRs: merged after `since`, at most `limit` of them
 * @returns       Array of MRSummary, empty when all paths fail
 */
async function listGitHubMergedMRs(
  owner: string,
  repo: string,
  merged: MergedSince,
): Promise<MRSummary[]> {
  const { since, limit } = merged;

  // ── Primary: gh CLI ──────────────────────────────────────
  try {
    const result = spawnSync(
      'gh',
      [
        'pr', 'list',
        '--repo', `${owner}/${repo}`,
        '--state', 'merged',
        '--limit', String(limit),
        '--json', 'number,title,url,mergedAt',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 },
    );

    if (result.status === 0 && result.stdout.trim()) {
      const items = lenientList(GhPRSchema).parse(JSON.parse(result.stdout));
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
    log.debug(`mr-hint: gh CLI error: ${err instanceof Error ? err.message : String(err)}, falling back to REST API`);
  }

  // ── Fallback: GitHub REST API ────────────────────────────
  return listGitHubMergedMRsViaREST(owner, repo, merged);
}

// ─── Hint message builder ────────────────────────────────

/**
 * Build the additionalContext hint message for AI from `hook`'s texts: `offer-workflow` when the hint offers
 * teamai-import-from-mr, else `offer-command`, each English only when language is `en` (its `.en.md` variant).
 *
 * @param mrs  New merged MRs that have not been imported yet
 */
export function buildHintMessage(
  mrs: MRSummary[],
  hook: DefaultFolder<'hooks', 'teamai-mr-hint'>,
  { language, offersWorkflow = false }: { language?: TextLanguage; offersWorkflow?: boolean } = {},
): string {
  // One run for every MR: teamai-import-from-mr takes several URLs, publishes the
  // accepted learnings once and updates each repository's teamwiki once (#1104).
  // Its describe proposes the URLs, so each MR line names its own.
  const command = offersWorkflow
    ? 'teamai workflow start --describe teamai-import-from-mr --driver skill'
    : `teamai import --from-mr ${mrs.map((mr) => mr.url).join(' ')}`;

  const offer = hook.text(offersWorkflow ? 'offer-workflow' : 'offer-command', language);
  const url = (mr: MRSummary): string => (offersWorkflow ? ` ${mr.url}` : '');

  const line = (mr: MRSummary): string => (offer.language === 'en'
    ? `- ${mr.title} (merged: ${mr.mergedAt.slice(0, 10)})${url(mr)}`
    : `- ${mr.title}（merged: ${mr.mergedAt.slice(0, 10)}）${url(mr)}`);

  return offer.render({ count: String(mrs.length), mr_lines: mrs.map(line).join('\n'), command });
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
 * - Silently exits when TEAMAI_MR_HINT_DISABLED=1, or when the scope's
 *   `mrHint` switch resolves to off.
 * - Silently exits when CWD is not a git repo or remote is unrecognized.
 * - Silently exits when API/CLI calls fail (best-effort, non-blocking).
 * - Per-repo cache prevents re-hinting the same MR across sessions.
 */
/**
 * Whether the scope the caller resolved allows the hint.
 *
 * Resolved here, in the one path the SessionStart hook and the legacy
 * `teamai mr-hint` entry point share, so the two cannot disagree about it.
 * A null scope means teamai is not set up for this directory: there is no
 * config to read a switch from, and the hint has always been on there.
 */
async function mrHintAllowed(localConfig?: LocalConfig | null): Promise<boolean> {
  if (!localConfig) return true;
  const { loadTeamConfig } = await import('./config.js');
  const { isMrHintEnabled } = await import('./types.js');
  let teamConfig: Awaited<ReturnType<typeof loadTeamConfig>> = null;

  try {
    teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  } catch {
    // An unreadable teamai.yaml is not an instruction to stop; a team with no
    // opinion leaves the hint on, which is what isMrHintEnabled defaults to.
  }

  return isMrHintEnabled(localConfig, teamConfig ?? {});
}

/** Whether the hint is on: neither `TEAMAI_MR_HINT_DISABLED` nor the scope's switch turns it off. Asked when a hint is computed and again when it is shown. */
async function mrHintOn(localConfig?: LocalConfig | null): Promise<boolean> {
  return process.env.TEAMAI_MR_HINT_DISABLED !== '1' && await mrHintAllowed(localConfig);
}

/** What showing a hint records in the repository's cache: its MRs as hinted, and the session offered their URLs. */
const ShownSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ids: z.array(z.string()),
  offer: z.object({ sessionId: z.string(), urls: z.array(z.string()) }).optional(),
});

type Shown = z.infer<typeof ShownSchema>;

/** A hint for a session, and what showing it records. */
const MrHintSchema = z.object({ message: z.string().min(1), shown: ShownSchema });

type MrHint = z.infer<typeof MrHintSchema>;

/**
 * The hint for the MRs merged in the repository at the hook's cwd that no shown hint listed yet, or null when there is
 * nothing to hint or the scope's switch turns it off. Writes nothing: showing it records it ({@link recordShown}).
 */
async function computeMrHint(
  language: TextLanguage,
  localConfig?: LocalConfig | null,
  session?: { sessionId: string; cwd: string; run: SessionRun },
): Promise<MrHint | null> {
  if (!(await mrHintOn(localConfig))) return null;

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

  const remoteUrl = await getRemoteUrl(cwd);

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
  const alreadyHinted = new Set(loadCache(owner, repo).hintedMrIds);
  const hook = await DefaultFolders.load({ kind: 'hooks', name: 'teamai-mr-hint' }, localConfig ?? null);
  const { lookback_days: lookbackDays, max_mrs: limit } = hook.params;

  // Query the MRs merged in the past lookback_days days
  const merged: MergedSince = { since: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000), limit };
  let allMrs: MRSummary[] = [];

  if (provider === 'tgit') {
    allMrs = await listTGitMergedMRs(owner, repo, merged);
  } else {
    allMrs = await listGitHubMergedMRs(owner, repo, merged);
  }

  // Filter out already-hinted MRs
  const newMrs = allMrs.filter((mr) => !alreadyHinted.has(mr.id));

  if (newMrs.length === 0) {
    log.debug('mr-hint: no new merged MRs to hint');

    return null;
  }

  // The workflow where a hook may offer it to this session; else the command, as a session teamai launched gets it.
  const offeredTo = session && localConfig && (await WorkflowOffers.offerable(localConfig, IMPORT_FROM_MR, session)) !== undefined ? session : undefined;

  return {
    message: buildHintMessage(newMrs, hook, { language, offersWorkflow: offeredTo !== undefined }),
    shown: {
      owner,
      repo,
      ids: newMrs.map((mr) => mr.id),
      offer: offeredTo && { sessionId: offeredTo.sessionId, urls: newMrs.map((mr) => mr.url) },
    },
  };
}

/** Record in the repository's cache that a hint was shown, read again so what other sessions recorded since stays. */
function recordShown({ owner, repo, ids, offer }: Shown): void {
  const cache = loadCache(owner, repo);
  const offered = offer ? offerTo(owner, repo, offer.sessionId, offer.urls) : cache.offered;

  saveCache(owner, repo, { hintedMrIds: [...new Set([...cache.hintedMrIds, ...ids])], updatedAt: new Date().toISOString(), offered });
}

function hookOutput(hookEventName: 'SessionStart' | 'UserPromptSubmit', message: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: message } });
}

/**
 * The hint as SessionStart hook output, recorded as shown, or null when there is nothing to hint. Does NOT read STDIN
 * — safe to call from the hook dispatcher (which has already consumed STDIN) as well as from the standalone command.
 */
export async function computeMrHintOutput(
  language: TextLanguage,
  localConfig?: LocalConfig | null,
  session?: { sessionId: string; cwd: string; run: SessionRun },
): Promise<string | null> {
  const hint = await computeMrHint(language, localConfig, session);

  if (!hint) return null;
  recordShown(hint.shown);

  return hookOutput('SessionStart', hint.message);
}

/** Where the hint a session start found waits for the session's next prompt, as hook-fast-path.ts names it too. */
function pendingPath(sessionId: string): string {
  return path.join(getUserHome(), '.teamai', 'sessions', `${sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}.mr-hint.pending.json`);
}

/**
 * Leave the hint for the session's next prompt ({@link takePendingMrHint}), in place of the one it had waiting: a
 * session start that finds nothing new drops that one. Nothing is recorded until the hint is shown.
 */
export async function stashMrHint(
  language: TextLanguage,
  localConfig: LocalConfig | null,
  session: { sessionId: string; cwd: string; run: SessionRun },
): Promise<void> {
  const hint = await computeMrHint(language, localConfig, session);
  const file = pendingPath(session.sessionId);

  if (hint) await writeJsonAtomic(file, hint);
  else await fs.promises.rm(file, { force: true });
}

/**
 * The hint a session start left for session `sessionId`, as UserPromptSubmit hook output recorded as shown, at most
 * once: the file is moved aside before it is read, so two prompts cannot both take it. Null when none waits, when
 * another session has shown all its MRs since, or when the hint was turned off since: that one is dropped unshown.
 */
export async function takePendingMrHint(sessionId: string, localConfig?: LocalConfig | null): Promise<string | null> {
  const file = pendingPath(sessionId);
  const taken = `${file}.${process.pid}`;

  try {
    await fs.promises.rename(file, taken);
  } catch {
    return null;
  }

  const hint = MrHintSchema.safeParse(await readJson(taken));
  await fs.promises.rm(taken, { force: true });

  if (!hint.success || !(await mrHintOn(localConfig))) return null;
  const { shown } = hint.data;
  const hinted = new Set(loadCache(shown.owner, shown.repo).hintedMrIds);

  if (shown.ids.every((id) => hinted.has(id))) return null;
  recordShown(shown);

  return hookOutput('UserPromptSubmit', hint.data.message);
}

// ─── describe proposals ──────────────────────────────────

/** The inputs of teamai-import-from-mr teamai proposes values for, by name and parsed type. */
const CONTRACT = {
  mrs: { type: 'array', items: { type: 'string' } },
  all: { type: 'boolean' },
  publish: { type: 'boolean' },
  dir: { type: 'string' },
  output: { type: 'boolean' },
  discussions: { type: 'boolean' },
  language: { type: 'enum', values: ['en', 'zh'] },
} as const satisfies Record<string, OutputSchema>;

/** The MRs the hint listed in session `session`, in the repository whose checkout is `cwd`. */
async function mrsProposal(cwd: string, session: string | undefined): Promise<Proposal> {
  if (session === undefined) return { why: 'No agent session found: give the MR or PR URLs.' };
  const remote = await getRemoteUrl(cwd);
  const repo = remote === null ? null : parseRemoteToRepo(remote);
  const urls = repo === null ? undefined : loadCache(repo.owner, repo.repo).offered?.[session];

  if (urls === undefined || urls.length === 0) {
    return { why: 'No value: the session-start hint listed no merged MR in this session. Give the MR or PR URLs.' };
  }

  return { value: urls, why: 'The merged MRs the session-start hint listed in this session.' };
}

/**
 * What describe proposes for the declared `inputs` of teamai-import-from-mr, by input: each input the contract names
 * with the same type. The MRs are those the hint listed in the calling session; the rest make the run
 * `teamai import --from-mr` starts, which asks about each draft and publishes what the person accepts.
 */
async function proposals(
  config: LocalConfig,
  { inputs }: { inputs: Readonly<Record<string, OutputSchema>> },
  caller: { session: string | undefined; cwd: string },
): Promise<Record<string, Proposal>> {
  const matching = WorkflowOffers.contractInputs(inputs, CONTRACT);

  if (matching.length === 0) return {};

  const { loadTeamConfig } = await import('./config.js');
  const team = await loadTeamConfig(config.repo.localPath);

  const proposed: Record<keyof typeof CONTRACT, Proposal> = {
    mrs: await mrsProposal(caller.cwd, caller.session),
    all: { value: false, why: 'Ask the person to accept, edit or skip each draft. true publishes every draft unasked.' },
    publish: { value: true, why: 'Publish the drafts the person accepts to the team repository. false writes and pushes nothing, so the drafts are only the run\'s outputs.' },
    dir: { value: config.repo.localPath, why: 'The team repository the learnings are published to.' },
    output: { value: false, why: 'Publish into the team repository. true writes each draft into dir as a file instead.' },
    discussions: { value: true, why: 'Read each MR\'s review threads, which carry what the review decided.' },
    language: team?.language
      ? { value: team.language, why: 'The language teamai.yaml sets, which the learnings are written in.' }
      : { value: 'zh', why: 'teamai.yaml sets no language, so the learnings are written in zh, as teamai import --from-mr writes them.' },
  };

  return Object.fromEntries(matching.map((input) => [input, proposed[input]]));
}

/** What describe proposes for teamai-import-from-mr, the workflow the hint offers. */
export const MrHintOffer = { proposals } as const;

/** The SessionStart hook's stdin object; anything else reads as no payload. */
const HookPayloadSchema = JsonObjectSchema;

type HookPayload = z.infer<typeof HookPayloadSchema>;

export async function mrHint(tool?: string): Promise<void> {
  // Drain STDIN when piped (hook invocation) so the caller doesn't block.
  // The payload's cwd selects the scope whose teamai.yaml `language` applies.
  let payload: HookPayload = {};

  if (!process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];

      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }

      const raw = Buffer.concat(chunks).toString('utf-8').trim();

      if (raw) {
        try {
          payload = HookPayloadSchema.safeParse(JSON.parse(raw)).data ?? payload;
        } catch {
          // non-critical: an unparseable payload still drains
        }
      }
    } catch {
      // non-critical
    }
  }

  // One scope resolution feeds both the language and the switch, so this entry
  // point reads exactly the config the SessionStart hook reads.
  let language: 'en' | 'zh' | undefined;
  let hookConfig: LocalConfig | null = null;

  try {
    const { resolveHookConfig } = await import('./dashboard-collector.js');
    const { loadTeamAgentLanguage } = await import('./config.js');
    hookConfig = await resolveHookConfig(payload, tool ?? 'claude');
    language = await loadTeamAgentLanguage(hookConfig);
  } catch {
    // An unreadable scope keeps the historical bilingual text. The hint stays
    // on: mrHintAllowed treats a missing config as "no switch to read".
  }

  const { deriveSessionId } = await import('./utils/session-id.js');
  const { resolveHookCwd } = await import('./utils/hook-cwd.js');
  const { readSessionRun, sessionRun } = await import('./launch-context.js');
  const session = { sessionId: deriveSessionId(payload, { includeCwd: true }), cwd: resolveHookCwd(payload) ?? process.cwd(), run: readSessionRun(payload) ?? sessionRun(process.env) };
  const output = await computeMrHintOutput(language, hookConfig, session);

  if (output) process.stdout.write(output + '\n');
}
