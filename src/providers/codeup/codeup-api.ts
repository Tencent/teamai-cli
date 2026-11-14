import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { endedRequest, mergedAs, type PullRequestRecord, type PullRequestRef } from '../types.js';
import { CODEUP_HOST, type CodeupTransport } from './repo-url.js';
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
 * Git transport follows the URL the member typed (see codeupCloneTransport):
 * an https:// URL clones over HTTPS, an SSH URL or the bare `org/group/repo`
 * form over SSH, and CODEUP_TRANSPORT=https|ssh overrides. An HTTPS clone
 * embeds the PAT as the Basic password when its username is known too (the
 * interactive `init` flow persists both); otherwise the member's own git
 * credential setup authenticates, exactly as the generic git provider's.
 */

// ─── Config ──────────────────────────────────────────────

const CODEUP_API_BASE = 'https://openapi-rdc.aliyuncs.com';

export function codeupApiBase(): string {
  const override = process.env.CODEUP_API_BASE_URL?.trim();

  return override || CODEUP_API_BASE;
}

/** True when targeting a Region 版 Yunxiao OpenAPI (no organization path segment). */
export function isRegionEdition(): boolean {
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

/** The credentials of the codeup entry of a netrc file, either part absent when not stated. */
interface NetrcEntry {
  login: string | null;
  password: string | null;
}

/**
 * The codeup.aliyun.com entry of a tokenized netrc file: `machine
 * codeup.aliyun.com` followed by keyword/value pairs (`login`, `password`,
 * `account`) in any order, on one line or many, up to the next `machine`.
 */
function findNetrcEntry(tokens: string[]): NetrcEntry | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== 'machine' || tokens[i + 1] !== CODEUP_HOST) continue;

    const entry: NetrcEntry = { login: null, password: null };

    for (let j = i + 2; j < tokens.length - 1 && tokens[j] !== 'machine'; j += 2) {
      if (tokens[j] === 'login') entry.login = tokens[j + 1] ?? null;
      else if (tokens[j] === 'password') entry.password = tokens[j + 1] ?? null;
      else break;
    }

    return entry;
  }

  return null;
}

/** The codeup entry of the first netrc file that has one, or null. */
function readNetrcEntry(): NetrcEntry | null {
  for (const file of netrcReadPaths()) {
    let content: string;

    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // Missing or unreadable here — try the next location.
    }

    const entry = findNetrcEntry(content.split(/\s+/).filter(Boolean));

    // A machine line with no credential is not the entry — keep looking, so a
    // legacy home's complete entry still answers.
    if (entry && (entry.login || entry.password)) return entry;
  }

  return null;
}

/** Read the codeup.aliyun.com token from ~/.netrc, or null when absent/unreadable. */
export function readNetrcToken(): string | null {
  return readNetrcEntry()?.password ?? null;
}

/** The username stored alongside the token in ~/.netrc, or null. */
export function readNetrcUsername(): string | null {
  return readNetrcEntry()?.login ?? null;
}

/**
 * Persist the token to ~/.netrc (mode 0600). Replaces any existing
 * codeup.aliyun.com entry — written on one line or many — so re-authenticating
 * overwrites rather than duplicates or orphans its credential lines.
 */
export function writeNetrcToken(token: string, username: string): void {
  const file = netrcPath();
  let existing = '';

  try {
    existing = fs.readFileSync(file, 'utf-8');
  } catch {
    // no existing file — start fresh
  }

  const codeupMachine = new RegExp(`^machine\\s+${CODEUP_HOST.replaceAll('.', '\\.')}($|\\s)`);
  const kept: string[] = [];
  let inEntry = false;

  for (const line of existing.split('\n')) {
    const trimmed = line.trim();

    if (/^machine\s/.test(trimmed) || trimmed === 'default') {
      inEntry = codeupMachine.test(trimmed);

      if (inEntry) continue;
    } else if (inEntry && trimmed !== '') {
      continue; // A login/password/account continuation line of the entry.
    }

    kept.push(line);
  }

  const entry = `machine ${CODEUP_HOST} login ${username} password ${token}`;
  const filtered = kept.join('\n').replace(/\n+$/, '');
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

// ─── Codeup-specific config (~/.teamai/codeup.json) ──────
//
// Small provider-scoped store for the two values a codeup-scope-only PAT
// cannot discover on its own: the organizationId and the login username
// (a PAT without platform scope answers no user endpoint — verified live).
// The environment variables CODEUP_ORG_ID / CODEUP_USERNAME take precedence.

const CodeupConfigSchema = z.object({
  organizationId: z.string().optional(),
  username: z.string().optional(),
}).catch({});

type CodeupConfig = z.infer<typeof CodeupConfigSchema>;

function codeupConfigPath(): string {
  return path.join(getUserHome(), '.teamai', 'codeup.json');
}

function loadCodeupConfig(): CodeupConfig {
  try {
    return CodeupConfigSchema.parse(JSON.parse(fs.readFileSync(codeupConfigPath(), 'utf-8')));
  } catch {
    return {};
  }
}

function saveCodeupConfig(values: CodeupConfig): void {
  const file = codeupConfigPath();
  const next = { ...loadCodeupConfig(), ...values };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });

  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

/** The organizationId from CODEUP_ORG_ID, then ~/.teamai/codeup.json. */
export function configuredOrganizationId(): string | null {
  const fromEnv = process.env.CODEUP_ORG_ID?.trim();

  if (fromEnv) return fromEnv;

  return loadCodeupConfig().organizationId ?? null;
}

/** The username from CODEUP_USERNAME, then ~/.teamai/codeup.json. */
export function configuredUsername(): string | null {
  const fromEnv = process.env.CODEUP_USERNAME?.trim();

  if (fromEnv) return fromEnv;

  return loadCodeupConfig().username ?? null;
}

/** Persist codeup provider settings (organizationId / username) for later runs. */
export function saveCodeupSettings(values: { organizationId?: string; username?: string }): void {
  saveCodeupConfig(values);
}

// ─── Repository / organization resolution ────────────────

/**
 * Resolve the organizationId the OpenAPI paths need.
 * Precedence: CODEUP_ORG_ID env var, then ~/.teamai/codeup.json (written by
 * the interactive init flow), then the authenticated user's lastOrganization.
 * In practice CODEUP_ORG_ID is the reliable source: a PAT created with only
 * codeup scope (the common case) cannot call the platform user endpoint, and
 * the organization *path* (the first URL segment) is not accepted by the
 * repo-scoped API paths — both verified live.
 */
export async function resolveCodeupOrganizationId(): Promise<string> {
  if (isRegionEdition()) return 'default';

  const configured = configuredOrganizationId();

  if (configured) return configured;

  const { lastOrganization } = await codeupWhoami();

  if (lastOrganization) return lastOrganization;

  throw new Error(
    'Could not resolve the Codeup organizationId. Set CODEUP_ORG_ID (the '
      + 'numeric 企业标识 from 云效 组织管理 → 基本信息), or let `teamai init` save '
      + 'it to ~/.teamai/codeup.json interactively.',
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

// ─── Token validation (codeup scope) ─────────────────────

export interface CodeupTokenProbe {
  /** True when the endpoint answered 200 — the token works for the codeup domain. */
  ok: boolean;
  /** The HTTP status of the probe, when the endpoint answered. */
  status?: number;
}

/**
 * Validate a token with a codeup-scoped call: the org repository list.
 * A PAT with only codeup scope cannot answer /oapi/v1/platform/user (403 —
 * verified live), but `GET …/organizations/{orgId}/repositories` is exactly
 * what its scope covers, so a 200 here proves both the token and the org id.
 */
export async function probeCodeupToken(orgId: string): Promise<CodeupTokenProbe> {
  const token = requireToken();

  const base = isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/repositories`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/repositories`;

  try {
    const resp = await fetch(`${base}?perPage=1`, {
      headers: authHeaders(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });

    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false };
  }
}

// ─── Repo operations ─────────────────────────────────────

/**
 * The transport to clone with: `CODEUP_TRANSPORT` overrides, then the scheme
 * of the URL the member typed (parseRepoInput records it on the provider),
 * then SSH for the bare `org/group/repo` form — an SSH key on the machine is
 * the normal Codeup git auth, as it is for the generic git provider's SSH
 * URLs. An HTTPS URL never becomes an SSH clone: a member with HTTPS git
 * sign-in and no SSH key is exactly whom the typed scheme speaks for.
 */
export function codeupCloneTransport(inputTransport: CodeupTransport | null): CodeupTransport {
  const override = process.env.CODEUP_TRANSPORT?.trim().toLowerCase();

  if (override === 'https' || override === 'ssh') return override;

  return inputTransport ?? 'ssh';
}

/**
 * Build the clone URL for the resolved transport. An HTTPS clone embeds the
 * PAT as the Basic password only when the username is known too (the
 * interactive init flow persists both, and CODEUP_USERNAME /
 * ~/.teamai/codeup.json / ~/.netrc carry them later); with either unknown the
 * URL stays plain and the member's git credential setup authenticates, exactly
 * as the generic git provider's HTTPS clone does. PAT-as-git-password is not a
 * verified path on every deployment, so CODEUP_TRANSPORT=ssh opts back out.
 */
function cloneUrl(repo: string, transport: CodeupTransport, username: string | null, token: string | null): string {
  if (transport === 'https') {
    return token && username
      ? `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${CODEUP_HOST}/${repo}.git`
      : `https://${CODEUP_HOST}/${repo}.git`;
  }

  return `git@${CODEUP_HOST}:${repo}.git`;
}

/** The URL `codeupRepoClone` clones: transport from the input scheme and env, credentials when both are known. */
export function codeupCloneUrl(repo: string, inputTransport: CodeupTransport | null = null): string {
  const token = getCodeupToken();
  const username = token ? configuredUsername() ?? readNetrcUsername() : null;

  return cloneUrl(repo, codeupCloneTransport(inputTransport), username, token);
}

/** Redact an embedded username:token credential from git output before throwing. */
function redactCloneOutput(output: string): string {
  return sanitizeGitUrl(output.replace(/:\/\/[^@\s/]+@/, '://***@')).trim();
}

/** Clone a Codeup repo to localPath. See codeupCloneUrl for the transport choice. */
export function codeupRepoClone(repo: string, localPath: string, inputTransport: CodeupTransport | null = null): void {
  const result = spawnSync('git', ['clone', codeupCloneUrl(repo, inputTransport), localPath], {
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

  const body = {
    title: opts.title,
    sourceBranch: opts.source,
    targetBranch: opts.target,
    sourceProjectId: String(numericId),
    targetProjectId: String(numericId),
    createFrom: 'WEB',
    // JSON.stringify drops the key when description is absent.
    description: opts.description,
  };

  const resp = await fetch(`${repoScopedBase(orgId, String(numericId))}/changeRequests`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.spawnTimeoutMs ?? 30_000),
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

/** Hard cap on pages read per state, so a lookup stays bounded on a busy repo. */
const LOOKUP_MAX_PAGES = 10;

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
});

type ListedMr = z.infer<typeof ListedMrSchema>;

/** The change request list endpoint: org-scoped in the central edition, flat in a Region 版. */
function mrListBase(orgId: string): string {
  return isRegionEdition()
    ? `${codeupApiBase()}/oapi/v1/codeup/changeRequests`
    : `${codeupApiBase()}/oapi/v1/codeup/organizations/${orgId}/changeRequests`;
}

/**
 * One page of the change request list, parsed strictly: a body that is not a
 * list of requests throws — an unreadable answer is never "no requests".
 */
async function fetchMrPage(lookup: string, base: string, query: URLSearchParams, token: string, timeoutMs: number): Promise<ListedMr[]> {
  const resp = await fetch(`${base}?${query}`, {
    headers: authHeaders(token),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`Codeup answered the ${lookup} with HTTP ${resp.status}. Check CODEUP_TOKEN and its access to the repository.`);
  }

  const mrs = z.array(ListedMrSchema).safeParse(await resp.json().catch(() => undefined));

  if (!mrs.success) {
    throw new Error(`Codeup answered the ${lookup} with data TeamAI cannot read.`);
  }

  return mrs.data;
}

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
 * Yunxiao OpenAPI with the token `getCodeupToken` resolves. The list endpoint
 * filters by repo but not by branch, so pages are read until the list is
 * exhausted or the cap is hit. Never prompts, and throws, rather than
 * answering none, when Codeup cannot be asked or answers what this cannot read.
 */
export async function codeupFindOpenMr({ repo, source, target, timeoutMs }: PullRequestRef): Promise<string | undefined> {
  const token = requireToken();
  const orgId = await resolveCodeupOrganizationId();
  const numericId = await getRepositoryNumericId(repo);
  const base = mrListBase(orgId);

  for (let page = 1; page <= LOOKUP_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      projectIds: String(numericId),
      state: 'opened',
      perPage: String(LOOKUP_PAGE),
      page: String(page),
      orderBy: 'created_at',
      sort: 'desc',
    });

    const mrs = await fetchMrPage('open merge request lookup', base, query, token, timeoutMs);

    for (const mr of mrs) {
      if (mr.sourceBranch !== source || mr.targetBranch !== target) continue;

      const state = mrStatusState(mr.state ?? mr.status);

      if (state === null) throw new Error('Codeup listed a merge request for this branch with a state TeamAI cannot read.');

      if (state !== 'open') continue;

      const url = mr.detailUrl ?? mrWebUrl(repo, mr.localId);

      if (!url) throw new Error('Codeup answered the open merge request lookup without a request URL.');

      if (!url.startsWith(`https://${CODEUP_HOST}/`)) throw new Error('Codeup answered the open merge request lookup with a URL on another host.');

      return url;
    }

    if (mrs.length < LOOKUP_PAGE) return undefined;
  }

  throw new Error('Codeup listed more open merge requests than TeamAI reads, so it cannot tell whether this branch has one.');
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
  const base = mrListBase(orgId);
  const records: PullRequestRecord[] = [];

  for (const state of states) {
    for (let page = 1; page <= LOOKUP_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        projectIds: String(numericId),
        state,
        perPage: String(LOOKUP_PAGE),
        page: String(page),
        orderBy: 'created_at',
        sort: 'desc',
      });

      const mrs = await fetchMrPage('merge request history lookup', base, query, token, timeoutMs);

      for (const mr of mrs) {
        if (mr.sourceBranch !== source || mr.targetBranch !== target) continue;

        const mapped = mrStatusState(mr.state ?? mr.status);

        if (mapped === null) throw new Error('Codeup answered the merge request history lookup with a state TeamAI cannot read.');

        const url = mr.detailUrl ?? mrWebUrl(repo, mr.localId);

        if (!url) throw new Error('Codeup answered the merge request history lookup without a request URL.');

        if (!url.startsWith(`https://${CODEUP_HOST}/`)) throw new Error('Codeup answered the merge request history lookup with a URL on another host.');

        const openedAt = mr.createdAt ?? mr.createTime ?? '';
        const closedAt = mr.updatedAt ?? mr.updateTime ?? openedAt;

        records.push(endedRequest({
          url,
          title: mr.title ?? '',
          openedAt,
          state: mapped,
          closedAt,
          merge: mergedAs({ head: mr.sourceCommitId, commit: mr.mergedRevision ?? mr.mergeCommitId }),
        }));
      }

      if (mrs.length < LOOKUP_PAGE) break;

      if (page === LOOKUP_MAX_PAGES) throw new Error('Codeup listed more merge requests than TeamAI reads, so it cannot tell how this branch\'s requests ended.');
    }
  }

  // Each state's pages arrive newest first; the combined history must be too.
  return records.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
