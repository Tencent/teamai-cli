// ─── Git Provider Interface ──────────────────────────────
//
// Abstraction layer for git hosting platforms.
// Each provider implements authentication, repo operations,
// and pull/merge request creation for its platform.
//
//  Caller (init/push/remove)
//      │
//      ▼
//  getProvider(config)  ──► GitProvider
//      │                     │
//      ▼                     ▼
//  provider.cloneRepo()   provider.createPullRequest()
//  provider.authenticate()
//

export interface RepoInfo {
  owner: string;
  repo: string;
  /** Canonical clone URL. The legacy name is retained; generic Git may return an SSH URL. */
  httpsUrl: string;
  /** URL-encoded owner/repo for API calls */
  projectId: string;
}

export interface PrCreateOptions {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Source branch name */
  source: string;
  /** Target branch name (usually 'master' or 'main') */
  target: string;
  /** PR/MR title */
  title: string;
  /** PR/MR description */
  description?: string;
  /** Reviewer usernames */
  reviewers?: string[];
  /** Working directory for CLI operations */
  cwd?: string;
}

/**
 * 轻量级仓库元信息，用于 listOrgRepos 返回。
 */
export interface OrgRepoInfo {
  /** HTTPS clone URL */
  url: string;
  /** owner/repo（含可能的多级 group） */
  fullName: string;
  /** 仅 repo 名 */
  name: string;
  /** 来自 GitHub topic / TGit description */
  description?: string;
  primaryLanguage?: string;
  /** 已 archive 的仓库（默认排除） */
  archived?: boolean;
  stars?: number;
  /** ISO 时间 */
  pushedAt?: string;
}

export interface GitProvider {
  /** Registered provider identifier, e.g. 'github', 'tgit', 'cnb', or 'git'. */
  readonly name: string;

  // ─── URL parsing ──────────────────────────────────────

  /** Parse user input (URL or short format) into RepoInfo */
  parseRepoInput(input: string): RepoInfo;

  // ─── Authentication ───────────────────────────────────

  /** Check if user is currently authenticated */
  isAuthenticated(): boolean;

  /**
   * Ensure user is authenticated. May trigger interactive login.
   * Returns the authenticated username.
   */
  authenticate(): Promise<string>;

  /**
   * Ensure any required CLI tools are installed.
   * No-op if the provider doesn't need external tools.
   */
  ensureInstalled(): Promise<void>;

  // ─── Repository operations ────────────────────────────

  /**
   * Clone a repo to localPath. The resulting origin remote must remain usable
   * for later pull/push operations via provider credentials, a Git credential
   * helper, or SSH agent.
   */
  cloneRepo(repo: string, localPath: string): void;

  /**
   * Create a new repo on the platform.
   * Throws if creation fails.
   */
  createRepo(owner: string, repo: string): Promise<void>;

  // ─── Pull/Merge requests ──────────────────────────────

  /**
   * Create a pull request (GitHub) or merge request (TGit/GitLab).
   * Returns the PR/MR web URL on success.
   *
   * Async because some providers (e.g. GitHub) use REST API calls internally.
   * Providers that only shell out to a CLI may return a resolved promise.
   */
  createPullRequest(opts: PrCreateOptions): Promise<string>;

  /**
   * 获取指定 MR/PR 的完整数据（标题、描述、提交列表、diff）。
   *
   * 此方法为可选实现，不支持的 provider 可不实现（接口中用 ? 标记）。
   * url 为 MR/PR 的完整 web URL，例如：
   *   GitHub: https://github.com/owner/repo/pull/123
   *   TGit:   https://git.woa.com/group/repo/merge_requests/456
   */
  fetchMergeRequest?(url: string): Promise<import('../types.js').MRData>;

  /**
   * 列出 org / group / namespace 下的所有仓库（轻量元信息）。
   *
   * 实现可分页拉取，但本调用应返回完整列表（或 maxRepos 上限）。
   *
   * @param org      组织或 group 路径（如 "team-org" / "team-group/sub"）
   * @param opts.maxRepos  上限保护，默认 200
   * @throws Error 当未实现或 API 调用失败
   */
  listOrgRepos?(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]>;

  /**
   * Check whether an organization / group exists on the platform.
   *
   * Optional: providers whose platform exposes a cheap read-only lookup (e.g.
   * CNB's `get-group`) implement this so `init` can detect a missing org
   * *before* prompting to create the repo, and guide the user to create the org
   * first. Providers that omit it fall back to the create-repo error path.
   *
   * @param org  organization / group path (may be a nested `group/subgroup`)
   * @returns true if it exists, false if not found
   * @throws Error if existence cannot be determined (e.g. network/auth failure)
   */
  organizationExists?(org: string): boolean;

  /**
   * Web URL where a user can create an organization on this platform, or null
   * if there is no such page. `init` prints/opens it when the org is missing.
   */
  getOrganizationCreateUrl?(): string | null;

  // ─── Utilities ────────────────────────────────────────

  /**
   * Default email domain for git commits on this platform.
   * e.g. 'tencent.com' for TGit, null for GitHub (use git global config).
   */
  getDefaultEmailDomain(): string | null;
}

/** Error indicating a repo was not found on the remote platform. */
export class RepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found.`);
    this.name = 'RepoNotFoundError';
  }
}

/**
 * Error indicating an organization / group was not found on the remote
 * platform. Thrown by `createRepo` when the target namespace does not exist.
 *
 * `createUrl`, when set, is the platform's web page for creating an
 * organization. `init` prints it so the user can create the org in the browser
 * — CNB's CLI token cannot create organizations itself (that needs the
 * `group-manage:rw` scope, which the device-flow login does not grant).
 */
export class OrganizationNotFoundError extends Error {
  readonly org: string;
  readonly createUrl?: string;
  constructor(org: string, createUrl?: string) {
    super(`Organization "${org}" not found.`);
    this.name = 'OrganizationNotFoundError';
    this.org = org;
    this.createUrl = createUrl;
  }
}

/**
 * Error indicating the authenticated token lacks permission to create a repo
 * (e.g. CNB requires the `group-resource:rw` scope for org repos, which the
 * device-flow login does not grant). `createUrl`, when set, is the platform's
 * web page for creating the repo so `init` can guide the user to the browser.
 */
export class RepoCreatePermissionError extends Error {
  readonly repo: string;
  readonly createUrl?: string;
  constructor(repo: string, createUrl?: string) {
    super(`No permission to create repo "${repo}".`);
    this.name = 'RepoCreatePermissionError';
    this.repo = repo;
    this.createUrl = createUrl;
  }
}

// ─── Resource delivery providers ─────────────────────────
//
// A higher-level abstraction than GitProvider (above). GitProvider adapts a
// *git host* (github/tgit/gitlab/…); a ResourceProvider adapts a *resource
// sync mechanism* — either `git` (clone a team repo, the existing behavior) or
// `http` (talk to an HTTP backend such as ClawPro). Multiple named providers
// can be mounted side by side, each syncing independently and isolated from the
// others' failures.
//
//  ResourceProvider
//  ├── git   (wraps the existing team-repo pull; GitProvider is used inside)
//  └── http  (HttpResourceProvider → HttpBackendAdapter)
//                                      └── clawpro adapter
//
// See docs/designs/management-backend.md §8 and issue #404. The ownership
// ledger, priority arbitration and cross-provider failover it describes are a
// later phase; `priority` is carried here so those phases need no type change,
// but nothing consumes it for arbitration yet.

/** Whether a provider syncs via a git repo or an HTTP backend. */
export type ResourceProviderType = 'git' | 'http';

/**
 * What a provider can do. Callers gate work on these instead of assuming every
 * provider implements git clone / push / command execution.
 * - `pull`:     delivers resources into the local tool directories.
 * - `push`:     can be a write target for `teamai push` (git main only; HTTP
 *               backends and cross-team git sources are read-only → false).
 * - `report`:   sends usage/telemetry to a backend on hook dispatch.
 * - `commands`: executes commands the backend pushes back (install/uninstall/…).
 */
export interface ProviderCapabilities {
  pull: boolean;
  push: boolean;
  report: boolean;
  commands: boolean;
}

/** Why and where a sync was triggered. */
export interface SyncContext {
  /** Working directory the sync runs for (workspace attribution). */
  cwd?: string;
  /** Host tool that triggered the sync (e.g. 'claude', 'codebuddy'). */
  tool?: string;
  /** What initiated this sync. */
  trigger: 'hook' | 'pull' | 'manual';
  /** Raw hook STDIN payload, when trigger === 'hook'. */
  stdin?: Record<string, unknown>;
  /** Bypass any pull TTL / freshness cache. */
  force?: boolean;
}

/** Outcome of a single provider's sync. */
export interface ProviderResult {
  /** Provider name this result is for. */
  provider: string;
  /** Whether the sync completed without error. */
  ok: boolean;
  /** Whether the sync changed anything on disk. */
  changed: boolean;
  /** Human-readable status or error, for logs / CLI output. */
  message?: string;
  /** Text a protocol adapter asks the host to emit on its hook stdout. */
  hookOutput?: string;
}

/** Static description of a provider, for `teamai provider list` and diagnostics. */
export interface ProviderSummary {
  name: string;
  type: ResourceProviderType;
  priority: number;
  capabilities: ProviderCapabilities;
  /** HTTP backend endpoint, when type === 'http'. */
  endpoint?: string;
  /** HTTP protocol adapter name, when type === 'http'. */
  adapter?: string;
}

/**
 * A mounted resource backend. Named uniquely within a registry. `sync` is the
 * one hot-path method; `describe`/`teardown` support listing and removal.
 */
export interface ResourceProvider {
  readonly name: string;
  readonly type: ResourceProviderType;
  /**
   * Ordering hint for later multi-provider arbitration (higher wins). Carried
   * now so the arbitration phase needs no interface change; not yet consumed
   * for same-name resource conflict resolution.
   */
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  /** Deliver resources / report usage for this trigger. */
  sync(context: SyncContext): Promise<ProviderResult>;
  /** Return a static summary for listing and diagnostics. */
  describe(): Promise<ProviderSummary>;
  /** Remove this provider's local state (credentials, manifests, caches). */
  teardown(): Promise<void>;
}

/** Logical route names an HTTP backend exposes, resolved to paths per adapter. */
export interface HttpRoutes {
  projects: string;
  report: string;
  sync: string;
  ack: string;
  getConfig: string;
}

/** Persisted configuration for one named HTTP provider. */
export interface HttpProviderConfig {
  /** Unique provider name (also the state-directory segment). */
  name: string;
  /** Protocol adapter that speaks this backend's wire format (e.g. 'clawpro'). */
  adapter: string;
  /** Backend base URL. */
  endpoint: string;
  /** Arbitration hint (see ResourceProvider.priority). */
  priority: number;
}

/**
 * Translates one HTTP backend's wire format to the common ResourceProvider
 * shape. The HTTP provider owns transport concerns generically; the adapter
 * owns only protocol differences (routes and payload/command shapes).
 */
export interface HttpBackendAdapter {
  readonly name: string;
  /** Route table for this backend, given its config (defaults + overrides). */
  routes(config: HttpProviderConfig): HttpRoutes;
  /** One-time setup for a newly added provider (e.g. persist a token). */
  initialize?(config: HttpProviderConfig, token?: string): Promise<void>;
  /** Run report/sync/command execution for this provider. */
  sync(config: HttpProviderConfig, context: SyncContext): Promise<ProviderResult>;
  /** Static summary for listing. */
  describe(config: HttpProviderConfig): Promise<ProviderSummary>;
  /** Remove this provider's local state. */
  teardown(config: HttpProviderConfig): Promise<void>;
}
