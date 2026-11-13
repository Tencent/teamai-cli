import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { endedRequest, type PullRequestRecord, type PullRequestRef } from '../types.js';
import { CODEUP_HOST } from './repo-url.js';
import { getUserHome, legacyUserHome } from '../../utils/home.js';
import { sanitizeGitUrl } from '../../utils/redact.js';

/**
 * Codeup (阿里云云效代码管理, codeup.aliyun.com) OpenAPI client.
 *
 * Codeup is served by the Yunxiao (云效) OpenAPI — NOT GitLab-style — so this
 * provider is modelled on gitcode/ structurally but differs in every dialect
 * detail. The request/response shapes follow the official OpenAPI reference
 * and the alibabacloud-devops-mcp-server reference implementation:
 *
 *   - API base is a SEPARATE host: https://openapi-rdc.aliyuncs.com (中心版).
 *     A Region 版 deployment drops the organizations/{organizationId} prefix;
 *     set CODEUP_API_BASE_URL (and YUNXIAO_EDITION=region) to target it.
 *   - A Personal Access Token authenticates every REST call via the
 *     `x-yunxiao-token` header (云效个人访问令牌, format `pt-…`).
 *   - whoami is `GET /oapi/v1/platform/user` and returns `username` plus
 *     `lastOrganization`, which doubles as the organizationId fallback.
 *   - Repos are addressed by a numeric ID, resolved from the
 *     `org/group/repo` path via `GET …/repositories/{encoded path}`.
 *   - MR create is `POST …/repositories/{id}/changeRequests` (Codeup calls
 *     them changeRequests, not merge_requests) with
 *     sourceBranch/targetBranch/sourceProjectId/targetProjectId; the
 *     response carries `detailUrl` and `localId`.
 *
 * Token resolution (highest precedence first):
 *   1. `CODEUP_TOKEN` env var (primary)
 *   2. `YUNXIAO_TOKEN` env var (alias — matches the Yunxiao CLI convention)
 *   3. `~/.netrc` entry `machine codeup.aliyun.com … password <token>`
 *
 * Git transport: the token is an OpenAPI credential, NOT a git-over-HTTPS
 * one by default — `cloneRepo` clones over SSH (`git@codeup.aliyun.com:…`),
 * so an SSH key on the machine is the normal auth. When the token was
 * persisted to ~/.netrc with the account username (interactive `init` flow),
 * HTTPS Basic auth is used instead.
 */

// ─── Config ──────────────────────────────────────────────

const CODEUP_API_BASE = 'https://openapi-rdc.aliyuncs.com';

export function codeupApiBase(): string {
  const override = process.env.CODEUP_API_BASE_URL?.trim();

  return override || CODEUP_API_BASE;
}

/** True when targeting a Region 版 Yunxiao OpenAPI (no organization path segment). */
function isRegionEdition(): boolean {
  const explicit = process.env.YUNXIAO_EDITION?.trim().toLowerCase();

  if (explicit === 'central') return false;
  if (explicit === 'region') return true;

  return !codeupApiBase().includes('openapi-rdc.aliyuncs.com');
}

// ─── Token resolution ────────────────────────────────────

/** Resolve the Codeup PAT from env, then ~/.netrc. Returns null when absent. */
export function getCodeupToken(): string | null {
  for (const raw of [process.env.CODEUP_TOKEN, process.env.YUNXIAO_TOKEN]) {
    const token = raw?.trim();

    if (token) return token;
  }

  return readNetrcToken();
}

function requireToken(): string {
  const token = getCodeupToken();

  if (!token) {
    throw new Error(
      'Codeup authentication unavailable. Set CODEUP_TOKEN (a Yunxiao/Codeup '
        + 'Personal Access Token, created at codeup.aliyun.com → 个人设置 → '
        + '个人访问令牌), or run `teamai init` to paste one interactively. '
        + 'YUNXIAO_TOKEN is accepted as an alias.',
    );
  }

  return token;
}

function authHeaders(token: string) {
  return {
    'x-yunxiao-token': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── ~/.netrc credential storage ─────────────────────────
//
// Reused as the credential store for the same reasons as the GitCode
// provider: a plain, well-understood format. Entry format:
//   machine codeup.aliyun.com login <username> password <token>
// The login matters here — it doubles as the git-over-HTTPS Basic username
// when the token is also used as a git transport credential.

function netrcPath(): string {
  return path.join(getUserHome(), '.netrc');
}

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

/** Read the codeup.aliyun.com token from ~/.netrc, or null when absent/unreadable. */
export function readNetrcToken(): string | null {
  const pattern = new RegExp(
    `machine\\s+${CODEUP_HOST.replace('.', '\\.')}\\s+.*?password\\s+(\\S+)`,
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

/** The username stored alongside the token in ~/.netrc, or null. */
export function readNetrcUsername(): string | null {
  const pattern = new RegExp(
    `machine\\s+${CODEUP_HOST.replace('.', '\\.')}\\s+login\\s+(\\S+)`,
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
 * Persist the token to ~/.netrc (mode 0600). Replaces any existing
 * codeup.aliyun.com entry so re-authenticating overwrites rather than
 * duplicates.
 */
export function writeNetrcToken(token: string, username: string): void {
  const file = netrcPath();
  let existing = '';

  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // no existing file — start fresh
  }

  const filtered = existing
    .split('\n')
    .filter((line) => !new RegExp(`^machine\\s+${CODEUP_HOST.replace('.', '\\.')}\\b`).test(line.trim()))
    .join('\n')
    .replace(/\n+$/, '');

  const entry = `machine ${CODEUP_HOST} login ${username} password ${token}`;
  const next = filtered ? `${filtered}\n${entry}\n` : `${entry}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });

  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

// ─── Auth ────────────────────────────────────────────────

const CurrentUserSchema = z.object({
  id: z.string().nullish(),
  username: z.string().nullish(),
  name: z.string().nullish(),
  lastOrganization: z.string().nullish(),
}).catch({});

/** True when a Codeup token is configured (no network check). */
export function codeupIsAuthenticated(): boolean {
  return getCodeupToken() !== null;
}

/** Fetch the authenticated user, or null when unavailable. */
export async function codeupWhoami(): Promise<{ username: string | null; lastOrganization: string | null }> {
  const token = getCodeupToken();

  if (!token) return { username: null, lastOrganization: null };

  try {
    const resp = await fetch(`${codeupApiBase()}/oapi/v1/platform/user`, {
      headers: authHeaders(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return { username: null, lastOrganization: null };
    const data = CurrentUserSchema.parse(await resp.json());

    return { username: data.username ?? null, lastOrganization: data.lastOrganization ?? null };
  } catch {
    return { username: null, lastOrganization: null };
  }
}

// ─── Repository / organization resolution ────────────────

/**
 * Resolve the organizationId the OpenAPI paths need.
 * Precedence: CODEUP_ORG_ID env var, then the authenticated user's
 * lastOrganization. In practice CODEUP_ORG_ID is the reliable source: a PAT
 * created with only codeup scope (the common case) cannot call the platform
 * user endpoint, and the organization *path* (the first URL segment) is not
 * accepted by the repo-scoped API paths — both verified live.
 */
export async function resolveCodeupOrganizationId(): Promise<string> {
  if (isRegionEdition()) return 'default';

  const explicit = process.env.CODEUP_ORG_ID?.trim();

  if (explicit) return explicit;

  const { lastOrganization } = await codeupWhoami();

  if (lastOrganization) return lastOrganization;

  throw new Error(
    'Could not resolve the Codeup organizationId. Set CODEUP_ORG_ID (from '
      + '云效 组织管理 → 基本信息 → 企业标识), or make sure CODEUP_TOKEN belongs '
      + 'to a user of that organization.',
  );
}

/** URL prefix shared by every repo-scoped OpenAPI path. */
function repoScopedBase(orgId: string, repoId: string): string {
  return isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/repositories/${repoId}`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/repositories/${repoId}`;
}

export class CodeupRepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on Codeup.`);
    this.name = 'CodeupRepoNotFoundError';
  }
}

const RepoNumericIdSchema = z.object({
  id: z.number().int().positive().nullable().optional(),
}).catch({});

/** In-process cache: full repo path → numeric repository ID. */
const numericIdCache = new Map<string, number>();

/**
 * Resolve the numeric repository ID the MR endpoints need, from the
 * `org/group/repo` path. `GET /oapi/v1/codeup/organizations/{orgId}/
 * repositories/{encoded path}` answers it.
 */
export async function getRepositoryNumericId(repo: string): Promise<number> {
  const cached = numericIdCache.get(repo);

  if (cached !== undefined) return cached;

  const token = requireToken();
  const orgId = await resolveCodeupOrganizationId();
  const encoded = encodeURIComponent(repo);
  const base = isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/repositories/${encoded}`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/repositories/${encoded}`;

  const resp = await fetch(base, {
    headers: authHeaders(token),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');

    if (resp.status === 404) {
      throw new CodeupRepoNotFoundError(repo);
    }

    throw new Error(`Failed to look up Codeup repository "${repo}": ${resp.status} ${errBody}`);
  }

  const data = RepoNumericIdSchema.parse(await resp.json());

  if (!data.id) {
    throw new Error(`Codeup answered the repository lookup for "${repo}" without a numeric id.`);
  }

  numericIdCache.set(repo, data.id);

  return data.id;
}

// ─── Repo operations ─────────────────────────────────────

/**
 * Build the clone URL. SSH is the default transport — an SSH key on the
 * machine is the normal Codeup auth and what `teamai init` relies on. When a
 * token was persisted to ~/.netrc together with the account username, HTTPS
 * Basic auth is used instead.
 */
function cloneUrl(repo: string, username: string | null, token: string | null): string {
  if (token && username) {
    return `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${CODEUP_HOST}/${repo}.git`;
  }

  return `git@${CODEUP_HOST}:${repo}.git`;
}

/** Redact an embedded username:token credential from git output before throwing. */
function redactCloneOutput(output: string): string {
  return sanitizeGitUrl(output.replace(/:\/\/[^@\s/]+@/, '://***@')).trim();
}

/** Clone a Codeup repo to localPath. See cloneUrl for the transport choice. */
export function codeupRepoClone(repo: string, localPath: string): void {
  const token = getCodeupToken();
  const username = token ? readNetrcUsername() : null;

  const result = spawnSync('git', ['clone', cloneUrl(repo, username, token), localPath], {
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
    throw new CodeupRepoNotFoundError(repo);
  }

  throw new Error(`git clone failed: ${redactCloneOutput(allOutput)}`);
}

// ─── Change requests (merge requests) ────────────────────

export interface CodeupMrCreateOptions {
  /** Repository in "org/group/repo" format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (usually 'master' or 'main') */
  target: string;
  /** MR title */
  title: string;
  /** MR description */
  description?: string;
  /** Working directory (unused for the REST path, kept for interface parity) */
  cwd?: string;
  spawnTimeoutMs?: number;
}

const CreatedMrSchema = z.object({
  localId: z.union([z.string(), z.number()]).nullish(),
  detailUrl: z.string().nullish(),
}).catch({});

/**
 * Create a merge request ("change request" in Codeup's dialect) via the
 * Yunxiao OpenAPI. Returns the MR web URL (`detailUrl`) on success.
 *
 * Reviewers are not translated: Codeup wants numeric user IDs
 * (reviewerUserIds), which teamai does not resolve; the PR text names them
 * instead.
 */
export async function codeupMrCreate(opts: CodeupMrCreateOptions): Promise<string> {
  const token = requireToken();
  const orgId = await resolveCodeupOrganizationId();
  const numericId = await getRepositoryNumericId(opts.repo);

  const body: Record<string, unknown> = {
    title: opts.title,
    sourceBranch: opts.source,
    targetBranch: opts.target,
    sourceProjectId: String(numericId),
    targetProjectId: String(numericId),
    createFrom: 'WEB',
  };

  if (opts.description) body.description = opts.description;

  const resp = await fetch(`${repoScopedBase(orgId, String(numericId))}/changeRequests`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: opts.spawnTimeoutMs ? AbortSignal.timeout(opts.spawnTimeoutMs) : undefined,
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Failed to create Codeup MR: ${resp.status} ${errBody}`);
  }

  const mr = CreatedMrSchema.parse(await resp.json());

  if (mr.detailUrl) return mr.detailUrl;

  if (mr.localId) {
    // The web path is /change/<id> — verified live (see mrWebUrl).
    return `https://${CODEUP_HOST}/${opts.repo}/change/${mr.localId}`;
  }

  throw new Error('Codeup MR created but response did not include detailUrl.');
}

// ─── Open MR lookup ──────────────────────────────────────

const LOOKUP_PAGE = 50;

/**
 * A listed change request, as the live API answers it. The state field is
 * `state` (verified live: "UNDER_REVIEW"); `status` is tolerated as an alias.
 * Timestamps are `createdAt`/`updatedAt`; `createTime`/`updateTime` are
 * tolerated the same way. `state`: UNDER_DEV / UNDER_REVIEW / TO_BE_MERGED
 * are open, CLOSED ended without merging, MERGED merged — any other value is
 * one this cannot read.
 */
const ListedMrSchema = z.object({
  localId: z.union([z.string(), z.number()]).nullish(),
  title: z.string().nullish(),
  detailUrl: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
  sourceBranch: z.string().nullish(),
  targetBranch: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  createTime: z.string().nullish(),
  updateTime: z.string().nullish(),
  mergedRevision: z.string().nullish(),
  sourceCommitId: z.string().nullish(),
  mergeCommitId: z.string().nullish(),
}).catch({});

function mrWebUrl(repo: string, localId: string | number | null | undefined): string | null {
  if (localId === null || localId === undefined) return null;

  // The web path is /change/<id> — verified live: a created MR answers
  // detailUrl https://codeup.aliyun.com/<org/group/repo>/change/1.
  return `https://${CODEUP_HOST}/${repo}/change/${localId}`;
}

/** Map a Codeup status to the open/merged/closed tri-state, null when unreadable. */
function mrStatusState(status: string | null | undefined): 'open' | 'merged' | 'closed' | null {
  switch (status) {
    case 'UNDER_DEV':
    case 'UNDER_REVIEW':
    case 'TO_BE_MERGED':
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      return null;
  }
}

/**
 * The open change request from `source` into `target` in `repo`, asked of the
 * Yunxiao OpenAPI with the token `getCodeupToken` resolves. Never prompts, and
 * throws, rather than answering none, when Codeup cannot be asked.
 */
export async function codeupFindOpenMr({ repo, source, target, timeoutMs }: PullRequestRef): Promise<string | undefined> {
  const token = requireToken();
  const orgId = await resolveCodeupOrganizationId();
  const numericId = await getRepositoryNumericId(repo);

  const query = new URLSearchParams({
    projectIds: String(numericId),
    state: 'opened',
    perPage: String(LOOKUP_PAGE),
    orderBy: 'created_at',
    sort: 'desc',
  });

  const base = isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/changeRequests`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/changeRequests`;

  const resp = await fetch(`${base}?${query}`, {
    headers: authHeaders(token),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`Codeup answered the open merge request lookup with HTTP ${resp.status}. Check CODEUP_TOKEN and its access to the repository.`);
  }

  const mrs = z.array(ListedMrSchema).catch([]).parse(await resp.json().catch(() => undefined));

  for (const mr of mrs) {
    const state = mrStatusState(mr.state ?? mr.status);

    if (state !== 'open') continue;
    if (mr.sourceBranch !== source || mr.targetBranch !== target) continue;

    const url = mr.detailUrl ?? mrWebUrl(repo, mr.localId);

    if (!url) throw new Error('Codeup answered the open merge request lookup without a request URL.');
    if (!url.startsWith(`https://${CODEUP_HOST}/`)) throw new Error('Codeup answered the open merge request lookup with a URL on another host.');

    return url;
  }

  if (mrs.length >= LOOKUP_PAGE) {
    throw new Error('Codeup listed more open merge requests than one page, so TeamAI cannot tell whether this branch has one.');
  }

  return undefined;
}

/**
 * Every change request from `source` into `target` in `repo`, newest first,
 * with how it ended. Throws, rather than listing none, as
 * `codeupFindOpenMr` does.
 */
export async function codeupMrHistory({ repo, source, target, timeoutMs }: PullRequestRef): Promise<PullRequestRecord[]> {
  const token = requireToken();
  const orgId = await resolveCodeupOrganizationId();
  const numericId = await getRepositoryNumericId(repo);

  // No single "state: all" is documented for the list endpoint, so open,
  // merged and closed are asked separately and combined.
  const states = ['opened', 'merged', 'closed'];
  const base = isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/changeRequests`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/changeRequests`;

  const records: PullRequestRecord[] = [];

  for (const state of states) {
    const query = new URLSearchParams({
      projectIds: String(numericId),
      state,
      perPage: String(LOOKUP_PAGE),
      orderBy: 'created_at',
      sort: 'desc',
    });

    const resp = await fetch(`${base}?${query}`, {
      headers: authHeaders(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`Codeup answered the merge request history lookup with HTTP ${resp.status}. Check CODEUP_TOKEN and its access to the repository.`);
    }

    const mrs = z.array(ListedMrSchema).catch([]).parse(await resp.json().catch(() => undefined));

    if (mrs.length >= LOOKUP_PAGE) {
      throw new Error('Codeup listed more merge requests than one page, so TeamAI cannot tell how this branch\'s requests ended.');
    }

    for (const mr of mrs) {
      if (mr.sourceBranch !== source || mr.targetBranch !== target) continue;

      const mapped = mrStatusState(mr.state ?? mr.status);

      if (mapped === null) throw new Error('Codeup answered the merge request history lookup with a state TeamAI cannot read.');
      const url = mr.detailUrl ?? mrWebUrl(repo, mr.localId);

      if (!url) throw new Error('Codeup answered the merge request history lookup without a request URL.');
      if (!url.startsWith(`https://${CODEUP_HOST}/`)) throw new Error('Codeup answered the merge request history lookup with a URL on another host.');

      const openedAt = mr.createdAt ?? mr.createTime ?? '';
      const closedAt = mr.updatedAt ?? mr.updateTime ?? openedAt;
      const merge = mr.sourceCommitId && (mr.mergedRevision ?? mr.mergeCommitId)
        ? { head: mr.sourceCommitId, commit: mr.mergedRevision ?? mr.mergeCommitId! }
        : undefined;

      records.push(endedRequest({
        url,
        title: mr.title ?? '',
        openedAt,
        state: mapped,
        closedAt,
        merge,
      }));
    }
  }

  return records;
}
