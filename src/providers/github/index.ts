import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  ensureGhAvailable,
  ghIsAuthenticated,
  ghAuthWhoami,
  ensureGhAuthenticated,
  ghRepoClone,
  ghCreateRepo,
  ghPrCreate,
  RepoNotFoundError as GhRepoNotFoundError,
} from './gh-cli.js';
import { ghListOrgRepos } from './gh-org.js';
import { parseGitHubRepoInput } from './repo-url.js';

export class GitHubProvider implements GitProvider {
  readonly name = 'github';

  parseRepoInput(input: string): RepoInfo {
    return parseGitHubRepoInput(input);
  }

  isAuthenticated(): boolean {
    return ghIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = await ghAuthWhoami();
      if (username) return username;
    }
    return ensureGhAuthenticated();
  }

  async ensureInstalled(): Promise<void> {
    await ensureGhAvailable();
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      ghRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GhRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await ghCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return ghPrCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      reviewers: opts.reviewers,
      cwd: opts.cwd,
    });
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return ghListOrgRepos(org, opts);
  }
}

export {
  ghIsAuthenticated,
  ghGetOAuthToken,
  isGhInstalled,
} from './gh-cli.js';
