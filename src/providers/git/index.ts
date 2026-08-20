import os from 'node:os';
import { spawnSync } from 'node:child_process';

import type { GitProvider, PrCreateOptions, RepoInfo } from '../types.js';
import { parseGenericGitRepoInput } from './repo-url.js';

function redactCredentials(message: string): string {
  return message.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

function gitIdentity(): string {
  const result = spawnSync('git', ['config', '--get', 'user.name'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const configured = result.status === 0 ? (result.stdout ?? '').trim() : '';
  return configured || process.env.GIT_AUTHOR_NAME?.trim() || os.userInfo().username;
}

/**
 * Transport-only provider for arbitrary Git hosts.
 *
 * Authentication is intentionally delegated to Git itself, so existing SSH
 * agents and credential helpers work without TeamAI reading or storing tokens.
 */
export class GenericGitProvider implements GitProvider {
  readonly name = 'git';
  private remoteUrl: string | null = null;

  parseRepoInput(input: string): RepoInfo {
    const repoInfo = parseGenericGitRepoInput(input);
    this.remoteUrl = repoInfo.httpsUrl;
    return repoInfo;
  }

  isAuthenticated(): boolean {
    // Generic hosts have no portable platform-level auth check. The clone,
    // pull, or push operation is the authoritative credential validation.
    return true;
  }

  async authenticate(): Promise<string> {
    return gitIdentity();
  }

  async ensureInstalled(): Promise<void> {
    const result = spawnSync('git', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error('git is required for generic Git repositories but was not found on PATH.');
    }
  }

  cloneRepo(_repo: string, localPath: string): void {
    if (!this.remoteUrl) {
      throw new Error('Generic Git clone requires parseRepoInput() before cloneRepo().');
    }

    const result = spawnSync('git', ['clone', this.remoteUrl, localPath], {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (result.error || result.status !== 0) {
      const output = `${result.stderr ?? ''} ${result.stdout ?? ''}`.trim();
      const detail = output || result.error?.message || `exit ${result.status ?? 1}`;
      throw new Error(`git clone failed: ${redactCredentials(detail)}`);
    }
  }

  async createRepo(): Promise<void> {
    throw new Error(
      'Automatic repository creation is not supported for generic Git hosts. Create the repository first.',
    );
  }

  async createPullRequest(_opts: PrCreateOptions): Promise<string> {
    throw new Error(
      'Automatic pull/merge request creation is not supported for generic Git hosts.',
    );
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { parseGenericGitRepoInput } from './repo-url.js';
