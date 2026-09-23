import YAML from 'yaml';
import path from 'node:path';
import { requireInit, detectProjectConfig } from './config.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { pullRepo } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import type { GlobalOptions, LocalConfig, MemberConfig } from './types.js';

/**
 * Read a specific member's config from the repo.
 */
export async function getMemberConfig(repoPath: string, username: string): Promise<MemberConfig | null> {
  const memberPath = path.join(repoPath, 'members', `${username}.yaml`);
  const content = await readFileSafe(memberPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    return MemberConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read roots for member files, highest precedence first. The primary root is
 * the teamai-reports worktree (the clone itself for HTTP repos); the
 * default-branch clone is an inherited root for members registered before
 * reports moved to their own branch (#489) — read the way learnings' inherited
 * root is (#485): forever, with nothing copied out of it or deleted from it.
 */
export function memberReadRoots(primary: string, localConfig: LocalConfig): string[] {
  if (primary === localConfig.repo.localPath) return [primary];
  return [primary, localConfig.repo.localPath];
}

/**
 * Read a member's config across read roots. The first root that yields one
 * wins, so a copy that moved to the reports branch supersedes its inherited
 * original.
 */
export async function readMemberConfig(roots: string[], username: string): Promise<MemberConfig | null> {
  for (const root of roots) {
    const config = await getMemberConfig(root, username);
    if (config) return config;
  }
  return null;
}

/**
 * Merge a member's roster entry with newly-active role/projects, returning the
 * updated config and whether anything changed. Projects use **append + dedupe**
 * (the roster is "every project I've participated in" across directories);
 * `role` is overwritten when a non-empty one is supplied. `registeredAt` is
 * preserved for an existing member. Pure — callers persist + push the result.
 */
export function mergeMemberConfig(
  existing: MemberConfig | null,
  input: { username: string; role?: string; projects?: string[] },
): { config: MemberConfig; changed: boolean } {
  const prevProjects = existing?.projects ?? [];
  const mergedProjects: string[] = [...prevProjects];
  const seen = new Set(prevProjects);
  for (const p of input.projects ?? []) {
    if (!seen.has(p)) {
      seen.add(p);
      mergedProjects.push(p);
    }
  }

  const role = input.role ?? existing?.role;

  const config: MemberConfig = {
    username: input.username,
    displayName: existing?.displayName || input.username,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    ...(role ? { role } : {}),
    ...(mergedProjects.length > 0 ? { projects: mergedProjects } : {}),
  };

  const changed =
    !existing ||
    mergedProjects.length !== prevProjects.length ||
    (role ?? '') !== (existing.role ?? '');

  return { config, changed };
}

export async function listMembers(options: GlobalOptions): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  // Members live on the teamai-reports orphan branch for non-HTTP repos; read
  // them from the reports worktree (refreshed from origin). Members registered
  // before the switch still live on the default-branch clone, so it stays a
  // read-only inherited root. HTTP keeps the clone/API path.
  // Listing is read-only: never publish a missing reports branch.
  let repoPath: string;
  const { usesBranchWorktree } = await import('./types.js');
  if (usesBranchWorktree(localConfig)) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig, { pushIfCreated: false });
    repoPath = await ensureReportsWorktree(localConfig, { pushIfCreated: false });
  } else {
    repoPath = localConfig.repo.localPath;
    await pullRepo(repoPath);
  }

  // Union across read roots; the first root that has a file supplies its
  // bytes, so a copy on the reports branch supersedes the inherited one.
  const memberFiles: Array<{ file: string; root: string }> = [];
  const listed = new Set<string>();
  for (const root of memberReadRoots(repoPath, localConfig)) {
    for (const file of await listFiles(path.join(root, 'members'))) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      if (listed.has(file)) continue;
      listed.add(file);
      memberFiles.push({ file, root });
    }
  }

  if (memberFiles.length === 0) {
    log.info('No team members registered');
    return;
  }

  console.log('');
  console.log(`Team members (${memberFiles.length}):`);
  console.log('');

  for (const { file, root } of memberFiles) {
    const content = await readFileSafe(path.join(root, 'members', file));
    if (!content) continue;
    try {
      const raw = YAML.parse(content);
      const member = MemberConfigSchema.parse(raw);
      const isSelf = member.username === localConfig.username;
      const marker = isSelf ? ' (you)' : '';
      const display = member.displayName ? ` — ${member.displayName}` : '';
      console.log(`  ${member.username}${display}${marker}`);
      if (options.verbose) {
        console.log(`    registered: ${member.registeredAt}`);
      }
    } catch {
      log.warn(`Invalid member file: ${file}`);
    }
  }
  console.log('');
}
