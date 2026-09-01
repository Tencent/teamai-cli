import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  gitcodeIsAuthenticated,
  gitcodeWhoami,
  gitcodeRepoClone,
  gitcodeCreateRepo,
  gitcodePullCreate,
  writeNetrcToken,
  GitCodeRepoNotFoundError,
} from './gitcode-api.js';
import { gitcodeListOrgRepos } from './org.js';
import { fetchGitCodeMR } from './mr-fetch.js';
import { parseGitCodeRepoInput, GITCODE_HOST } from './repo-url.js';
import type { MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { askQuestion } from '../../utils/prompt.js';

/**
 * GitCode (gitcode.com) provider.
 *
 * Uses the GitCode Gitee-style REST API v5 directly — no external CLI is
 * required, only a Personal Access Token. See gitcode-api.ts for the token
 * resolution order (GITCODE_TOKEN / GC_TOKEN / ~/.netrc) and the dialect notes
 * that distinguish it from the GitLab provider it is structurally modelled on.
 */
export class GitCodeProvider implements GitProvider {
  readonly name = 'gitcode';

  parseRepoInput(input: string): RepoInfo {
    return parseGitCodeRepoInput(input);
  }

  isAuthenticated(): boolean {
    return gitcodeIsAuthenticated();
  }

  /**
   * Ensure the user is authenticated and return the login name.
   *
   * - A configured token (env or ~/.netrc) is verified via `GET /user`.
   * - Otherwise, on a TTY, the user is prompted to paste a PAT once; a valid
   *   token is persisted to ~/.netrc so later commands (and `git push`) reuse it.
   * - Non-interactive (CI) with no token → a clear error.
   */
  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = await gitcodeWhoami();
      if (username) return username;
      throw new Error(
        'GitCode token is set but was rejected by the API. Check GITCODE_TOKEN / GC_TOKEN, ' +
          'or generate a new Personal Access Token at ' +
          `https://${GITCODE_HOST} → 设置 / Settings → Access Tokens.`,
      );
    }

    if (!process.stdin.isTTY) {
      throw new Error(
        'GitCode authentication unavailable. Set the GITCODE_TOKEN environment variable ' +
          '(a GitCode Personal Access Token). GC_TOKEN is accepted as an alias.',
      );
    }

    log.info(
      `Not logged in to GitCode. Create a Personal Access Token at https://${GITCODE_HOST} → ` +
        '设置 / Settings → Access Tokens, then paste it below.',
    );
    const token = (await askQuestion('Paste your GitCode Personal Access Token: ')).trim();
    if (!token) {
      throw new Error('No token provided. GitCode authentication cancelled.');
    }

    // Make the just-pasted token visible to the verification call (and to the
    // rest of this process, so subsequent clone/push in the same `init` run use
    // it) before persisting.
    process.env.GITCODE_TOKEN = token;
    const username = await gitcodeWhoami();
    if (!username) {
      delete process.env.GITCODE_TOKEN;
      throw new Error('GitCode authentication failed: the pasted token was rejected. Please try again.');
    }
    writeNetrcToken(token);
    log.success('Saved GitCode credentials to ~/.netrc');
    return username;
  }

  async ensureInstalled(): Promise<void> {
    // No external CLI — a token is all that's needed, checked in authenticate().
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      gitcodeRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GitCodeRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await gitcodeCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return gitcodePullCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      cwd: opts.cwd,
    });
  }

  async fetchMergeRequest(url: string): Promise<MRData> {
    return fetchGitCodeMR(url);
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return gitcodeListOrgRepos(org, opts);
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { gitcodeIsAuthenticated, getGitCodeToken } from './gitcode-api.js';
