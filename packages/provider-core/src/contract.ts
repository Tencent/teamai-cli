export interface RepoInfo {
  owner: string;
  repo: string;
  /** Canonical clone URL. The legacy name is retained; generic Git may return an SSH URL. */
  httpsUrl: string;
  /** URL-encoded owner/repo for API calls. */
  projectId: string;
}

export interface PrCreateOptions {
  repo: string;
  source: string;
  target: string;
  title: string;
  description?: string;
  reviewers?: string[];
  cwd?: string;
  spawnTimeoutMs?: number;
}

export interface PullRequestRef {
  repo: string;
  source: string;
  target: string;
  timeoutMs: number;
}

export interface CommitRef {
  repo: string;
  commit: string;
  timeoutMs: number;
}

export type CiStatus = 'passed' | 'failed' | 'pending' | 'none';

export interface PullRequestLookup {
  findOpen(ref: PullRequestRef): Promise<string | undefined>;
  history(ref: PullRequestRef): Promise<PullRequestRecord[]>;
  checks?(ref: CommitRef): Promise<CiStatus>;
}

export type PullRequestRecord = { url: string; title: string; openedAt: string } & (
  | { state: 'open' }
  | { state: 'closed'; closedAt: string }
  | { state: 'merged'; closedAt: string; merge?: MergedAs }
);

export type MergedAs = { head: string; commit: string };

export function endedRequest({ url, title, openedAt, state, closedAt, merge }: { url: string; title: string; openedAt: string; state: string; closedAt: string | null | undefined; merge?: MergedAs }): PullRequestRecord {
  if (state === 'opened' || state === 'reopened' || state === 'open') return { url, title, openedAt, state: 'open' };

  if (state !== 'merged') return { url, title, openedAt, state: 'closed', closedAt: closedAt ?? openedAt };

  return { url, title, openedAt, state: 'merged', closedAt: closedAt ?? openedAt, merge: merge || undefined };
}

export function mergedAs({ head, commit }: { head: string | null | undefined; commit: string | null | undefined }): MergedAs | undefined {
  return head && commit ? { head, commit } : undefined;
}

export interface OrgRepoInfo {
  url: string;
  fullName: string;
  name: string;
  description?: string;
  primaryLanguage?: string;
  archived?: boolean;
  stars?: number;
  pushedAt?: string;
}

/** The source-control provider contract. The merge-request payload stays app-defined until its import slice moves. */
export interface Provider<TMergeRequest = unknown> {
  readonly name: string;
  parseRepoInput(input: string): RepoInfo;
  isAuthenticated(): boolean;
  authenticate(): Promise<string>;
  ensureInstalled(): Promise<void>;
  cloneRepo(repo: string, localPath: string): void;
  createRepo(owner: string, repo: string): Promise<void>;
  createPullRequest(opts: PrCreateOptions): Promise<string>;
  readonly pullRequests: PullRequestLookup | null;
  fetchMergeRequest?(url: string): Promise<TMergeRequest>;
  listOrgRepos?(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]>;
  organizationExists?(org: string): boolean;
  getOrganizationCreateUrl?(): string | null;
  getDefaultEmailDomain(): string | null;
}

export class RepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found.`);
    this.name = 'RepoNotFoundError';
  }
}

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
