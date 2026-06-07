import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { createPrWithFallback, filterExistingTopLevelPaths } from './push.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import type { GlobalOptions, ResourceType } from './types.js';
import { askConfirmation } from './utils/prompt.js';

const REMOVABLE_TYPES: ResourceType[] = ['skills', 'rules', 'wiki', 'agents'];

export async function remove(
  type: string,
  names: string[],
  options: GlobalOptions,
): Promise<void> {
  if (!REMOVABLE_TYPES.includes(type as ResourceType)) {
    log.error(`Unsupported resource type: ${type}. Supported types: ${REMOVABLE_TYPES.join(', ')}`);
    return;
  }

  if (names.length === 0) {
    log.error('No resource names provided');
    return;
  }

  // Auto-detect scope
  const { localConfig, teamConfig } = await autoDetectInit();

  // Pull latest before making changes
  try {
    await pullRepo(localConfig.repo.localPath);
  } catch { /* continue even if pull fails */ }

  const handler = getHandler(type as ResourceType);

  // Verify which resources exist
  const teamItems = await handler.scanTeamForPull(teamConfig, localConfig);
  const localItems = await handler.scanLocalForPush(teamConfig, localConfig);
  const allNames = new Set([...teamItems.map((i) => i.name), ...localItems.map((i) => i.name)]);

  const found: string[] = [];
  const notFound: string[] = [];
  for (const name of names) {
    if (allNames.has(name)) {
      found.push(name);
    } else {
      notFound.push(name);
    }
  }

  if (notFound.length > 0) {
    log.warn(`Not found (skipping): ${notFound.join(', ')}`);
  }

  if (found.length === 0) {
    log.error('No matching resources found to remove');
    log.info(`Available ${type}:`);
    for (const n of [...allNames].sort()) {
      console.log(`  - ${n}`);
    }
    return;
  }

  // Show what will be removed
  console.log('');
  console.log(`Will remove ${found.length} ${type}:`);
  for (const name of found) {
    console.log(`  - ${name}`);
  }
  console.log('');
  console.log('From: team repo + all local AI tool directories');
  console.log('');

  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  const confirmed = await askConfirmation('Are you sure? [y/N] ');
  if (!confirmed) {
    log.info('Cancelled');
    return;
  }

  const spin = spinner(`Removing ${found.length} ${type}...`).start();

  // Remove all resources
  let totalRemoved = 0;
  for (const name of found) {
    const removedPaths = await handler.removeItem(name, teamConfig, localConfig);
    totalRemoved += removedPaths.length;
  }

  // Refresh marketplace.json if skills were removed
  if (type === 'skills') {
    try {
      const { refreshMarketplace } = await import('./resources/marketplace.js');
      const updated = await refreshMarketplace(localConfig.repo.localPath);
      if (updated) {
        log.debug('Refreshed marketplace.json after skill removal');
      }
    } catch (e) {
      log.debug(`Marketplace refresh skipped: ${(e as Error).message}`);
    }
  }

  if (totalRemoved === 0) {
    spin.fail('Nothing was removed');
    return;
  }

  // Git commit and push via a single branch + MR
  try {
    const branchName = generateBranchName(localConfig.username);
    const nameList = found.length <= 3
      ? found.map((n) => `"${n}"`).join(', ')
      : `${found.slice(0, 3).map((n) => `"${n}"`).join(', ')} and ${found.length - 3} more`;
    const commitMsg = `[teamai] Remove ${found.length} ${type}: ${nameList} by ${localConfig.username}`;

    const candidateDirs = [`${type}/`, 'rules/', '.codebuddy-plugin/'];
    const gitFiles = await filterExistingTopLevelPaths(
      localConfig.repo.localPath,
      candidateDirs,
    );
    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      gitFiles,
      branchName,
    );

    if (!hasChanges) {
      spin.succeed('No changes to push');
    } else {
      spin.succeed(`Removed ${found.length} ${type} from ${totalRemoved} location(s)`);

      // Create PR/MR via provider (shared helper — DRY)
      await createPrWithFallback(
        teamConfig,
        localConfig,
        branchName,
        commitMsg,
        `Remove ${found.length} ${type}: ${nameList}`,
      );

      // Switch back to master after PR creation
      await checkoutMaster(localConfig.repo.localPath);
    }
  } catch (e) {
    spin.fail(`Git push failed: ${(e as Error).message}`);
    return;
  }

  // Clean up state tracking
  const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
  if (type === 'skills') {
    state.pushedSkills = state.pushedSkills.filter((s) => !found.includes(s));
  }
  if (type === 'rules') {
    state.pushedRules = state.pushedRules.filter((r) => !found.includes(r));
  }
  // `wiki` is not tracked in pushedX state; nothing to clean here.
  await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
}
