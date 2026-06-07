import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listFiles, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { resolveBaseDir } from '../types.js';
import { BUILTIN_AGENT_NAMES } from '../builtin-agents.js';

/**
 * AgentsHandler — manage AI subagent definitions distributed via the team repo.
 *
 * Layout (flat, single-file per agent):
 *   team-repo/agents/<name>.md
 *   ~/.claude/agents/<name>.md
 *   ~/.codebuddy/agents/<name>.md
 *
 * Tools without an `agents` path in toolPaths (e.g. cursor / codex / openclaw)
 * are silently skipped — agents are a Tier-1 capability that requires a
 * subagent-aware host.
 */
export class AgentsHandler extends ResourceHandler {
  readonly type = 'agents' as const;

  /**
   * Scan local AI tool agents/ directories for *.md files that are new or
   * modified compared to the team repo. Only considers tools whose
   * toolPaths.<tool>.agents is configured.
   *
   * CLI built-in agents (e.g. teamai-recall) are excluded from push so the
   * built-in version remains the single source of truth.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');
    const teamAgents = new Set(
      (await pathExists(teamAgentsDir))
        ? (await listFiles(teamAgentsDir)).filter((f) => f.endsWith('.md'))
        : [],
    );

    const tombstones = await this.readTombstones(localConfig);
    const candidates = new Map<string, { sourcePath: string; mtime: number; status: ResourceItemStatus }>();

    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.agents) continue;
      const agentsDir = path.join(resolveBaseDir(localConfig), toolPath.agents);
      if (!await pathExists(agentsDir)) continue;

      const files = await listFiles(agentsDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        if (tombstones.has(name)) continue;
        if (BUILTIN_AGENT_NAMES.has(name)) continue; // CLI-managed; never push

        const localFilePath = path.join(agentsDir, file);

        if (teamAgents.has(file)) {
          const teamFilePath = path.join(teamAgentsDir, file);
          const equal = await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue;

          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified' });
          }
        } else {
          const existing = candidates.get(name);
          if (!existing) {
            const mtime = await getFileMtime(localFilePath);
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            const mtime = await getFileMtime(localFilePath);
            if (mtime > existing.mtime) {
              candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
            }
          }
        }
      }
    }

    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      items.push({
        name,
        type: 'agents',
        sourcePath: candidate.sourcePath,
        relativePath: `agents/${name}.md`,
        status: candidate.status,
      });
    }
    return items;
  }

  /**
   * Scan team repo `agents/` for *.md files to pull. Hidden files
   * (e.g. `.removed` tombstone) are filtered out by listFiles.
   */
  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const agentsDir = path.join(localConfig.repo.localPath, 'agents');
    if (!await pathExists(agentsDir)) return [];

    const files = await listFiles(agentsDir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        type: 'agents' as const,
        sourcePath: path.join(agentsDir, f),
        relativePath: `agents/${f}`,
      }));
  }

  /**
   * Copy a local agent file to the team repo `agents/` directory.
   */
  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const dest = path.join(localConfig.repo.localPath, 'agents', `${item.name}.md`);
    if (item.sourcePath !== dest) {
      await ensureDir(path.dirname(dest));
      await copyFile(item.sourcePath, dest);
    }
    log.debug(`Copied agent ${item.name} → team repo`);
  }

  /**
   * Pull an agent file to every installed tool's agents/ directory.
   * Tools without agents path or not installed are silently skipped (per-tool
   * failure only warns; does not abort the whole pull).
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const baseDir = resolveBaseDir(localConfig);

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.agents) {
        log.debug(`Skipping agent sync for ${tool}: no agents path configured`);
        continue;
      }
      if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir)) {
        log.debug(`Skipping agent sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(baseDir, toolPath.agents);
      try {
        await ensureDir(destDir);
        const dest = path.join(destDir, `${item.name}.md`);
        await copyFile(item.sourcePath, dest);
        log.debug(`Synced agent ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync agent ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove an agent from the team repo and all tool agents/ directories.
   * Records a tombstone so subsequent pushes do not reintroduce it.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const baseDir = resolveBaseDir(localConfig);
    const fileName = `${name}.md`;

    const teamFile = path.join(localConfig.repo.localPath, 'agents', fileName);
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }

    await this.addTombstone(name, localConfig);

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.agents) continue;
      const filePath = path.join(baseDir, toolPath.agents, fileName);
      if (await pathExists(filePath)) {
        await remove(filePath);
        removed.push(filePath);
        log.debug(`Removed agent ${name} from ${tool}`);
      }
    }

    return removed;
  }
}
