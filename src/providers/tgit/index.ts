import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  ensureGfInstalled,
  gfIsAuthenticated,
  gfAuthWhoami,
  ensureAuthenticated,
  gfRepoClone,
  gfCreateRepo,
  gfMrCreate,
  gfGetOAuthToken,
  RepoNotFoundError as GfRepoNotFoundError,
} from './gf-cli.js';
import { gfListOrgRepos } from './gf-org.js';
import { parseTGitRepoInput } from './repo-url.js';

export class TGitProvider implements GitProvider {
  readonly name = 'tgit';

  parseRepoInput(input: string): RepoInfo {
    return parseTGitRepoInput(input);
  }

  isAuthenticated(): boolean {
    return gfIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = gfAuthWhoami();
      if (username) return username;
    }
    return ensureAuthenticated();
  }

  async ensureInstalled(): Promise<void> {
    await ensureGfInstalled();
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      gfRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GfRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await gfCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return gfMrCreate({
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
    return 'tencent.com';
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return gfListOrgRepos(org, opts);
  }
}

// Re-export commonly used items for backward compatibility
export { gfIsAuthenticated, gfGetOAuthToken, isGfInstalled } from './gf-cli.js';
