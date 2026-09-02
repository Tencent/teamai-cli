import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import { execFileSync } from 'node:child_process';
import {
  ensureGitLabAvailable,
  gitlabIsAuthenticated,
  gitlabWhoami,
  gitlabRepoClone,
  gitlabCreateRepo,
  gitlabMrCreate,
  gitlabBaseUrl,
  getGitLabToken,
  GitLabRepoNotFoundError,
} from './gitlab-api.js';
import { gitlabListOrgRepos } from './org.js';
import { fetchGitLabMR } from './mr-fetch.js';
import { parseGitLabRepoInput } from './repo-url.js';
import { sshProbeUsername, sshHostFromBaseUrl, mrPrefillUrl } from './ssh-fallback.js';
import { log } from '../../utils/logger.js';
import type { MRData } from '../../types.js';

/**
 * GitLab provider (supports self-hosted / enterprise GitLab instances).
 *
 * Token path: GitLab REST API v4 directly — no external CLI, only a Personal
 * Access Token (see gitlab-api.ts for env-var conventions).
 * SSH path (fallback when no token): `ssh -T git@<host>` banner provides the
 * username, clone/push go over plain git+ssh, and merge requests fall back
 * to a prefilled web form URL (the source branch is already pushed).
 */
export class GitLabProvider implements GitProvider {
  readonly name = 'gitlab';

  parseRepoInput(input: string): RepoInfo {
    return parseGitLabRepoInput(input);
  }

  isAuthenticated(): boolean {
    if (gitlabIsAuthenticated()) return true;
    return sshProbeUsername(sshHostFromBaseUrl(gitlabBaseUrl())) !== null;
  }

  async authenticate(): Promise<string> {
    // 1) Token path: authoritative username via GET /user.
    if (gitlabIsAuthenticated()) {
      const username = await gitlabWhoami();
      if (username) return username;
    }
    // 2) SSH path: banner username, then local git identity.
    const sshName = sshProbeUsername(sshHostFromBaseUrl(gitlabBaseUrl()));
    if (sshName) return sshName;
    try {
      const gitName = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
      if (gitName) return gitName;
    } catch {
      /* fall through to error */
    }
    throw new Error(
      'GitLab authentication failed. Either export GITLAB_TOKEN (a Personal Access ' +
        'Token with the api scope) or make sure `ssh -T git@' +
        sshHostFromBaseUrl(gitlabBaseUrl()) +
        "` succeeds with your ssh key.",
    );
  }

  async ensureInstalled(): Promise<void> {
    // Token path validates GITLAB_TOKEN; SSH path needs only git+ssh, which
    // authenticate() probes — nothing to install either way.
    if (getGitLabToken()) await ensureGitLabAvailable();
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
    if (!getGitLabToken()) {
      throw new Error(
        'GITLAB_TOKEN is required to create repos via the API. Alternatively, create ' +
          owner + '/' + repo +
          ' in the GitLab web UI (GitLab also auto-creates personal projects on first push).',
      );
    }
    await gitlabCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    if (getGitLabToken()) {
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
    // No token: the branch is already pushed over SSH; hand back a prefilled
    // merge-request form URL the user can open and submit.
    const url = mrPrefillUrl(
      gitlabBaseUrl(),
      opts.repo,
      opts.source,
      opts.target,
      opts.title,
    );
    log.info('GITLAB_TOKEN is not set — open this prefilled merge request form:');
    log.info(url);
    return url;
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
