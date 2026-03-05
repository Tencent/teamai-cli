import path from 'node:path';
import type { ResourceType, ResourceItem, ResourceDiff, TeamaiConfig, LocalConfig } from '../types.js';
import { readFileSafe, writeFile, ensureDir } from '../utils/fs.js';

const TOMBSTONE_FILE = '.removed';

/**
 * Abstract base class for resource handlers.
 * Each resource type (skills, rules, hooks, docs, instincts) implements this.
 */
export abstract class ResourceHandler {
  abstract readonly type: ResourceType;

  /**
   * Scan local sources for items that could be pushed to the team repo.
   * Returns items found locally that are not yet in the team repo.
   */
  abstract scanLocalForPush(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
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
