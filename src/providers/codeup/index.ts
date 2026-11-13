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
  probeCodeupToken,
  configuredOrganizationId,
  configuredUsername,
  saveCodeupSettings,
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
 * merge request creation. Set CODEUP_TRANSPORT=https to clone over HTTPS
 * with the PAT instead (see codeup-api.ts cloneUrl).
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
   * A PAT with platform scope answers `GET /oapi/v1/platform/user` with the
   * username directly. A PAT with only codeup scope (the common case — the
   * platform endpoint answers 403 for it) cannot: the token is then validated
   * with a codeup-scoped probe (the org repository list), and the username
   * comes from CODEUP_USERNAME or ~/.teamai/codeup.json. Interactive init
   * asks for the missing pieces and persists them.
   */
  async authenticate(): Promise<string> {
    // 1. A PAT with platform scope answers whoami directly.
    const { username: whoamiName } = await codeupWhoami();

    if (whoamiName) return whoamiName;

    // 2. A configured token without platform scope: validate it with a
    //    codeup-scoped probe and take the username from the configuration.
    const orgId = configuredOrganizationId();
    const configuredName = configuredUsername();

    if (this.isAuthenticated()) {
      if (!orgId) {
        throw new Error(
          'Codeup token is set, but the organizationId is not. A PAT with only codeup '
            + 'scope cannot discover it. Set CODEUP_ORG_ID (the numeric 企业标识 from '
            + '云效 组织管理 → 基本信息), or run `teamai init` interactively to save it.',
        );
      }

      const probe = await probeCodeupToken(orgId);

      if (!probe.ok) {
        throw new Error(
          `Codeup token is set but was rejected by the API (HTTP ${probe.status ?? 'error'}). Check `
            + 'CODEUP_TOKEN / YUNXIAO_TOKEN, or generate a new Personal Access Token at '
            + `https://${CODEUP_HOST} → 个人设置 / Personal Settings → 个人访问令牌 / Access Tokens.`,
        );
      }

      if (configuredName) return configuredName;

      if (!isInteractive()) {
        throw new Error(
          'Codeup token is valid but the username is unknown: the PAT has no platform scope, '
            + 'so no user endpoint answers. Set CODEUP_USERNAME (your Codeup login name), or run '
            + '`teamai init` interactively to save it.',
        );
      }

      const username = (await askQuestion('Your Codeup username (登录名): ')).trim();

      if (!username) {
        throw new Error('No username provided. Codeup authentication cancelled.');
      }

      saveCodeupSettings({ username });

      return username;
    }

    // 3. No token configured: interactive paste, or a clear headless error.
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

    // Make the just-pasted token visible to the verification calls (and to the
    // rest of this process, so subsequent OpenAPI calls in the same `init`
    // run use it) before persisting.
    process.env.CODEUP_TOKEN = token;
    const { username: pastedName } = await codeupWhoami();

    if (pastedName) {
      writeNetrcToken(token, pastedName);
      log.success('Saved Codeup credentials to ~/.netrc');

      return pastedName;
    }

    // The token has no platform scope: ask for the org id and username, then
    // validate both with the codeup-scoped probe before persisting.
    const pastedOrgId = orgId ?? (await askQuestion('Your Codeup organizationId (企业标识, from 云效 组织管理 → 基本信息): ')).trim();

    if (!pastedOrgId) {
      delete process.env.CODEUP_TOKEN;
      throw new Error('No organizationId provided. Codeup authentication cancelled.');
    }

    const probe = await probeCodeupToken(pastedOrgId);

    if (!probe.ok) {
      delete process.env.CODEUP_TOKEN;
      throw new Error('Codeup authentication failed: the pasted token was rejected. Please try again.');
    }

    const username = configuredName ?? (await askQuestion('Your Codeup username (登录名): ')).trim();

    if (!username) {
      delete process.env.CODEUP_TOKEN;
      throw new Error('No username provided. Codeup authentication cancelled.');
    }

    writeNetrcToken(token, username);
    saveCodeupSettings({ organizationId: pastedOrgId, username });
    log.success('Saved Codeup credentials to ~/.netrc and ~/.teamai/codeup.json');

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
