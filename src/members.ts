import YAML from 'yaml';
import path from 'node:path';
import { requireInit, detectProjectConfig } from './config.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { pullRepo } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import type { GlobalOptions, MemberConfig } from './types.js';

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
  // them from the reports worktree (refreshed from origin). Leftover members/
  // on the default-branch clone is ignored. HTTP keeps the clone/API path.
  let repoPath: string;
  const { usesReportsBranch } = await import('./types.js');
  if (usesReportsBranch(localConfig)) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig);
    repoPath = await ensureReportsWorktree(localConfig);
  } else {
    repoPath = localConfig.repo.localPath;
    await pullRepo(repoPath);
  }

  const membersDir = path.join(repoPath, 'members');
  const files = await listFiles(membersDir);
  const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (yamlFiles.length === 0) {
    log.info('No team members registered');
    return;
  }

  console.log('');
  console.log(`Team members (${yamlFiles.length}):`);
  console.log('');

  for (const file of yamlFiles) {
    const content = await readFileSafe(path.join(membersDir, file));
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
