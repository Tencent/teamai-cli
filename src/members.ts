import YAML from 'yaml';
import path from 'node:path';
import { requireInit, detectProjectConfig } from './config.js';
import { readFileSafe, listFiles } from './utils/fs.js';
import { pullRepo, redactGitCredentials } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import type { GlobalOptions, LocalConfig, MemberConfig } from './types.js';

export function buildMemberInvite(repoUrl: string): string {
  const safeRepoUrl = redactGitCredentials(repoUrl.trim());
  if (!safeRepoUrl) throw new Error('Team repo URL is missing from local config.');

  return [
    'TeamAI member invitation',
    '',
    'Paste everything between BEGIN and END into the AI tool you want to use:',
    '',
    '----- BEGIN TEAMAI INVITE -----',
    'Help me join my team\'s TeamAI setup.',
    `Team repo: ${safeRepoUrl}`,
    '',
    'Goal: within 8 minutes, make at least one team skill available in this AI tool.',
    '',
    'Rules:',
    '- Run the setup for me. Do not ask me to type or understand Git commands, and do not run raw `git` commands; use `teamai`.',
    '- Never ask me to paste a password, token, or key into chat. Use the provider\'s official browser/device login. If that is unavailable, pause and tell me how to enter the credential outside chat.',
    '- Do not create another team repo.',
    '- Detect my OS, Node.js version, current folder, current AI tool, and existing login before asking questions. Ask only for decisions you cannot infer, and recommend a default.',
    '- Use project scope only after confirming the current folder is the project I want to equip. Otherwise ask me to open that project first.',
    '',
    'Steps:',
    '1. Ensure Node.js 20 or newer is available, then install `teamai-cli` globally if needed.',
    '2. Infer the provider from the repo URL and complete its official sign-in flow if needed.',
    '3. Identify the TeamAI agent id for this AI tool, then run `teamai init "' + safeRepoUrl + '" --agent <agent-id>` from the target project.',
    '4. Run `teamai doctor` and resolve actionable failures until it exits with code 0.',
    '5. Run `teamai list skills --source local --agent <agent-id>` and verify that at least one skill is listed.',
    '6. Tell me the exact skill name and one natural-language sentence to invoke it. Ask me to open a fresh session of this AI tool, use that sentence, and confirm the skill responded.',
    '',
    'Do not declare onboarding complete until steps 4 and 5 pass and I confirm the skill responded in the fresh session.',
    '----- END TEAMAI INVITE -----',
  ].join('\n');
}

export async function printMemberInvite(): Promise<boolean> {
  let localConfig: LocalConfig;
  try {
    const projectConfig = await detectProjectConfig();
    localConfig = projectConfig ?? (await requireInit()).localConfig;
  } catch {
    log.error('TeamAI is not initialized. Run `teamai init <repo-url>` first, then rerun `teamai members --invite`.');
    return false;
  }

  if (localConfig.repo.kind === 'self') {
    log.error('AI-ready member invites are not available in single-repo mode; teammates receive TeamAI when they clone the business repo.');
    return false;
  }
  if (localConfig.repo.kind === 'http') {
    log.error('AI-ready member invites are not available in HTTP mode because the API key must be shared out of band.');
    return false;
  }

  console.log(buildMemberInvite(localConfig.repo.remote));
  return true;
}

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

  // Members live on the teamai-reports orphan branch in self mode; read them from
  // the reports worktree (refreshed from origin) instead of the team repo clone.
  let repoPath: string;
  if (localConfig.repo.kind === 'self') {
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
