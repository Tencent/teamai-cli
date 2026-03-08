import path from 'node:path';
import { requireInit, loadState, saveState } from './config.js';
import { pullRepo } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { pathExists, remove } from './utils/fs.js';
import { getHandler, RulesHandler, EnvHandler } from './resources/index.js';
import type { GlobalOptions, ResourceType, ResourceItem, TeamaiConfig } from './types.js';

/**
 * Collect names of resources that already exist locally (before pull).
 * Used to distinguish "new" vs "updated" items in pull output.
 */
async function getExistingLocalNames(
  type: ResourceType,
  items: ResourceItem[],
  teamConfig: TeamaiConfig,
): Promise<Set<string>> {
  const existing = new Set<string>();
  const home = process.env.HOME ?? '';

  if (type === 'skills') {
    // Check the first syncTarget's skills directory
    const syncTargets = teamConfig.sharing.skills.syncTargets;
    for (const tool of syncTargets) {
      const toolPath = teamConfig.toolPaths[tool];
      if (!toolPath) continue;
      const skillsDir = path.join(home, toolPath.skills);
      for (const item of items) {
        const skillDir = path.join(skillsDir, item.name);
        if (await pathExists(skillDir)) {
          existing.add(item.name);
        }
      }
      // Only need to check the first available target
      break;
    }
  }

  return existing;
}

/**
 * Format pull detail output showing new vs updated items.
 */
function logSyncDetail(
  type: ResourceType,
  items: ResourceItem[],
  existingNames: Set<string>,
  verbose: boolean,
): void {
  const added = items.filter(i => !existingNames.has(i.name));
  const updated = items.filter(i => existingNames.has(i.name));

  if (added.length === 0 && updated.length > 0) {
    log.success(`Synced ${items.length} ${type} (all updated)`);
  } else if (added.length > 0) {
    log.success(`Synced ${items.length} ${type} (${added.length} new, ${updated.length} updated)`);
    const addedNames = added.map(i => i.name);
    log.dim(`    new: ${addedNames.join(', ')}`);
  } else {
    log.success(`Synced ${items.length} ${type}`);
  }

  if (verbose && updated.length > 0) {
    const updatedNames = updated.map(i => i.name);
    log.dim(`    updated: ${updatedNames.join(', ')}`);
  }
}

export async function pull(options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await requireInit();

  // Step 1: git pull
  const pullSpin = spinner('Pulling team repo...').start();
  try {
    const result = await pullRepo(localConfig.repo.localPath);
    pullSpin.succeed(`Team repo: ${result}`);
  } catch (e) {
    pullSpin.fail(`Pull failed: ${(e as Error).message}`);
    return;
  }

  // Reload team config after pull (might have changed)
  const { teamConfig: freshConfig } = await requireInit();

  // Step 2: Sync each resource type
  const resourceTypes: ResourceType[] = ['skills', 'rules', 'docs', 'env'];
  let totalSynced = 0;

  for (const type of resourceTypes) {
    const handler = getHandler(type);

    if (type === 'rules') {
      // Rules use bulk merge into CLAUDE.md
      const rulesHandler = handler as RulesHandler;
      const items = await rulesHandler.scanTeamForPull(freshConfig, localConfig);
      if (items.length > 0) {
        if (options.dryRun) {
          log.info(`[dry-run] Would merge ${items.length} rule(s) into CLAUDE.md`);
        } else {
          await rulesHandler.pullAllRules(freshConfig, localConfig);
          log.success(`Merged ${items.length} rule(s) into CLAUDE.md`);
        }
        totalSynced += items.length;
      }
      continue;
    }

    const items = await handler.scanTeamForPull(freshConfig, localConfig);
    if (items.length === 0) continue;

    // Env uses special handling
    if (type === 'env') {
      const envHandler = handler as EnvHandler;
      const varCount = await envHandler.countEnvVars(items[0].sourcePath);
      if (varCount === 0) continue;

      if (options.dryRun) {
        log.info(`[dry-run] Would sync ${varCount} env variable(s)`);
      } else {
        await envHandler.pullItem(items[0], freshConfig, localConfig);
        log.success(`Synced ${varCount} env variable(s) to ~/.teamai/env.sh`);
      }
      totalSynced += 1;
      continue;
    }

    // Collect existing local resource names before pulling
    const existingNames = await getExistingLocalNames(type, items, freshConfig);

    if (options.dryRun) {
      const added = items.filter(i => !existingNames.has(i.name));
      const updated = items.filter(i => existingNames.has(i.name));

      if (added.length > 0 && type === 'skills') {
        log.info(`[dry-run] Would pull ${items.length} ${type} (${added.length} new, ${updated.length} updated)`);
        log.dim(`    new: ${added.map(i => i.name).join(', ')}`);
      } else {
        log.info(`[dry-run] Would pull ${items.length} ${type}`);
      }
      if (options.verbose) {
        for (const item of items) {
          log.dim(`  ${item.name}`);
        }
      }
    } else {
      for (const item of items) {
        await handler.pullItem(item, freshConfig, localConfig);
      }

      if (type === 'skills') {
        logSyncDetail(type, items, existingNames, !!options.verbose);
      } else {
        log.success(`Synced ${items.length} ${type}`);
      }
    }

    totalSynced += items.length;
  }

  // Step 3: Clean up local files that have been tombstoned (removed from team repo)
  if (!options.dryRun) {
    const tombstoneTypes: { type: ResourceType; ext?: string }[] = [
      { type: 'rules', ext: '.md' },
      { type: 'skills' },
    ];

    for (const { type, ext } of tombstoneTypes) {
      const handler = getHandler(type);
      const tombstones = await handler.readTombstones(localConfig);
      if (tombstones.size === 0) continue;

      const home = process.env.HOME ?? '';
      for (const [_tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        const dir = type === 'rules' ? toolPath.rules : toolPath.skills;
        if (!dir) continue;

        for (const name of tombstones) {
          const localPath = path.join(home, dir, ext ? `${name}${ext}` : name);
          if (await pathExists(localPath)) {
            await remove(localPath);
            log.debug(`Cleaned up tombstoned ${type} ${name} from ${dir}`);
          }
        }
      }
    }
  }

  if (totalSynced === 0) {
    log.info('No resources to sync');
  } else if (!options.dryRun) {
    // Update state
    const state = await loadState();
    state.lastPull = new Date().toISOString();
    await saveState(state);
  }
}
