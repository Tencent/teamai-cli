import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { listFiles, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, writeFile, readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { resolveBaseDir } from '../types.js';
import { BUILTIN_AGENT_NAMES } from '../builtin-agents.js';
import {
  parseAgentYaml,
  serializeAgentYaml,
  renderForTool,
  reverseFromClaude,
  reverseFromCodebuddy,
  reverseFromCodex,
  reverseFromCursor,
  mergeReverseResults,
  ALL_SUPPORTED_TOOLS,
} from './agent-format.js';
import type { AgentSpec, ToolName, ReverseResult, ParseResult } from './agent-format.js';

/**
 * Extended ResourceItem for agents — carries merged spec or skip reason
 * from multi-tool reverse parse (new YAML format push path).
 */
export interface AgentResourceItem extends ResourceItem {
  /** Merged spec produced by scanLocalForPush (new .yaml format only). */
  mergedSpec?: AgentSpec;
  /** Human-readable reason to skip this item during pushItem (merge failed). */
  skipReason?: string;
  /** True when item came from a legacy .md team-repo file (older format). */
  legacy?: boolean;
}

/**
 * AgentsHandler — manage AI subagent definitions distributed via the team repo.
 *
 * Layout:
 *   New format:   team-repo/agents/<name>.yaml  → rendered per-tool on pull
 *   Legacy format: team-repo/agents/<name>.md    → copied as-is (claude/claude-internal/codebuddy only)
 *
 * Tools without an `agents` path in toolPaths are silently skipped.
 */
export class AgentsHandler extends ResourceHandler {
  readonly type = 'agents' as const;

  /**
   * Scan local AI tool agents/ directories for files that are new or modified
   * compared to the team repo. Groups by agent name stem across all tools.
   *
   * New format (.yaml in team repo): attempts multi-tool reverse + merge.
   * Built-in CLI agents are excluded from push.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<AgentResourceItem[]> {
    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');
    const tombstones = await this.readTombstones(localConfig);
    const baseDir = resolveBaseDir(localConfig);

    // Collect all local agent files grouped by stem
    const grouped = new Map<string, Map<string, string>>(); // stem → (tool → filePath)

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.agents) continue;
      const agentsDir = path.join(baseDir, toolPath.agents);
      if (!await pathExists(agentsDir)) continue;

      const files = await listFiles(agentsDir);
      for (const file of files) {
        const stem = getAgentStem(file);
        if (stem === null) continue;
        if (tombstones.has(stem)) continue;
        if (BUILTIN_AGENT_NAMES.has(stem)) continue;

        const filePath = path.join(agentsDir, file);
        let toolGroup = grouped.get(stem);
        if (!toolGroup) {
          toolGroup = new Map();
          grouped.set(stem, toolGroup);
        }
        // Use latest mtime if same tool appears via multiple tool paths (shouldn't happen normally)
        if (!toolGroup.has(tool)) {
          toolGroup.set(tool, filePath);
        }
      }
    }

    const items: AgentResourceItem[] = [];

    for (const [stem, toolFiles] of grouped) {
      const teamYamlPath = path.join(teamAgentsDir, `${stem}.yaml`);
      const teamMdPath = path.join(teamAgentsDir, `${stem}.md`);

      // Determine if this agent is already in the team repo
      const hasTeamYaml = await pathExists(teamYamlPath);
      const hasTeamMd = await pathExists(teamMdPath);

      // Check if any local file differs from team copy
      let hasChange = false;
      if (!hasTeamYaml && !hasTeamMd) {
        hasChange = true; // brand new
      } else {
        for (const [, filePath] of toolFiles) {
          const teamRef = hasTeamYaml ? teamYamlPath : teamMdPath;
          const equal = await fileContentEqual(filePath, teamRef).catch((err) => {
            console.warn(
              `[agents] 比较文件内容失败 ${filePath} vs ${teamRef}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          });
          if (!equal) {
            hasChange = true;
            break;
          }
        }
      }

      if (!hasChange) continue;

      const status: ResourceItemStatus = (hasTeamYaml || hasTeamMd) ? 'modified' : 'new';

      // Determine representative source path (prefer highest mtime)
      let bestPath = '';
      let bestMtime = 0;
      for (const [, filePath] of toolFiles) {
        const mtime = await getFileMtime(filePath);
        if (mtime > bestMtime) {
          bestMtime = mtime;
          bestPath = filePath;
        }
      }

      // Attempt reverse + merge for new YAML format push
      const perToolSpecs: Partial<Record<ToolName, AgentSpec>> = {};
      let skipReason: string | undefined;

      for (const [tool, filePath] of toolFiles) {
        if (!isKnownTool(tool)) continue;
        const content = await readFileSafe(filePath);
        if (!content) continue;

        const result = reverseByTool(tool, filePath, content);
        if (result.ok) {
          perToolSpecs[tool as ToolName] = result.spec;
        } else {
          log.debug(`Reverse failed for ${stem} from ${tool}: ${result.reason}`);
        }
      }

      if (Object.keys(perToolSpecs).length === 0) {
        skipReason = `could not reverse-parse any tool's agent file for ${stem}`;
      } else {
        const mergeResult = mergeReverseResults(perToolSpecs);
        if (!mergeResult.ok) {
          const conflictSummary = mergeResult.conflicts
            .map((c) => `${c.field}: ${JSON.stringify(c.values)}`)
            .join('; ');
          skipReason = `conflicting values across tools — ${conflictSummary}`;
        } else {
          items.push({
            name: stem,
            type: 'agents',
            sourcePath: bestPath,
            relativePath: `agents/${stem}.yaml`,
            status,
            mergedSpec: mergeResult.spec,
          });
          continue;
        }
      }

      // Fall back to pushing the raw md file (legacy behavior)
      items.push({
        name: stem,
        type: 'agents',
        sourcePath: bestPath,
        relativePath: `agents/${stem}.md`,
        status,
        skipReason,
      });
    }

    return items;
  }

  /**
   * Scan team repo `agents/` for files to pull.
   * Recognizes both *.yaml (new) and *.md (legacy).
   * Hidden files (tombstones) are filtered out by listFiles.
   */
  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<AgentResourceItem[]> {
    const agentsDir = path.join(localConfig.repo.localPath, 'agents');
    if (!await pathExists(agentsDir)) return [];

    const files = await listFiles(agentsDir);
    const items: AgentResourceItem[] = [];

    for (const file of files) {
      if (file.endsWith('.yaml')) {
        const stem = file.replace(/\.yaml$/, '');
        items.push({
          name: stem,
          type: 'agents',
          sourcePath: path.join(agentsDir, file),
          relativePath: `agents/${file}`,
          legacy: false,
        });
      } else if (file.endsWith('.md')) {
        const stem = file.replace(/\.md$/, '');
        items.push({
          name: stem,
          type: 'agents',
          sourcePath: path.join(agentsDir, file),
          relativePath: `agents/${file}`,
          legacy: true,
        });
      }
    }

    return items;
  }

  /**
   * Push an agent to the team repo.
   * New format: writes mergedSpec as <name>.yaml.
   * Skip: logs warning and returns without writing.
   * Legacy fallback: copies the raw .md file.
   */
  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const agentItem = item as AgentResourceItem;

    if (agentItem.skipReason) {
      log.warn(`[agents] 跳过 ${item.name}: ${agentItem.skipReason}`);
      log.warn('  建议修改后重新 push 该 subagent');
      return;
    }

    if (agentItem.mergedSpec) {
      const dest = path.join(localConfig.repo.localPath, 'agents', `${item.name}.yaml`);
      await ensureDir(path.dirname(dest));
      const yamlContent = serializeAgentYaml(agentItem.mergedSpec);
      await writeFile(dest, yamlContent);
      log.debug(`Wrote agent ${item.name} → team repo (YAML format)`);
      return;
    }

    // Legacy: copy raw .md
    const dest = path.join(localConfig.repo.localPath, 'agents', `${item.name}.md`);
    if (item.sourcePath !== dest) {
      await ensureDir(path.dirname(dest));
      await copyFile(item.sourcePath, dest);
    }
    log.debug(`Copied agent ${item.name} → team repo (legacy MD format)`);
  }

  /**
   * Pull an agent to every installed tool's agents/ directory.
   *
   * New format (.yaml): parses spec, respects spec.targets, renders per-tool native format.
   * Legacy format (.md): copies .md as-is to claude/claude-internal/codebuddy only.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const agentItem = item as AgentResourceItem;
    const baseDir = resolveBaseDir(localConfig);

    // Determine format: explicit flag takes precedence; fall back to extension detection
    const isLegacy = agentItem.legacy === true || (!agentItem.legacy && !item.sourcePath.endsWith('.yaml'));

    if (isLegacy) {
      // Legacy: copy .md to tools that support agents
      await this.pullLegacyMd(item, teamConfig, baseDir);
      return;
    }

    // New YAML format: parse + render per-tool
    const content = await readFileSafe(item.sourcePath);
    if (!content) {
      log.warn(`agents: cannot read ${item.sourcePath}`);
      return;
    }

    let spec: AgentSpec;
    const parseResult: ParseResult = parseAgentYaml(content, item.name + '.yaml');
    if (!parseResult.ok) {
      console.warn(`[agents] 解析失败 ${item.name}.yaml: ${parseResult.reason}, 已跳过`);
      return;
    }
    spec = parseResult.spec;

    const targets = spec.targets ?? ALL_SUPPORTED_TOOLS;

    for (const tool of targets) {
      const toolPath = teamConfig.toolPaths[tool];
      if (!toolPath?.agents) {
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
        const { ext, content: rendered } = renderForTool(spec, tool);
        const dest = path.join(destDir, `${item.name}${ext}`);
        await writeFile(dest, rendered);
        log.debug(`Rendered agent ${item.name} → ${tool} (${ext})`);
      } catch (e) {
        log.warn(`Failed to sync agent ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove an agent from the team repo and all tool agents/ directories.
   * Tries both .yaml and .md extensions in the team repo.
   * Records a tombstone to prevent re-push.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const baseDir = resolveBaseDir(localConfig);

    const teamAgentsDir = path.join(localConfig.repo.localPath, 'agents');

    for (const ext of ['.yaml', '.md'] as const) {
      const teamFile = path.join(teamAgentsDir, `${name}${ext}`);
      if (await pathExists(teamFile)) {
        await remove(teamFile);
        removed.push(teamFile);
      }
    }

    await this.addTombstone(name, localConfig);

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.agents) continue;
      // Try removing both .md and .toml variants
      for (const ext of ['.md', '.toml'] as const) {
        const filePath = path.join(baseDir, toolPath.agents, `${name}${ext}`);
        if (await pathExists(filePath)) {
          await remove(filePath);
          removed.push(filePath);
          log.debug(`Removed agent ${name} from ${tool}`);
        }
      }
    }

    return removed;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Legacy pull: copies .md as-is to claude/claude-internal/codebuddy.
   */
  private async pullLegacyMd(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    baseDir: string,
  ): Promise<void> {
    const legacyTools = new Set(['claude', 'claude-internal', 'codebuddy']);

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!legacyTools.has(tool)) continue;
      if (!toolPath.agents) {
        log.debug(`Skipping legacy agent sync for ${tool}: no agents path configured`);
        continue;
      }
      if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir)) {
        log.debug(`Skipping legacy agent sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(baseDir, toolPath.agents);
      try {
        await ensureDir(destDir);
        const dest = path.join(destDir, `${item.name}.md`);
        await copyFile(item.sourcePath, dest);
        log.debug(`Synced legacy agent ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync legacy agent ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }
}

// ─── Module-level helpers ──────────────────────────────────────────────────

/**
 * Extract agent name stem from a filename.
 * Accepts .md and .toml extensions only; returns null for other files.
 */
function getAgentStem(filename: string): string | null {
  if (filename.endsWith('.md')) return filename.slice(0, -3);
  if (filename.endsWith('.toml')) return filename.slice(0, -5);
  return null;
}

/**
 * Check if a tool name is one of the 6 known agent-capable tools.
 */
function isKnownTool(tool: string): tool is ToolName {
  return (ALL_SUPPORTED_TOOLS as string[]).includes(tool);
}

/**
 * Dispatch reverse parsing to the correct function for each tool.
 */
function reverseByTool(tool: ToolName, filePath: string, content: string): ReverseResult {
  switch (tool) {
    case 'claude':
    case 'claude-internal':
      return reverseFromClaude(filePath, content);
    case 'codebuddy':
      return reverseFromCodebuddy(filePath, content);
    case 'codex':
    case 'codex-internal':
      return reverseFromCodex(filePath, content);
    case 'cursor':
      return reverseFromCursor(filePath, content);
  }
}
