import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listDirs, pathExists, copyDir, remove, dirContentEqual, getDirLatestMtime, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { BUILTIN_SKILL_NAMES } from '../builtin-skills.js';

/** File name used to track who has contributed (pushed) a skill. */
const CONTRIBUTORS_FILE = 'CONTRIBUTORS';

export class SkillsHandler extends ResourceHandler {
  readonly type = 'skills' as const;

  /**
   * Scan local AI tool skill directories for skills that are new or modified
   * compared to the team repo. Compares across ALL tool directories and picks
   * the one with the latest mtime when multiple dirs have modifications.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
    const teamSkills = new Set(await listDirs(teamSkillsDir));

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    // Collect the best candidate for each skill name across all tool directories
    const candidates = new Map<string, { sourcePath: string; mtime: number; status: ResourceItemStatus }>();

    // Scan each tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(process.env.HOME ?? '', toolPath.skills);
      if (!await pathExists(skillsDir)) continue;

      const dirs = await listDirs(skillsDir);
      for (const dir of dirs) {
        if (tombstones.has(dir)) continue;
        if (BUILTIN_SKILL_NAMES.has(dir)) continue; // Skip CLI built-in skills
        // Check for SKILL.md to confirm it's a valid skill
        const skillMd = path.join(skillsDir, dir, 'SKILL.md');
        if (!await pathExists(skillMd)) continue;

        const localDirPath = path.join(skillsDir, dir);

        if (teamSkills.has(dir)) {
          // Skill exists in team repo — check if content differs
          const teamDirPath = path.join(teamSkillsDir, dir);
          const equal = await dirContentEqual(localDirPath, teamDirPath, [CONTRIBUTORS_FILE]);
          if (equal) continue; // This tool dir's copy is identical, skip

          // Content differs — candidate for "modified"
          const mtime = await getDirLatestMtime(localDirPath);
          const existing = candidates.get(dir);
          if (!existing || mtime > existing.mtime) {
            candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'modified' });
          }
        } else {
          // Skill does not exist in team repo — candidate for "new"
          const existing = candidates.get(dir);
          if (!existing) {
            const mtime = await getDirLatestMtime(localDirPath);
            candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new skill — pick latest mtime
            const mtime = await getDirLatestMtime(localDirPath);
            if (mtime > existing.mtime) {
              candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'new' });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      items.push({
        name,
        type: 'skills',
        sourcePath: candidate.sourcePath,
        relativePath: `skills/${name}`,
        status: candidate.status,
      });
    }

    return items;
  }

  /**
   * Scan team repo for skills to pull.
   */
  async scanTeamForPull(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
    const dirs = await listDirs(teamSkillsDir);

    return dirs.map((dir) => ({
      name: dir,
      type: 'skills' as const,
      sourcePath: path.join(teamSkillsDir, dir),
      relativePath: `skills/${dir}`,
    }));
  }

  /**
   * Copy a local skill to the team repo.
   */
  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const dest = path.join(localConfig.repo.localPath, 'skills', item.name);
    await copyDir(item.sourcePath, dest);
    log.debug(`Copied skill ${item.name} → team repo`);

    // Append current user to CONTRIBUTORS (deduplicated)
    const contribPath = path.join(dest, CONTRIBUTORS_FILE);
    const existing = await readFileSafe(contribPath);
    const contributors = existing
      ? existing.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      : [];
    if (!contributors.includes(localConfig.username)) {
      contributors.push(localConfig.username);
      await writeFile(contribPath, contributors.join('\n') + '\n');
      log.debug(`Added contributor "${localConfig.username}" to ${item.name}`);
    }
  }

  /**
   * Pull a skill from team repo to all configured AI tool directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    const home = process.env.HOME ?? '';

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;

      // Skip tools that are not installed
      if (!await ResourceHandler.isToolInstalled(toolPath.skills)) {
        log.debug(`Skipping skill sync for ${tool}: tool not installed`);
        continue;
      }

      const dest = path.join(home, toolPath.skills, item.name);
      try {
        await copyDir(item.sourcePath, dest);
        log.debug(`Synced skill ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync skill ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove a skill from the team repo and all local AI tool directories.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const home = process.env.HOME ?? '';

    // Remove from team repo
    const teamDir = path.join(localConfig.repo.localPath, 'skills', name);
    if (await pathExists(teamDir)) {
      await remove(teamDir);
      removed.push(teamDir);
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    // Remove from each tool's skills directory
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillDir = path.join(home, toolPath.skills, name);
      if (await pathExists(skillDir)) {
        await remove(skillDir);
        removed.push(skillDir);
        log.debug(`Removed skill ${name} from ${tool}`);
      }
    }

    return removed;
  }

  /**
   * Read the CONTRIBUTORS list for a skill directory.
   */
  static async readContributors(skillDir: string): Promise<string[]> {
    const contribPath = path.join(skillDir, CONTRIBUTORS_FILE);
    const content = await readFileSafe(contribPath);
    if (!content) return [];
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  }
}
