/**
 * Shared Bearer credential resolution for the HTTP team repo (方案一) and the
 * agent status reporter (方案二). One key both pulls skills and reports status.
 *
 * Resolution order (first non-empty wins):
 *   1. env TEAMAI_API_TOKEN
 *   2. env TEAMAI_API_KEY            (legacy alias accepted for convenience)
 *   3. ~/.teamai/apikey              (written by `teamai init --http --token`)
 *
 * The key is NEVER stored in teamai.yaml / local config and NEVER reported in
 * any payload. The on-disk file is created with 0600 permissions and is covered
 * by the project-scope .gitignore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './utils/fs.js';

/** Absolute path to the local API key file. */
export function getApiKeyPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'apikey');
}

/**
 * Resolve the API key from env or the local file. Returns null when no key is
 * configured (callers surface a friendly "pass --token to init" hint).
 */
export function resolveApiKey(): string | null {
  const fromEnv = process.env.TEAMAI_API_TOKEN || process.env.TEAMAI_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    const content = fs.readFileSync(getApiKeyPath(), 'utf-8').trim();
    if (content) return content;
  } catch {
    // no file — fall through to null
  }
  return null;
}

/**
 * Persist an API key to ~/.teamai/apikey with 0600 permissions.
 */
export async function saveApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key must not be empty');
  const keyPath = getApiKeyPath();
  await ensureDir(path.dirname(keyPath));
  fs.writeFileSync(keyPath, trimmed + '\n', { mode: 0o600 });
  // Re-assert mode in case the file already existed with looser perms.
  fs.chmodSync(keyPath, 0o600);
}
