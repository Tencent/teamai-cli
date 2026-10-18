import type { GitProvider, OrgRepoInfo, PrCreateOptions, RepoInfo } from '../types.js';
import type { MRData, MRFetchOptions } from '../../types.js';
import { askSecret, isInteractive } from '../../utils/prompt.js';
import { log } from '../../utils/logger.js';
import { giteaBaseUrl, parseGiteaRepoInput } from './repo-url.js';
import { getGiteaToken, giteaIsAuthenticated, giteaWhoami, writeGiteaNetrcToken, giteaRepoClone, giteaCreateRepo, giteaPullCreate } from './gitea-api.js';
import { giteaListOrgRepos, giteaOrganizationExists } from './org.js';
import { fetchGiteaMR } from './mr-fetch.js';

// init / push / import → GiteaProvider → REST or Git transport.

export class GiteaProvider implements GitProvider {
  readonly name = 'gitea';

  parseRepoInput(input: string): RepoInfo { return parseGiteaRepoInput(input); }
  isAuthenticated(): boolean { return giteaIsAuthenticated(); }

  /** Verify configured credentials; only a missing token can start a TTY prompt. */
  async authenticate(): Promise<string> {
    giteaBaseUrl();
    if (getGiteaToken()) return giteaWhoami();
    if (!isInteractive()) throw new Error('Gitea authentication unavailable. Set GITEA_TOKEN before running without a TTY.');
    log.info(`Create a Personal Access Token at ${giteaBaseUrl()}/user/settings/applications.`);
    const token = (await askSecret('Paste your Gitea Personal Access Token: ')).trim();
    if (!token) throw new Error('No token provided. Gitea authentication cancelled.');
    const login = await giteaWhoami(token);
    writeGiteaNetrcToken(token, login);
    log.success('Saved Gitea credentials to ~/.netrc');
    return login;
  }

  async ensureInstalled(): Promise<void> { /* Git and Node are already CLI prerequisites. */ }
  cloneRepo(repo: string, localPath: string): void { giteaRepoClone(repo, localPath); }
  async createRepo(owner: string, repo: string): Promise<void> { await giteaCreateRepo(owner, repo); }
  async createPullRequest(options: PrCreateOptions): Promise<string> { return giteaPullCreate(options); }
  async fetchMergeRequest(url: string, opts?: MRFetchOptions): Promise<MRData> { return fetchGiteaMR(url, opts); }
  async listOrgRepos(org: string, options?: { maxRepos?: number }): Promise<OrgRepoInfo[]> { return giteaListOrgRepos(org, options); }
  organizationExists(org: string): boolean { return giteaOrganizationExists(org); }
  getOrganizationCreateUrl(): string { return `${giteaBaseUrl()}/org/create`; }
  getDefaultEmailDomain(): null { return null; }
}

export { giteaIsAuthenticated, getGiteaToken } from './gitea-api.js';
