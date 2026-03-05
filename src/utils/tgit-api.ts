import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const TGIT_API_BASE = 'https://git.woa.com/api/v3';

export interface TGitUser {
  username: string;
  name: string;
  email: string;
}

/**
 * Load environment variables from ~/.teamai/env file (KEY=VALUE format).
 * This provides a shell-independent way to configure tokens,
 * solving issues where ~/.zshrc or ~/.bashrc aren't sourced in subprocesses.
 */
function loadEnvFile(): void {
  const envPath = path.join(process.env.HOME ?? '', '.teamai', 'env');
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // File doesn't exist or not readable, that's fine
  }
}

// Load env file on module init
loadEnvFile();

function getToken(): string {
  const token = process.env.TGIT_TOKEN;
  if (!token) {
    throw new Error(
      'TGIT_TOKEN environment variable is not set.\n' +
      '  Get a token from https://git.woa.com/profile/account\n' +
      '  Then add it to your shell profile:\n' +
      '    bash: echo \'export TGIT_TOKEN=your_token\' >> ~/.bashrc && source ~/.bashrc\n' +
      '    zsh:  echo \'export TGIT_TOKEN=your_token\' >> ~/.zshrc && source ~/.zshrc\n' +
      '  Or set it in ~/.teamai/env:\n' +
      '    echo \'TGIT_TOKEN=your_token\' > ~/.teamai/env'
    );
  }
  return token;
}

async function tgitFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = getToken();
  // Use query parameter auth for compatibility with all TGit v3 endpoints
  const separator = path.includes('?') ? '&' : '?';
  const url = `${TGIT_API_BASE}${path}${separator}private_token=${token}`;
  log.debug(`TGit API: ${options?.method ?? 'GET'} ${TGIT_API_BASE}${path}`);
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`TGit API error ${resp.status}: ${body}`);
  }
  return resp;
}

export async function getCurrentUser(): Promise<TGitUser> {
  const resp = await tgitFetch('/user');
  return resp.json() as Promise<TGitUser>;
}

export async function verifyToken(): Promise<TGitUser> {
  try {
    return await getCurrentUser();
  } catch (e) {
    throw new Error(`TGit token verification failed: ${(e as Error).message}`);
  }
}

// ─── Repo / Project APIs ─────────────────────────────────

export interface TGitProject {
  id: number;
  name: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch: string;
}

/**
 * Get project info by URL-encoded projectId (e.g. "owner%2Frepo").
 * Returns null if the project does not exist (404).
 */
export async function getProject(projectId: string): Promise<TGitProject | null> {
  const token = getToken();
  const url = `${TGIT_API_BASE}/projects/${projectId}?private_token=${token}`;
  log.debug(`TGit API: GET /projects/${projectId}`);
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`TGit API error ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<TGitProject>;
}

/**
 * Check whether a repo has any files (i.e. is non-empty).
 * Returns true if the repo is empty (no tree entries or 404 on tree).
 */
export async function isRepoEmpty(projectId: string): Promise<boolean> {
  const token = getToken();
  const url = `${TGIT_API_BASE}/projects/${projectId}/repository/tree?private_token=${token}`;
  log.debug(`TGit API: GET /projects/${projectId}/repository/tree`);
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  // 404 means no default branch / empty repo
  if (resp.status === 404) return true;
  if (!resp.ok) return true;
  const tree = (await resp.json()) as unknown[];
  return tree.length === 0;
}

export interface TGitNamespace {
  id: number;
  name: string;
  path: string;
  kind: string;
}

/**
 * Look up a namespace (user or group) by name.
 * Returns the namespace ID or null if not found.
 */
export async function getNamespaceId(name: string): Promise<number | null> {
  const resp = await tgitFetch(`/namespaces?search=${encodeURIComponent(name)}`);
  const namespaces = (await resp.json()) as TGitNamespace[];
  const match = namespaces.find(
    (ns) => ns.path.toLowerCase() === name.toLowerCase(),
  );
  return match?.id ?? null;
}

/**
 * Create a new project under the given namespace.
 * If namespaceId is omitted, the project is created under the current user.
 */
export async function createProject(
  name: string,
  namespaceId?: number,
): Promise<TGitProject> {
  const body: Record<string, unknown> = { name };
  if (namespaceId != null) {
    body.namespace_id = namespaceId;
  }
  const resp = await tgitFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return resp.json() as Promise<TGitProject>;
}

