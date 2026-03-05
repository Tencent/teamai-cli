import YAML from 'yaml';
import path from 'node:path';
import { requireInit } from './config.js';
import { readFileSafe, listFiles } from './utils/fs.js';
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

export async function listMembers(options: GlobalOptions): Promise<void> {
  const { localConfig } = await requireInit();
  const membersDir = path.join(localConfig.repo.localPath, 'members');
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
