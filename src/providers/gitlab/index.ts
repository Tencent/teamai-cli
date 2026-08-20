import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import type { MRData } from '../../types.js';
import {
  gitlabIsAuthenticated,
  gitlabWhoami,
  ensureGitLabAuthenticated,
  gitlabRepoClone,
  gitlabCreateRepo,
  gitlabMrCreate,
  RepoNotFoundError as GitLabRepoNotFoundError,
} from './gitlab-api.js';
import { gitlabListOrgRepos } from './gitlab-org.js';
import { fetchGitLabMR } from './mr-fetch.js';
import { parseGitLabRepoInput } from './repo-url.js';

/**
 * GitLab provider — supports gitlab.com and self-hosted instances (via the
 * `TEAMAI_GITLAB_HOST` env var). Auth is token-based: a `GITLAB_TOKEN`
 * Personal Access Token, or `glab auth login`. All API operations go through
 * the GitLab v4 REST API.
 */
export class GitLabProvider implements GitProvider {
  readonly name = 'gitlab';

  parseRepoInput(input: string): RepoInfo {
    return parseGitLabRepoInput(input);
  }

  isAuthenticated(): boolean {
    return gitlabIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = await gitlabWhoami();
      if (username) return username;
    }
    return ensureGitLabAuthenticated();
  }

  async ensureInstalled(): Promise<void> {
    // GitLab uses plain git + the REST API; no external CLI is required.
    // (glab is optional and only used to source a token when present.)
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      gitlabRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GitLabRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await gitlabCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return gitlabMrCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      reviewers: opts.reviewers,
    });
  }

  async fetchMergeRequest(url: string): Promise<MRData> {
    return fetchGitLabMR(url);
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return gitlabListOrgRepos(org, opts);
  }
}

// Re-export commonly used items.
export { gitlabIsAuthenticated } from './gitlab-api.js';
export { getGitLabHost, tryGetGitLabToken } from './rest-auth.js';
