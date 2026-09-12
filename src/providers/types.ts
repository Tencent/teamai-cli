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
