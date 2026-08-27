import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  ensureGitLabAvailable,
  gitlabIsAuthenticated,
  gitlabWhoami,
  gitlabRepoClone,
  gitlabCreateRepo,
  gitlabMrCreate,
  GitLabRepoNotFoundError,
} from './gitlab-api.js';
import { gitlabListOrgRepos } from './org.js';
import { fetchGitLabMR } from './mr-fetch.js';
import { parseGitLabRepoInput } from './repo-url.js';
import type { MRData } from '../../types.js';

/**
 * GitLab provider (supports self-hosted / enterprise GitLab instances).
 *
 * Uses the GitLab REST API v4 directly — no external CLI is required, only a
 * Personal Access Token (see gitlab-api.ts for env-var conventions).
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
    await ensureGitLabAvailable();
    const username = await gitlabWhoami();
    if (!username) {
      throw new Error('GitLab authentication failed. Please run `teamai init` again.');
    }
    return username;
  }

  async ensureInstalled(): Promise<void> {
    await ensureGitLabAvailable();
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
      cwd: opts.cwd,
    });
  }

  async fetchMergeRequest(url: string): Promise<MRData> {
    return fetchGitLabMR(url);
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return gitlabListOrgRepos(org, opts);
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { gitlabIsAuthenticated, getGitLabToken } from './gitlab-api.js';
