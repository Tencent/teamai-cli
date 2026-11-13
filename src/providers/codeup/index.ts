import type { GitProvider, PrCreateOptions, PullRequestLookup, RepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  codeupIsAuthenticated,
  codeupWhoami,
  codeupRepoClone,
  codeupMrCreate,
  codeupFindOpenMr,
  codeupMrHistory,
  writeNetrcToken,
  CodeupRepoNotFoundError,
} from './codeup-api.js';
import { parseCodeupRepoInput, CODEUP_HOST } from './repo-url.js';
import { log } from '../../utils/logger.js';
import { askQuestion, isInteractive } from '../../utils/prompt.js';

/**
 * Codeup (阿里云云效代码管理, codeup.aliyun.com) provider.
 *
 * Uses the Yunxiao OpenAPI directly — no external CLI is required, only a
 * Personal Access Token. See codeup-api.ts for the token resolution order
 * (CODEUP_TOKEN / YUNXIAO_TOKEN / ~/.netrc) and the dialect notes that
 * distinguish it from the GitLab provider it is structurally modelled on.
 *
 * Git transport is SSH (`git@codeup.aliyun.com:org/group/repo.git`) — the
 * SSH key on the machine authenticates clone/push, exactly as the generic
 * `git` provider does. The PAT is only needed for OpenAPI calls such as
 * merge request creation.
 */
export class CodeupProvider implements GitProvider {
  readonly name = 'codeup';
  readonly pullRequests: PullRequestLookup = { findOpen: codeupFindOpenMr, history: codeupMrHistory };

  parseRepoInput(input: string): RepoInfo {
    return parseCodeupRepoInput(input);
  }

  isAuthenticated(): boolean {
    return codeupIsAuthenticated();
  }

  /**
   * Ensure the user is authenticated and return the login name.
   *
   * - A configured token (env or ~/.netrc) is verified via `GET /user`.
   * - Otherwise, on a TTY, the user is prompted to paste a PAT once; a valid
   *   token is persisted to ~/.netrc so later commands reuse it.
   * - Non-interactive (CI) with no token → a clear error.
   */
  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const { username } = await codeupWhoami();

      if (username) return username;
      throw new Error(
        'Codeup token is set but was rejected by the API. Check CODEUP_TOKEN / YUNXIAO_TOKEN, '
          + 'or generate a new Personal Access Token at '
          + `https://${CODEUP_HOST} → 个人设置 / Personal Settings → 个人访问令牌 / Access Tokens.`,
      );
    }

    if (!isInteractive()) {
      throw new Error(
        'Codeup authentication unavailable. Set the CODEUP_TOKEN environment variable '
          + '(a Yunxiao/Codeup Personal Access Token). YUNXIAO_TOKEN is accepted as an alias.',
      );
    }

    log.info(
      `Not logged in to Codeup. Create a Personal Access Token at https://${CODEUP_HOST} → ` +
        '个人设置 / Personal Settings → 个人访问令牌 / Access Tokens, then paste it below.',
    );
    const token = (await askQuestion('Paste your Codeup Personal Access Token: ')).trim();

    if (!token) {
      throw new Error('No token provided. Codeup authentication cancelled.');
    }

    // Make the just-pasted token visible to the verification call (and to the
    // rest of this process, so subsequent OpenAPI calls in the same `init`
    // run use it) before persisting.
    process.env.CODEUP_TOKEN = token;
    const { username } = await codeupWhoami();

    if (!username) {
      delete process.env.CODEUP_TOKEN;
      throw new Error('Codeup authentication failed: the pasted token was rejected. Please try again.');
    }

    writeNetrcToken(token, username);
    log.success('Saved Codeup credentials to ~/.netrc');

    return username;
  }

  async ensureInstalled(): Promise<void> {
    // No external CLI — a token is all that's needed, checked in authenticate().
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      codeupRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof CodeupRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }

      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    throw new Error(
      'Automatic repository creation is not supported for Codeup. Create the repository '
        + `first at https://${CODEUP_HOST}.`,
    );
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return codeupMrCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      cwd: opts.cwd,
      spawnTimeoutMs: opts.spawnTimeoutMs,
    });
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { codeupIsAuthenticated, getCodeupToken } from './codeup-api.js';
