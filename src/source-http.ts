/**
 * Git-free HTTP team repo client (issue #1, 方案一).
 *
 * `GET {baseUrl}/repo` returns a snapshot of the team repo:
 *   {
 *     version,                 // opaque cache key (commit hash / etag)
 *     files: [{ path, content }],   // non-skill resources (teamai.yaml, rules/**)
 *     commands: [{ type, skill_slug, skill_version, download_url }]  // skills
 *   }
 *
 * materializeHttpRepo() writes `files[]` into localPath (path-traversal guarded)
 * and runs `commands[]` through the SHARED executor (executeSkillCommand) so the
 * resulting `localPath/skills` tree is identical to a git clone. The rest of the
 * pull pipeline then deploys it to each agent unchanged.
 */

import path from 'node:path';
import { writeFile, remove, ensureDir } from './utils/fs.js';
import { executeSkillCommand, type SkillCommand } from './skill-command.js';
import { log } from './utils/logger.js';

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoSnapshot {
  version: string | null;
  files: RepoFile[];
  commands: SkillCommand[];
}

/**
 * Raised when the endpoint is reachable and authenticated, but does NOT serve a
 * usable `/repo` yet (HTTP 404, or 200 with a non-JSON body such as an SPA HTML
 * shell). This is an EXPECTED state for a reporter-only backend whose `/repo`
 * will come online later — callers can fall back to "reporting-only" setup
 * instead of hard-failing. Auth (401/403) and transport errors are NOT this.
 */
export class RepoNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoNotAvailableError';
  }
}

/**
 * Fetch the team repo snapshot.
 * - 401/403 → throws Error (bad API key).
 * - 404 or non-JSON 200 body → throws {@link RepoNotAvailableError} (/repo not live yet).
 * - other non-2xx / transport errors → throws Error.
 */
export async function fetchRepoSnapshot(baseUrl: string, apiKey: string): Promise<RepoSnapshot> {
  const url = `${baseUrl.replace(/\/$/, '')}/repo`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Authentication failed — check your API key (pass --token to `teamai init --http`, or set TEAMAI_API_TOKEN).');
  }
  if (res.status === 404) {
    throw new RepoNotAvailableError(`/repo not available yet (HTTP 404) at ${url}`);
  }
  if (!res.ok) {
    throw new Error(`GET /repo failed: HTTP ${res.status}`);
  }
  // A reporter-only backend may answer 200 with an SPA HTML shell. Treat any
  // non-JSON body as "/repo not live yet" rather than a hard parse failure.
  const text = await res.text();
  let raw: Partial<RepoSnapshot>;
  try {
    raw = JSON.parse(text) as Partial<RepoSnapshot>;
  } catch {
    throw new RepoNotAvailableError(`/repo returned a non-JSON body (likely not implemented yet) at ${url}`);
  }
  return {
    version: typeof raw.version === 'string' ? raw.version : null,
    files: Array.isArray(raw.files) ? raw.files : [],
    commands: Array.isArray(raw.commands) ? raw.commands : [],
  };
}

/**
 * Write a single inlined file under localPath, guarding against path traversal.
 * Throws if the resolved destination escapes localPath.
 */
async function writeRepoFile(localPath: string, file: RepoFile): Promise<void> {
  const resolvedRoot = path.resolve(localPath);
  const outPath = path.resolve(localPath, file.path);
  if (outPath !== resolvedRoot && !outPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path traversal detected in /repo file: ${file.path}`);
  }
  await ensureDir(path.dirname(outPath));
  await writeFile(outPath, file.content);
}

/**
 * Materialize an HTTP team repo into `localPath` (git-clone-equivalent on disk).
 *
 * - files[]    → written verbatim (teamai.yaml, rules/**, roles.yaml, ...)
 * - commands[] → executed against `localPath/skills` via the shared executor.
 *
 * Returns the server `version` (used as the incremental pull cache key).
 */
export async function materializeHttpRepo(
  baseUrl: string,
  localPath: string,
  apiKey: string,
): Promise<string | null> {
  const snapshot = await fetchRepoSnapshot(baseUrl, apiKey);

  await ensureDir(localPath);
  for (const file of snapshot.files) {
    await writeRepoFile(localPath, file);
  }

  const skillsDir = path.join(localPath, 'skills');
  await ensureDir(skillsDir);
  for (const cmd of snapshot.commands) {
    try {
      await executeSkillCommand(cmd, skillsDir);
    } catch (e) {
      log.warn(`[http-repo] skill command ${cmd.type} ${cmd.skill_slug} failed: ${(e as Error).message}`);
    }
  }

  return snapshot.version;
}

/** Remove a materialized skill from the local repo tree (uninstall command). */
export async function removeMaterializedSkill(localPath: string, slug: string): Promise<void> {
  await remove(path.join(localPath, 'skills', slug));
}
