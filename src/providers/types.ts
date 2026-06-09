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

export interface GitProvider {
  /** Provider identifier: 'github' | 'tgit' */
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
   * Clone a repo to localPath. Should embed credentials in
   * the remote URL so subsequent git ops work without extra auth.
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
