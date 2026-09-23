import path from 'node:path';
import { COPILOT_TOOL_ID, getCopilotHome, resolveToolBaseDir, toolInstallRoot } from '../types.js';
import type { ResourceType, ResourceItem, ResourceDiff, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { readFileSafe, writeFile, ensureDir, pathExists } from '../utils/fs.js';
import { getUserHome } from '../utils/home.js';

const TOMBSTONE_FILE = '.removed';

/** Detect an installed tool while respecting tool-specific user roots. */
export async function isToolInstalledForConfig(
  tool: string,
  toolPath: string,
  localConfig: LocalConfig,
  exactConfigPath?: string,
): Promise<boolean> {
  const baseDir = resolveToolBaseDir(tool, localConfig);
  if (tool === COPILOT_TOOL_ID) {
    return localConfig.enabledAgents?.includes(COPILOT_TOOL_ID) === true
      || (exactConfigPath !== undefined && await pathExists(exactConfigPath))
      || pathExists(getCopilotHome());
  }
  return ResourceHandler.isToolInstalled(toolPath, baseDir);
}

/**
 * Abstract base class for resource handlers.
 * Each resource type (skills, rules, docs, env, agents, hooks, mcp) implements this.
 */
/**
 * What `push` knows before it scans. Only the destination an explicit
 * `--role`/`--project` names, and only agents read it: their scan has to
 * decide which team file a local edit is an edit OF, and that answer changes
 * when the user has named a namespace (see `AgentsHandler.scanLocalForPush`).
 * Rules and skills are placed after selection, so their scan needs nothing.
 */
export interface ScanForPushOptions {
  /** The namespace `--role <ns>` / `--project <id>` resolved to, if any. */
  namespace?: string;
}

export abstract class ResourceHandler {
  abstract readonly type: ResourceType;

  /**
   * Scan local sources for items that could be pushed to the team repo.
   * Returns items found locally that are not yet in the team repo.
   */
  abstract scanLocalForPush(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    options?: ScanForPushOptions,
  ): Promise<ResourceItem[]>;

  /**
   * Scan team repo for items that should be pulled to local.
   * Returns items from the team repo.
   */
  abstract scanTeamForPull(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceItem[]>;

  /**
   * Copy a resource item from local to the team repo directory.
   */
  abstract pushItem(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<void>;

  /**
   * Pull a resource item from the team repo and inject into local AI tool directories.
   */
  abstract pullItem(
    item: ResourceItem,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<void>;

  /**
   * Remove a resource from the team repo and all local AI tool directories.
   * Returns the list of paths that were removed.
   */
  abstract removeItem(
    name: string,
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<string[]>;

  /**
   * The name this resource is published under, when the user typed a different
   * one. `remove` matches what the user types against the team repo, where a
   * placed resource lives at `<root>/<ns>/<name>`; the author's local copy is
   * still at the resource root, so they know it by its bare name and `remove`
   * would answer "not found". Handlers that keep a placement record resolve it
   * here. Returns null when there is nothing to translate.
   */
  async publishedNameFor(_name: string, _localConfig: LocalConfig): Promise<string | null> {
    return null;
  }

  /**
   * Where `item` lands for each tool that can receive it on this machine.
   *
   * Read-only by contract: resolving a destination must never write, so the
   * same answer serves the sync and the checks that verify it. Two resolvers
   * for one destination is how "Synced N skills" ends up true while a tool
   * receives nothing (#598, #624).
   *
   * A tool that cannot receive the item is absent from the result: not
   * installed, no configured path, or outside the item's own targets.
   *
   * The default is empty, which also covers a resource with no per-tool file
   * destination at all. Docs land in one directory, env in one shell profile,
   * and hooks and MCP are entries inside a tool's own config file, so those
   * keep checks of their own instead of a sentinel tool.
   */
  async deliveryTargets(
    _teamConfig: TeamaiConfig,
    _localConfig: LocalConfig,
    _item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    return [];
  }

  /**
   * Check if an AI tool is installed by verifying its root directory exists.
   * e.g. for toolPath ".codebuddy/skills", checks if ~/.codebuddy/ exists.
   * This prevents creating directories for tools the user hasn't installed.
   * @param baseDir - Override base directory (defaults to HOME). Used for project scope.
   */
  static async isToolInstalled(toolPath: string, baseDir?: string): Promise<boolean> {
    const base = baseDir ?? getUserHome();
    const toolRoot = path.join(base, toolInstallRoot(toolPath));
    return pathExists(toolRoot);
  }

  /**
   * Read the tombstone file (`<type>/.removed`) from the team repo.
   * Returns a Set of resource names that have been explicitly deleted.
   */
  async readTombstones(localConfig: LocalConfig): Promise<Set<string>> {
    const tombstonePath = path.join(localConfig.repo.localPath, this.type, TOMBSTONE_FILE);
    const content = await readFileSafe(tombstonePath);
    if (!content) return new Set();
    return new Set(
      content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
    );
  }

  /**
   * Append a resource name to the tombstone file, deduplicating and sorting.
   */
  async addTombstone(name: string, localConfig: LocalConfig): Promise<void> {
    const dir = path.join(localConfig.repo.localPath, this.type);
    await ensureDir(dir);
    const tombstonePath = path.join(dir, TOMBSTONE_FILE);
    const existing = await this.readTombstones(localConfig);
    existing.add(name);
    const sorted = [...existing].sort();
    await writeFile(tombstonePath, sorted.join('\n') + '\n');
  }

  /**
   * Compute diff between local and team repo for this resource type.
   */
  async diff(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<ResourceDiff> {
    const localItems = await this.scanLocalForPush(teamConfig, localConfig);
    const teamItems = await this.scanTeamForPull(teamConfig, localConfig);

    const teamNames = new Set(teamItems.map((i) => i.name));
    const localNames = new Set(localItems.map((i) => i.name));

    const added = localItems.filter((i) => !teamNames.has(i.name));
    const removed = teamItems.filter((i) => !localNames.has(i.name));

    return { added, modified: [], removed };
  }
}
