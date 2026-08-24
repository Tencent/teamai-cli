import os from 'node:os';
import { spawnSync } from 'node:child_process';

import type { GitProvider, PrCreateOptions, RepoInfo } from '../types.js';
import { sanitizeGitUrl } from '../../utils/redact.js';
import { parseGenericGitRepoInput } from './repo-url.js';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Convert a display-oriented Git/OS name into a safe member and branch identifier. */
export function normalizeGitIdentity(value: string): string | null {
  let normalized = value
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/[._-]+$/g, '');

  if (!normalized) return null;
  if (WINDOWS_RESERVED_NAME.test(normalized)) normalized = `user-${normalized}`;
  return normalized.slice(0, 64);
}

function gitIdentity(): string {
  const result = spawnSync('git', ['config', '--get', 'user.name'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const configured = result.status === 0 ? (result.stdout ?? '').trim() : '';
  let osUsername = '';
  try {
    osUsername = os.userInfo().username;
  } catch {
    // Extremely restricted runtimes may not expose OS account information.
  }

  for (const candidate of [configured, process.env.GIT_AUTHOR_NAME ?? '', osUsername]) {
    const safe = normalizeGitIdentity(candidate);
    if (safe) return safe;
  }
  return 'git-user';
}

/**
 * Transport-only provider for arbitrary Git hosts.
 *
 * Authentication is intentionally delegated to Git itself, so existing SSH
 * agents and credential helpers work without TeamAI reading or storing tokens.
 */
export class GenericGitProvider implements GitProvider {
  readonly name = 'git';

  parseRepoInput(input: string): RepoInfo {
    return parseGenericGitRepoInput(input);
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

  cloneRepo(repo: string, localPath: string): void {
    const remoteUrl = parseGenericGitRepoInput(repo).httpsUrl;

    const result = spawnSync('git', ['clone', '--', remoteUrl, localPath], {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const output = `${result.stderr ?? ''} ${result.stdout ?? ''}`.trim();
      const detail = output || result.error?.message || `exit ${result.status ?? 1}`;
      throw new Error(`git clone failed: ${sanitizeGitUrl(detail)}`);
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
