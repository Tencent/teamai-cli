import path from 'node:path';
import fse from 'fs-extra';
import { requireInit, loadState, saveState, detectProjectConfig, loadLocalConfigForScope, loadTeamConfig, loadStateForScope, saveStateForScope } from './config.js';
import { pullRepo, getHeadRev } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { pathExists, remove, listFiles, listDirs } from './utils/fs.js';
import { getHandler, RulesHandler, DocsHandler, EnvHandler } from './resources/index.js';
import { loadTagsConfig, filterByTags } from './utils/tags.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import type { GlobalOptions, ResourceType, ResourceItem, TeamaiConfig, LocalConfig, TagsConfig } from './types.js';
import { LEARNINGS_LOCAL_DIR, resolveBaseDir, getTeamaiHome } from './types.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, type ResourceNamespaces } from './roles.js';

interface RolePullContext {
  activeNamespaces: ResourceNamespaces;
  activeSkillNames: Set<string>;
  inactiveSkillNames: Set<string>;
}

async function buildRolePullContext(localConfig: LocalConfig): Promise<RolePullContext | null> {
  if (!localConfig.primaryRole) return null;

  const manifest = await loadRolesManifest(localConfig.repo.localPath);
  const activeNamespaces = resolveRoleResourceNamespaces({
    manifest,
    primaryRole: localConfig.primaryRole,
    additionalRoles: localConfig.additionalRoles ?? [],
  });

  const allSkillNamespaces = new Set(
    manifest.roles.flatMap((role) => role.resources.skills),
  );
  const inactiveSkillNamespaces = [...allSkillNamespaces].filter((namespace) => !activeNamespaces.skills.includes(namespace));
  const activeSkillNames = new Set<string>();
  const inactiveSkillNames = new Set<string>();

  for (const namespace of activeNamespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      activeSkillNames.add(name);
    }
  }

  for (const namespace of inactiveSkillNamespaces) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const names = await listDirs(namespaceDir);
    for (const name of names) {
      inactiveSkillNames.add(name);
    }
  }

  return { activeNamespaces, activeSkillNames, inactiveSkillNames };
}

export async function scanRoleAwareSkills(localConfig: LocalConfig, namespaces: ResourceNamespaces): Promise<ResourceItem[]> {
  const items = new Map<string, ResourceItem>();

  for (const namespace of namespaces.skills) {
    const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace);
    const dirs = await listDirs(namespaceDir);
    for (const dir of dirs) {
      const existing = items.get(dir);
      if (existing) {
        throw new Error(`Duplicate skill "${dir}" found in active namespaces "${existing.namespace}" and "${namespace}"`);
      }

      items.set(dir, {
        name: dir,
        type: 'skills',
        sourcePath: path.join(namespaceDir, dir),
        relativePath: `skills/${namespace}/${dir}`,
        namespace,
      });
    }
  }

  return [...items.values()];
}

export async function cleanupInactiveNamespaceSkills(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  activeSkillNames: Set<string>,
  inactiveSkillNames: Set<string>,
): Promise<void> {
  const baseDir = resolveBaseDir(localConfig);

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.skills) continue;
    if (!await pathExists(path.join(baseDir, toolPath.skills))) continue;

    const localSkillNames = await listDirs(path.join(baseDir, toolPath.skills));
    for (const skillName of localSkillNames) {
      if (BUILTIN_SKILL_NAMES.has(skillName)) continue;
      if (activeSkillNames.has(skillName)) continue;
      if (!inactiveSkillNames.has(skillName)) continue;

      const localSkillDir = path.join(baseDir, toolPath.skills, skillName);
      await remove(localSkillDir);
      log.debug(`[${localConfig.scope}] Removed inactive role-scoped skill ${skillName} from ${tool}`);
    }
  }
}

/**
 * Collect names of resources that already exist locally (before pull).
 * Used to distinguish "new" vs "updated" items in pull output.
 */
async function getExistingLocalNames(
  type: ResourceType,
  items: ResourceItem[],
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<Set<string>> {
  const existing = new Set<string>();
  const baseDir = resolveBaseDir(localConfig);

  if (type === 'skills') {
    // Check the first installed tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(baseDir, toolPath.skills);
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
  scopeLabel?: string,
  skippedCount?: number,
): void {
  const prefix = scopeLabel ? `[${scopeLabel}] ` : '';
  const added = items.filter(i => !existingNames.has(i.name));
  const updated = items.filter(i => existingNames.has(i.name));

  const skipSuffix = skippedCount && skippedCount > 0
    ? `, skipped ${skippedCount} by tags`
    : '';

  if (added.length === 0 && updated.length > 0) {
    log.success(`${prefix}Synced ${items.length} ${type} (all updated${skipSuffix})`);
  } else if (added.length > 0) {
    log.success(`${prefix}Synced ${items.length} ${type} (${added.length} new, ${updated.length} updated${skipSuffix})`);
    const addedNames = added.map(i => i.name);
    log.dim(`    new: ${addedNames.join(', ')}`);
  } else {
    log.success(`${prefix}Synced ${items.length} ${type}${skipSuffix ? ` (${skipSuffix.trim().replace(/^, /, '')})` : ''}`);
  }

  if (verbose && updated.length > 0) {
    const updatedNames = updated.map(i => i.name);
    log.dim(`    updated: ${updatedNames.join(', ')}`);
  }
}

/**
 * Pull resources for a single scope. This is the core sync logic extracted
 * from the original pull() function to support both user and project scope.
 */
async function pullForScope(
  localConfig: LocalConfig,
  options: GlobalOptions,
): Promise<void> {
  const scopeLabel = localConfig.scope;
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) {
    log.warn(`[${scopeLabel}] Team config (teamai.yaml) not found. Skipping.`);
    return;
  }

  // Step 1: git pull
  const pullSpin = spinner(`[${scopeLabel}] Pulling team repo...`).start();
  try {
    const result = await pullRepo(localConfig.repo.localPath);
    pullSpin.succeed(`[${scopeLabel}] Team repo: ${result}`);
  } catch (e) {
    pullSpin.fail(`[${scopeLabel}] Pull failed: ${(e as Error).message}`);
    return;
  }

  // Step 1b: Skip sync if repo HEAD hasn't changed since last pull
  if (!options.force && !options.dryRun) {
    try {
      const currentRev = await getHeadRev(localConfig.repo.localPath);
      const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
      if (state.lastPullRev && state.lastPullRev === currentRev) {
        log.success(`[${scopeLabel}] Already synced at ${currentRev}, skipping`);
        return;
      }
    } catch {
      // If rev check fails, proceed with full sync
      log.debug(`[${scopeLabel}] Rev check failed, proceeding with full sync`);
    }
  }

  // Reload team config after pull (might have changed)
  const freshConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!freshConfig) {
    log.warn(`[${scopeLabel}] Team config disappeared after pull. Skipping.`);
    return;
  }

  // Load role context (if primaryRole configured)
  let roleContext: RolePullContext | null = null;
  try {
    roleContext = await buildRolePullContext(localConfig);
  } catch (e) {
    log.error(`[${scopeLabel}] ${(e as Error).message}`);
    return;
  }

  // Load tags config for filtering
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const subscribedTags = localConfig.subscribedTags;

  // Step 2: Sync each resource type
  const resourceTypes: ResourceType[] = ['skills', 'rules', 'docs', 'env'];
  let totalSynced = 0;
  let desiredSkillNames: Set<string> | null = null;
  let knownRepoSkillNames: Set<string> | null = null;

  for (const type of resourceTypes) {
    const handler = getHandler(type);

    if (type === 'rules') {
      const rulesHandler = handler as RulesHandler;
      const allItems = await rulesHandler.scanTeamForPull(freshConfig, localConfig);
      const { included: items, skipped } = filterByTags(allItems, tagsConfig, subscribedTags, 'rules');
      if (items.length > 0) {
        if (options.dryRun) {
          log.info(`[${scopeLabel}] [dry-run] Would sync ${items.length} rule(s)${skipped.length > 0 ? ` (skipped ${skipped.length} by tags)` : ''}`);
        } else {
          await rulesHandler.pullAllRules(freshConfig, localConfig, items);
          log.success(`[${scopeLabel}] Synced ${items.length} rule(s)${skipped.length > 0 ? ` (skipped ${skipped.length} by tags)` : ''}`);
        }
        totalSynced += items.length;
      }
      continue;
    }

    // Skills: directory (role namespace) first, then tags, union of both
    let items: ResourceItem[];
    let skippedByTags = 0;
    if (type === 'skills') {
      const directoryItems = roleContext
        ? await scanRoleAwareSkills(localConfig, roleContext.activeNamespaces)
        : await handler.scanTeamForPull(freshConfig, localConfig);

      const allTeamSkills = await handler.scanTeamForPull(freshConfig, localConfig);
      const { included: tagIncluded, skipped: tagSkipped } = filterByTags(
        allTeamSkills, tagsConfig, subscribedTags, 'skills',
      );
      skippedByTags = tagSkipped.length;

      // Union: merge directory items with tag-matched items
      const merged = new Map<string, ResourceItem>();
      for (const item of directoryItems) merged.set(item.name, item);
      for (const item of tagIncluded) {
        if (!merged.has(item.name)) merged.set(item.name, item);
      }
      items = [...merged.values()];
      desiredSkillNames = new Set(items.map((i) => i.name));
      knownRepoSkillNames = new Set(allTeamSkills.map((i) => i.name));
    } else {
      items = await handler.scanTeamForPull(freshConfig, localConfig);
    }
    if (items.length === 0) continue;

    if (type === 'env') {
      const envHandler = handler as EnvHandler;
      const varCount = await envHandler.countEnvVars(items[0].sourcePath);
      if (varCount === 0) continue;

      if (options.dryRun) {
        log.info(`[${scopeLabel}] [dry-run] Would sync ${varCount} env variable(s)`);
      } else {
        await envHandler.pullItem(items[0], freshConfig, localConfig);
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        log.success(`[${scopeLabel}] Synced ${varCount} env variable(s) to ${teamaiHome}/env.sh`);
      }
      totalSynced += 1;
      continue;
    }

    if (type === 'docs') {
      const docsHandler = handler as DocsHandler;
      const fileCount = await docsHandler.countDocFiles(items[0].sourcePath);

      if (options.dryRun) {
        log.info(`[${scopeLabel}] [dry-run] Would sync ${fileCount} docs`);
      } else {
        await docsHandler.pullItem(items[0], freshConfig, localConfig);
        log.success(`[${scopeLabel}] Synced ${fileCount} docs`);
      }
      totalSynced += fileCount;
      continue;
    }

    // Collect existing local resource names before pulling
    const existingNames = await getExistingLocalNames(type, items, freshConfig, localConfig);

    if (options.dryRun) {
      const added = items.filter(i => !existingNames.has(i.name));
      const updated = items.filter(i => existingNames.has(i.name));

      if (added.length > 0 && type === 'skills') {
        log.info(`[${scopeLabel}] [dry-run] Would pull ${items.length} ${type} (${added.length} new, ${updated.length} updated)`);
        log.dim(`    new: ${added.map(i => i.name).join(', ')}`);
      } else {
        log.info(`[${scopeLabel}] [dry-run] Would pull ${items.length} ${type}`);
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
        logSyncDetail(type, items, existingNames, !!options.verbose, scopeLabel, skippedByTags);
      } else {
        log.success(`[${scopeLabel}] Synced ${items.length} ${type}`);
      }
    }

    totalSynced += items.length;
  }

  // Step 3: Clean up tombstoned resources
  if (!options.dryRun) {
    const tombstoneTypes: { type: ResourceType; ext?: string }[] = [
      { type: 'rules', ext: '.md' },
      { type: 'skills' },
    ];

    const baseDir = resolveBaseDir(localConfig);
    for (const { type, ext } of tombstoneTypes) {
      const handler = getHandler(type);
      const tombstones = await handler.readTombstones(localConfig);
      if (tombstones.size === 0) continue;

      for (const [_tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        const dir = type === 'rules' ? toolPath.rules : toolPath.skills;
        if (!dir) continue;

        for (const name of tombstones) {
          const localPath = path.join(baseDir, dir, ext ? `${name}${ext}` : name);
          if (await pathExists(localPath)) {
            await remove(localPath);
            log.debug(`[${scopeLabel}] Cleaned up tombstoned ${type} ${name} from ${dir}`);
          }
        }
      }
    }

    if (roleContext) {
      await cleanupInactiveNamespaceSkills(
        freshConfig,
        localConfig,
        roleContext.activeSkillNames,
        roleContext.inactiveSkillNames,
      );
    }
  }

  // Step 3b: Clean up local skills not in the desired union set (role + tags)
  if (!options.dryRun && desiredSkillNames && knownRepoSkillNames) {
    const baseDir = resolveBaseDir(localConfig);

    for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(baseDir, toolPath.skills);
      if (!await pathExists(skillsDir)) continue;

      const localDirs = await listDirs(skillsDir);
      for (const dir of localDirs) {
        if (BUILTIN_SKILL_NAMES.has(dir)) continue;
        if (desiredSkillNames.has(dir)) continue;
        if (!knownRepoSkillNames.has(dir)) continue;
        const skillDir = path.join(skillsDir, dir);
        await remove(skillDir);
        log.debug(`Removed excluded skill ${dir} from ${tool}`);
      }
    }
  }

  if (totalSynced === 0) {
    log.info(`[${scopeLabel}] No resources to sync`);
  } else if (!options.dryRun) {
    const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
    state.lastPull = new Date().toISOString();
    try {
      state.lastPullRev = await getHeadRev(localConfig.repo.localPath);
    } catch {
      // Non-critical: if we can't get the rev, just clear it
      state.lastPullRev = null;
    }
    await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
  }

  // Step 3.5: Sync learnings and rebuild search index (user scope only)
  if (!options.dryRun && localConfig.scope === 'user') {
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

  // Step 4: Deploy CLI built-in skills
  if (!options.dryRun) {
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      const deployed = await deployBuiltinSkills(freshConfig, localConfig);
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed ${deployed} built-in skill(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in skills deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 4.5: Deploy CLI built-in rules
  if (!options.dryRun) {
    try {
      const { deployBuiltinRules } = await import('./builtin-rules.js');
      const deployed = await deployBuiltinRules(freshConfig, localConfig);
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed built-in rules to ${deployed} tool(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in rules deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 5: Auto-report usage data (user scope only)
  if (!options.dryRun && localConfig.scope === 'user') {
    try {
      const { reportUsageToTeam } = await import('./team-push.js');
      await reportUsageToTeam(localConfig.repo.localPath, localConfig.username);
    } catch (e) {
      log.error(`Auto-report skipped: ${(e as Error).message}`);
    }
  }

  // Step 6: Show skill recommendations (user scope only)
  if (!options.silent && !options.dryRun && localConfig.scope === 'user') {
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

/**
 * Main pull entry point.
 * Implements Scheme B: user scope is always pulled (baseline),
 * project scope is additionally pulled if detected in cwd.
 */
export async function pull(options: GlobalOptions): Promise<void> {
  // 1. Always try to pull user scope
  try {
    const userConfig = await loadLocalConfigForScope('user');
    if (userConfig) {
      await pullForScope(userConfig, options);
    } else {
      log.debug('No user-scope config found, skipping user pull');
    }
  } catch (e) {
    log.warn(`User-scope pull error: ${(e as Error).message}`);
  }

  // 2. Detect and pull project scope if cwd has .teamai/config.yaml with scope='project'
  try {
    const projectConfig = await detectProjectConfig();
    if (projectConfig) {
      await pullForScope(projectConfig, options);
    }
  } catch (e) {
    log.warn(`Project-scope pull error: ${(e as Error).message}`);
  }
}
