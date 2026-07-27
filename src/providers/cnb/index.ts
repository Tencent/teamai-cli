import type { GitProvider, RepoInfo, PrCreateOptions } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  cnbParseRepoInput,
  cnbIsAuthenticated,
  cnbWhoami,
  ensureCnbAuthenticated,
  ensureCnbInstalled,
  cnbRepoClone,
  cnbCreateRepo,
  cnbPullCreate,
  CnbRepoNotFoundError,
} from './cnb-cli.js';

/**
 * CNB (cnb.cool) provider. Delegates every operation to the `cnb` CLI, mirroring
 * the TGit provider's "thin class over a platform CLI" shape.
 */
export class CNBProvider implements GitProvider {
  readonly name = 'cnb';

  parseRepoInput(input: string): RepoInfo {
    return cnbParseRepoInput(input);
  }

  isAuthenticated(): boolean {
    return cnbIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = cnbWhoami();
      if (username) return username;
    }
    return ensureCnbAuthenticated();
  }

  async ensureInstalled(): Promise<void> {
    await ensureCnbInstalled();
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      cnbRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof CnbRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await cnbCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return cnbPullCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      cwd: opts.cwd,
    });
  }

  getDefaultEmailDomain(): string | null {
    // CNB has no fixed corporate email domain — use the user's git global config.
    return null;
  }
}

export { CnbRepoNotFoundError } from './cnb-cli.js';
