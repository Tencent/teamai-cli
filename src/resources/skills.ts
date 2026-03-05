import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, TeamaiConfig, LocalConfig } from '../types.js';
import { listDirs, pathExists, copyDir, remove } from '../utils/fs.js';
import { log } from '../utils/logger.js';

export class SkillsHandler extends ResourceHandler {
  readonly type = 'skills' as const;

  /**
   * Scan local AI tool skill directories for skills not in the team repo.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
    const teamSkills = new Set(await listDirs(teamSkillsDir));

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    const localSkills: ResourceItem[] = [];
    const seen = new Set<string>();

    // Scan each tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      const skillsDir = path.join(process.env.HOME ?? '', toolPath.skills);
      if (!await pathExists(skillsDir)) continue;

      const dirs = await listDirs(skillsDir);
      for (const dir of dirs) {
        if (seen.has(dir) || teamSkills.has(dir)) continue;
        if (tombstones.has(dir)) continue;
        // Check for SKILL.md to confirm it's a valid skill
        const skillMd = path.join(skillsDir, dir, 'SKILL.md');
        if (!await pathExists(skillMd)) continue;

        seen.add(dir);
        localSkills.push({
          name: dir,
          type: 'skills',
          sourcePath: path.join(skillsDir, dir),
          relativePath: `skills/${dir}`,
        });
      }
    }

    return localSkills;
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
  }

  /**
   * Pull a skill from team repo to all configured AI tool directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    const syncTargets = teamConfig.sharing.skills.syncTargets;

    for (const tool of syncTargets) {
      const toolPath = teamConfig.toolPaths[tool];
      if (!toolPath) continue;

      const dest = path.join(process.env.HOME ?? '', toolPath.skills, item.name);
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
    const syncTargets = teamConfig.sharing.skills.syncTargets;
    for (const tool of syncTargets) {
      const toolPath = teamConfig.toolPaths[tool];
      if (!toolPath) continue;
      const skillDir = path.join(home, toolPath.skills, name);
      if (await pathExists(skillDir)) {
        await remove(skillDir);
        removed.push(skillDir);
        log.debug(`Removed skill ${name} from ${tool}`);
      }
    }

    return removed;
  }
}
