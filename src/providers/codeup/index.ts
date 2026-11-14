import type { GitProvider, PrCreateOptions, PullRequestLookup, RepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  codeupApiBase,
  codeupIsAuthenticated,
  codeupWhoami,
  codeupRepoClone,
  codeupMrCreate,
  codeupFindOpenMr,
  codeupMrHistory,
  writeNetrcToken,
  readNetrcUsername,
  probeCodeupToken,
  isRegionEdition,
  configuredOrganizationId,
  configuredUsername,
  saveCodeupSettings,
  CodeupRepoNotFoundError,
} from './codeup-api.js';
import { parseCodeupRepoInput, codeupInputTransport, type CodeupTransport, CODEUP_HOST } from './repo-url.js';
import { log } from '../../utils/logger.js';
import { askQuestion, isInteractive } from '../../utils/prompt.js';

const ORG_ID_QUESTION = 'Your Codeup organizationId (企业标识, from 云效 组织管理 → 基本信息): ';
const USERNAME_QUESTION = 'Your Codeup username (登录名): ';

/** The error an unreachable OpenAPI answers with — a network failure is not a rejected token. */
function apiUnreachableError(retryHint: string): Error {
  return new Error(
    `Could not reach the Codeup API at ${codeupApiBase()}. Check the network connection${retryHint}, `
      + 'or CODEUP_API_BASE_URL / YUNXIAO_EDITION if this deployment is a Region 版 Yunxiao.',
  );
}

/**
 * Codeup (阿里云云效代码管理, codeup.aliyun.com) provider.
 *
 * Uses the Yunxiao OpenAPI directly — no external CLI is required, only a
 * Personal Access Token. See codeup-api.ts for the token resolution order
 * (CODEUP_TOKEN / YUNXIAO_TOKEN / ~/.netrc) and the dialect notes that
 * distinguish it from the GitLab provider it is structurally modelled on.
 *
 * Git transport follows the URL the member typed: an https:// URL clones over
 * HTTPS (the member's git credentials, or the PAT as the Basic password when
 * its username is known too), an SSH URL or the bare `org/group/repo` form
 * clones over SSH — the SSH key on the machine authenticates, exactly as the
 * generic `git` provider does. The PAT is otherwise only needed for OpenAPI
 * calls such as merge request creation. CODEUP_TRANSPORT=https|ssh overrides
 * (see codeup-api.ts codeupCloneTransport).
 */
export class CodeupProvider implements GitProvider {
  readonly name = 'codeup';
  readonly pullRequests: PullRequestLookup = { findOpen: codeupFindOpenMr, history: codeupMrHistory };

  /**
   * Transport of the URL parseRepoInput last saw. cloneRepo is handed only
   * `org/group/repo` — the scheme is lost — and init/source always parse
   * before cloning, on the same instance.
   */
  private inputTransport: CodeupTransport | null = null;

  parseRepoInput(input: string): RepoInfo {
    const info = parseCodeupRepoInput(input);
    this.inputTransport = codeupInputTransport(input);

    return info;
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
   * asks for the missing pieces and persists them; a Region 版 deployment
   * needs no organizationId at all.
   */
  async authenticate(): Promise<string> {
    // 1. A PAT with platform scope answers whoami directly.
    const { username: whoamiName } = await codeupWhoami();

    if (whoamiName) return whoamiName;

    // 2. No token configured: interactive paste, or a clear headless error.
    if (!this.isAuthenticated()) return this.authenticateByPaste();

    // 3. A configured token without platform scope: validate it with a
    //    codeup-scoped probe and take the username from the configuration.
    let orgId = configuredOrganizationId();

    if (!orgId && !isRegionEdition()) {
      orgId = await this.askOrganizationId();
    }

    const probe = await probeCodeupToken(orgId ?? '');

    if (!probe.ok) {
      if (probe.status === undefined) throw apiUnreachableError('');

      throw new Error(
        `Codeup token is set but was rejected by the API (HTTP ${probe.status}). Check `
          + 'CODEUP_TOKEN / YUNXIAO_TOKEN, or generate a new Personal Access Token at '
          + `https://${CODEUP_HOST} → 个人设置 / Personal Settings → 个人访问令牌 / Access Tokens.`,
      );
    }

    // The netrc login doubles as the git-over-HTTPS username, so it names the
    // member here too — the same fallback codeupCloneUrl uses.
    const configuredName = configuredUsername() ?? readNetrcUsername();

    if (configuredName) return configuredName;

    if (!isInteractive()) {
      throw new Error(
        'Codeup token is valid but the username is unknown: the PAT has no platform scope, '
          + 'so no user endpoint answers. Set CODEUP_USERNAME (your Codeup login name), or run '
          + '`teamai init` interactively to save it.',
      );
    }

    const username = (await askQuestion(USERNAME_QUESTION)).trim();

    if (!username) {
      throw new Error('No username provided. Codeup authentication cancelled.');
    }

    saveCodeupSettings({ username });

    return username;
  }

  /** The organizationId a codeup-scope-only PAT cannot discover: asked and persisted interactively, an error headless. */
  private async askOrganizationId(): Promise<string> {
    if (!isInteractive()) {
      throw new Error(
        'Codeup token is set, but the organizationId is not. A PAT with only codeup '
          + 'scope cannot discover it. Set CODEUP_ORG_ID (the numeric 企业标识 from '
          + '云效 组织管理 → 基本信息), or run `teamai init` interactively to save it.',
      );
    }

    const orgId = (await askQuestion(ORG_ID_QUESTION)).trim();

    if (!orgId) {
      throw new Error('No organizationId provided. Codeup authentication cancelled.');
    }

    saveCodeupSettings({ organizationId: orgId });

    return orgId;
  }

  /** Interactive token paste: validate before persisting to ~/.netrc and ~/.teamai/codeup.json. */
  private async authenticateByPaste(): Promise<string> {
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

    // The token has no platform scope: ask for the org id (a Region 版 needs
    // none) and the username, then validate with the codeup-scoped probe
    // before persisting.
    let orgId = configuredOrganizationId();

    if (!orgId && !isRegionEdition()) {
      orgId = (await askQuestion(ORG_ID_QUESTION)).trim();

      if (!orgId) {
        delete process.env.CODEUP_TOKEN;
        throw new Error('No organizationId provided. Codeup authentication cancelled.');
      }
    }

    const probe = await probeCodeupToken(orgId ?? '');

    if (!probe.ok) {
      delete process.env.CODEUP_TOKEN;

      if (probe.status === undefined) throw apiUnreachableError(' and try again');

      throw new Error('Codeup authentication failed: the pasted token was rejected. Please try again.');
    }

    let username = configuredUsername();

    if (!username) {
      username = (await askQuestion(USERNAME_QUESTION)).trim();
    }

    if (!username) {
      delete process.env.CODEUP_TOKEN;
      throw new Error('No username provided. Codeup authentication cancelled.');
    }

    writeNetrcToken(token, username);

    if (orgId) saveCodeupSettings({ organizationId: orgId });

    saveCodeupSettings({ username });
    log.success('Saved Codeup credentials to ~/.netrc and ~/.teamai/codeup.json');

    return username;
  }

  async ensureInstalled(): Promise<void> {
    // No external CLI — a token is all that's needed, checked in authenticate().
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      codeupRepoClone(repo, localPath, this.inputTransport);
    } catch (e) {
      if (e instanceof CodeupRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }

      throw e;
    }
  }

  async createRepo(_owner: string, _repo: string): Promise<void> {
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
