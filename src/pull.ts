import path from 'node:path';
import fse from 'fs-extra';
import { requireInit, loadState, saveState } from './config.js';
import { pullRepo } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { pathExists, remove, listFiles } from './utils/fs.js';
import { getHandler, RulesHandler, DocsHandler, EnvHandler } from './resources/index.js';
import type { GlobalOptions, ResourceType, ResourceItem, TeamaiConfig } from './types.js';
import { LEARNINGS_LOCAL_DIR } from './types.js';

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
    // Check the first installed tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(home, toolPath.skills);
      if (!await pathExists(skillsDir)) continue;
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
          log.info(`[dry-run] Would sync ${items.length} rule(s)`);
        } else {
          await rulesHandler.pullAllRules(freshConfig, localConfig);
          log.success(`Synced ${items.length} rule(s)`);
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

    // Docs: display actual file count instead of directory count
    if (type === 'docs') {
      const docsHandler = handler as DocsHandler;
      const fileCount = await docsHandler.countDocFiles(items[0].sourcePath);

      if (options.dryRun) {
        log.info(`[dry-run] Would sync ${fileCount} docs`);
      } else {
        await docsHandler.pullItem(items[0], freshConfig, localConfig);
        log.success(`Synced ${fileCount} docs`);
      }
      totalSynced += fileCount;
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

  // Step 3.5: Sync learnings and rebuild search index
  if (!options.dryRun) {
    try {
      const learningsRepoDir = path.join(localConfig.repo.localPath, 'learnings');
      if (await pathExists(learningsRepoDir)) {
        await fse.copy(learningsRepoDir, LEARNINGS_LOCAL_DIR, {
          overwrite: true,
          filter: (src: string) => !path.basename(src).startsWith('.'),
        });
        const allFiles = await listFiles(learningsRepoDir);
        const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
        if (mdFiles.length > 0) {
          const votesDir = path.join(localConfig.repo.localPath, 'votes');
          const votesExist = await pathExists(votesDir);
          const { buildIndex } = await import('./utils/search-index.js');
          const elapsed = await buildIndex(
            LEARNINGS_LOCAL_DIR,
            votesExist ? votesDir : undefined,
          );
          log.success(`Synced ${mdFiles.length} learnings (index: ${elapsed}ms)`);
        }
      }
    } catch (e) {
      log.debug(`Learnings sync skipped: ${(e as Error).message}`);
    }
  }

  // Step 4: Deploy CLI built-in skills (e.g. teamai-contribute)
  if (!options.dryRun) {
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      const deployed = await deployBuiltinSkills(freshConfig);
      if (deployed > 0) {
        log.debug(`Deployed ${deployed} built-in skill(s)`);
      }
    } catch (e) {
      log.debug(`Built-in skills deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 4.5: Deploy CLI built-in rules (e.g. teamai-recall)
  if (!options.dryRun) {
    try {
      const { deployBuiltinRules } = await import('./builtin-rules.js');
      const deployed = await deployBuiltinRules(freshConfig);
      if (deployed > 0) {
        log.debug(`Deployed built-in rules to ${deployed} tool(s)`);
      }
    } catch (e) {
      log.debug(`Built-in rules deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 5: Auto-report usage data to team repo (best-effort, non-blocking)
  if (!options.dryRun) {
    try {
      const { reportUsageToTeam } = await import('./team-push.js');
      await reportUsageToTeam(localConfig.repo.localPath, localConfig.username);
    } catch (e) {
      log.error(`Auto-report skipped: ${(e as Error).message}`);
    }
  }

  // Step 5: Show skill recommendations (if team stats available)
  if (!options.silent && !options.dryRun) {
    try {
      const YAML = (await import('yaml')).default;
      const { listFiles, readFileSafe } = await import('./utils/fs.js');
      const { getRecommendations, displayRecommendations } = await import('./skill-recommend.js');
      const statsDir = path.join(localConfig.repo.localPath, 'stats');
      const files = await listFiles(statsDir);
      const teamStats = [];
      for (const file of files) {
        if (!file.endsWith('.yaml')) continue;
        const content = await readFileSafe(path.join(statsDir, file));
        if (!content) continue;
        try {
          const parsed = YAML.parse(content);
          if (parsed?.username && parsed?.skills) teamStats.push(parsed);
        } catch { /* skip */ }
      }
      if (teamStats.length > 0) {
        const recs = await getRecommendations(teamStats);
        displayRecommendations(recs);
      }
    } catch {
      // Recommendations are optional — don't fail pull
    }
  }
}
