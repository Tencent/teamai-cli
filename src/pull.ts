import path from 'node:path';
import fse from 'fs-extra';
import matter from 'gray-matter';
import { requireInit, loadState, saveState, detectProjectConfig, loadLocalConfigForScope, loadTeamConfig, loadStateForScope, saveStateForScope } from './config.js';
import { pullRepo, getHeadRev } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { pathExists, remove, listFiles, listDirs, readFileSafe } from './utils/fs.js';
import { injectClaudeMdSection } from './utils/claudemd.js';
import { getHandler, RulesHandler, DocsHandler, EnvHandler } from './resources/index.js';
import { ResourceHandler } from './resources/base.js';
import { loadTagsConfig, filterByTags } from './utils/tags.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import type { GlobalOptions, ResourceType, ResourceItem, TeamaiConfig, LocalConfig, TagsConfig } from './types.js';
import {
  LEARNINGS_LOCAL_DIR,
  TEAMAI_CULTURE_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  CultureFrontmatterSchema,
  resolveBaseDir,
  getTeamaiHome,
  isRecallEnabled,
} from './types.js';
import type { CultureFrontmatter } from './types.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, type ResourceNamespaces } from './roles.js';

interface RolePullContext {
  activeNamespaces: ResourceNamespaces;
  activeSkillNames: Set<string>;
  inactiveSkillNames: Set<string>;
}

/**
 * Refresh the local team-repo tree, abstracting the two backends.
 *
 * - git:  `git pull` into localPath; version = current HEAD rev.
 * - http: re-materialize `GET /repo` into localPath; version = server version.
 *
 * Returns a display label and the opaque version string used as the
 * incremental-sync cache key (state.lastPullRev). `version` is null only when
 * the git backend can't resolve a rev.
 */
async function refreshTeamRepo(
  localConfig: LocalConfig,
): Promise<{ label: string; version: string | null; reportingOnly: boolean }> {
  if (localConfig.repo.kind === 'http') {
    const { resolveApiKey } = await import('./api-key.js');
    const { materializeHttpRepo, RepoNotAvailableError } = await import('./source-http.js');
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error('No API key configured. Re-run `teamai init --http <url> --token <key>` or set TEAMAI_API_TOKEN.');
    }
    const baseUrl = localConfig.repo.url;
    if (!baseUrl) {
      throw new Error('HTTP team repo has no url configured.');
    }
    try {
      const version = await materializeHttpRepo(baseUrl, localConfig.repo.localPath, apiKey);
      return { label: `HTTP ${version ?? '(no version)'}`, version, reportingOnly: false };
    } catch (e) {
      if (e instanceof RepoNotAvailableError) {
        // Reporting-only endpoint: /repo not live yet. Skip skill/rule sync
        // quietly (status reporting still runs via its own hook handler).
        log.debug(`[pull] ${(e as Error).message} — skipping repo sync (reporting-only)`);
        return { label: 'HTTP (reporting-only, no /repo yet)', version: null, reportingOnly: true };
      }
      throw e;
    }
  }

  const result = await pullRepo(localConfig.repo.localPath);
  let version: string | null = null;
  try {
    version = await getHeadRev(localConfig.repo.localPath);
  } catch {
    // Can't resolve a rev → skip the incremental fast-path and do a full sync.
    log.debug('Rev check failed, proceeding with full sync');
    version = null;
  }
  return { label: result, version, reportingOnly: false };
}

async function buildRolePullContext(localConfig: LocalConfig): Promise<RolePullContext | null> {
  if (!localConfig.primaryRole) return null;

  let manifest;
  try {
    manifest = await loadRolesManifest(localConfig.repo.localPath);
  } catch {
    log.warn('Could not load roles manifest. Skipping role-based filtering.');
    return null;
  }

  let activeNamespaces;
  try {
    activeNamespaces = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    });
  } catch (e) {
    log.warn(`Role "${localConfig.primaryRole}" not found in manifest. Falling back to unfiltered sync.`);
    log.warn('Run `teamai roles set <role>` to pick a valid role.');
    return null;
  }

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

/**
 * Filter rules by the user's active knowledge namespaces.
 *
 * Rules whose name starts with a namespace path (e.g. "common/coding-style")
 * are filtered: only those in activeKnowledgeNamespaces pass through.
 * Root-level rules (no "/" in name) are always included.
 *
 * When knowledgeNamespaces is null (no role configured), all rules pass through.
 */
export function filterRulesByKnowledgeNamespaces(
  rules: ResourceItem[],
  knowledgeNamespaces: string[] | null,
): ResourceItem[] {
  if (!knowledgeNamespaces) return rules;

  return rules.filter((rule) => {
    const slashIndex = rule.name.indexOf('/');
    if (slashIndex === -1) return true; // root-level rule, always include
    const namespace = rule.name.slice(0, slashIndex);
    return knowledgeNamespaces.includes(namespace);
  });
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
    if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;
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

  // Step 1: refresh team repo (git pull, or HTTP /repo materialization)
  const pullSpin = spinner(`[${scopeLabel}] Pulling team repo...`).start();
  let currentRev: string | null = null;
  // Reporting-only HTTP endpoints have no team repo to write to, so the
  // team-repo-dependent built-in skill (teamai-share-learnings) is useless
  // there and must not be injected.
  let reportingOnly = false;
  try {
    const { label, version, reportingOnly: ro } = await refreshTeamRepo(localConfig);
    currentRev = version;
    reportingOnly = ro;
    pullSpin.succeed(`[${scopeLabel}] Team repo: ${label}`);
  } catch (e) {
    pullSpin.fail(`[${scopeLabel}] Pull failed: ${(e as Error).message}`);
    return;
  }

  // Step 1b: Skip sync if the repo version hasn't changed since last pull
  if (!options.force && !options.dryRun) {
    try {
      const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
      if (currentRev && state.lastPullRev && state.lastPullRev === currentRev) {
        log.success(`[${scopeLabel}] Already synced at ${currentRev}, skipping`);
        // 即使 repo 未变化，仍部署 CLI 内置资源（确保 CLI 升级后新版本 agent/rules 生效）
        if (!options.dryRun) {
          const cfg = await loadTeamConfig(localConfig.repo.localPath);
          if (cfg) {
            const skipRecall = !isRecallEnabled(localConfig, cfg);
            try { const { deployBuiltinAgents } = await import('./builtin-agents.js'); await deployBuiltinAgents(cfg, localConfig, { skipRecall }); } catch {}
            try { const { deployBuiltinRules } = await import('./builtin-rules.js'); await deployBuiltinRules(cfg, localConfig, { skipRecall }); } catch {}
            try { const { deployBuiltinSkills } = await import('./builtin-skills.js'); await deployBuiltinSkills(cfg, localConfig, { reportingOnly, skipRecall }); } catch {}
          }
        }
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
  const resourceTypes: ResourceType[] = ['skills', 'rules', 'docs', 'env', 'agents'];
  let totalSynced = 0;
  let desiredSkillNames: Set<string> | null = null;
  let knownRepoSkillNames: Set<string> | null = null;

  for (const type of resourceTypes) {
    const handler = getHandler(type);

    if (type === 'rules') {
      const rulesHandler = handler as RulesHandler;
      const allItems = await rulesHandler.scanTeamForPull(freshConfig, localConfig);
      // Filter by role knowledge namespaces first, then by tags
      const knowledgeNs = roleContext ? roleContext.activeNamespaces.knowledge : null;
      const roleFiltered = filterRulesByKnowledgeNamespaces(allItems, knowledgeNs);
      const { included: items, skipped } = filterByTags(roleFiltered, tagsConfig, subscribedTags, 'rules');
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

      // Tag channel: only augment when subscriptions are actually active
      const hasActiveTagSubscriptions = tagsConfig != null
        && subscribedTags != null
        && subscribedTags.length > 0;

      let tagIncluded: ResourceItem[] = [];
      if (hasActiveTagSubscriptions) {
        const tagResult = filterByTags(allTeamSkills, tagsConfig, subscribedTags, 'skills');
        tagIncluded = tagResult.included;
        skippedByTags = tagResult.skipped.length;
      }

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
    // Each entry maps a resource type to (a) the field on toolPath that names
    // the tool-side directory and (b) the filename suffix used for that
    // resource on disk (e.g. rules/wiki pages are files, skills are dirs).
    const tombstoneTypes: {
      type: ResourceType;
      ext?: string;
      toolPathField: 'rules' | 'skills' | 'agents';
    }[] = [
      { type: 'rules', ext: '.md', toolPathField: 'rules' },
      { type: 'skills', toolPathField: 'skills' },
      { type: 'agents', ext: '.md', toolPathField: 'agents' },
    ];

    const baseDir = resolveBaseDir(localConfig);
    for (const { type, ext, toolPathField } of tombstoneTypes) {
      const handler = getHandler(type);
      const tombstones = await handler.readTombstones(localConfig);
      if (tombstones.size === 0) continue;

      for (const [_tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        const dir = toolPath[toolPathField];
        if (!dir) continue;
        if (!await ResourceHandler.isToolInstalled(dir, baseDir)) continue;

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
      if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;
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
    if (currentRev !== null) {
      // HTTP mode: server version already resolved during refresh.
      state.lastPullRev = currentRev;
    } else {
      try {
        state.lastPullRev = await getHeadRev(localConfig.repo.localPath);
      } catch {
        // Non-critical: if we can't get the rev, just clear it
        state.lastPullRev = null;
      }
    }
    await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
  }

  // Step 3.5: Sync learnings and rebuild the multi-category search index
  // (Phase 1: covers learnings + docs + rules + skills). Both scopes supported.
  if (!options.dryRun) {
    try {
      const learningsRepoDir = path.join(localConfig.repo.localPath, 'learnings');
      const docsRepoDir = path.join(localConfig.repo.localPath, 'docs');
      const rulesRepoDir = path.join(localConfig.repo.localPath, 'rules');
      const skillsRepoDir = path.join(localConfig.repo.localPath, 'skills');
      const votesDir = path.join(localConfig.repo.localPath, 'votes');

      // user scope: sync learnings to ~/.teamai/learnings/ (legacy behavior)
      // project scope: use learnings directly from repo
      let learningsCount = 0;
      let effectiveLearningsDir: string | undefined;
      if (localConfig.scope === 'user') {
        if (await pathExists(learningsRepoDir)) {
          await fse.copy(learningsRepoDir, LEARNINGS_LOCAL_DIR, {
            overwrite: true,
            filter: (src: string) => !path.basename(src).startsWith('.'),
          });
          const allFiles = await listFiles(learningsRepoDir);
          learningsCount = allFiles.filter((f) => f.endsWith('.md')).length;
        }
        effectiveLearningsDir = await pathExists(LEARNINGS_LOCAL_DIR) ? LEARNINGS_LOCAL_DIR : undefined;
      } else {
        effectiveLearningsDir = await pathExists(learningsRepoDir) ? learningsRepoDir : undefined;
        if (effectiveLearningsDir) {
          const allFiles = await listFiles(learningsRepoDir);
          learningsCount = allFiles.filter((f) => f.endsWith('.md')).length;
        }
      }

      // teamwiki/ stays inside .teamai/team-repo/ — no copy to project root

      // Build the index when ANY of the four categories has content.
      const hasAnySource =
        effectiveLearningsDir ||
        await pathExists(docsRepoDir) ||
        await pathExists(rulesRepoDir) ||
        await pathExists(skillsRepoDir);

      // Resolve codebase directory (project cwd or team repo)
      const repoCodebaseDir = path.join(localConfig.repo.localPath, 'docs', 'team-codebase');
      const effectiveCodebaseDir = await pathExists(repoCodebaseDir) ? repoCodebaseDir : undefined;

      if (hasAnySource || effectiveCodebaseDir) {
        const votesExist = await pathExists(votesDir);
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        const indexPath = path.join(teamaiHome, 'search-index.json');
        const { buildIndex } = await import('./utils/search-index.js');
        const elapsed = await buildIndex({
          learningsDir: effectiveLearningsDir,
          docsDir: await pathExists(docsRepoDir) ? docsRepoDir : undefined,
          rulesDir: await pathExists(rulesRepoDir) ? rulesRepoDir : undefined,
          skillsDir: await pathExists(skillsRepoDir) ? skillsRepoDir : undefined,
          codebaseDir: undefined, // codebase now served by teamwiki/ graph engine
          votesDir: votesExist ? votesDir : undefined,
          indexPath,
        });
        if (learningsCount > 0) {
          log.success(`Synced ${learningsCount} learnings (index: ${elapsed}ms)`);
        } else {
          log.debug(`[${scopeLabel}] Built multi-category search index in ${elapsed}ms`);
        }
      }
    } catch (e) {
      log.debug(`Learnings/index sync skipped: ${(e as Error).message}`);
    }
  }

  // Step 3.5b: Sync domains.yaml from team repo to local .teamai/
  if (!options.dryRun) {
    try {
      const teamDomainsPath = path.join(localConfig.repo.localPath, '.teamai', 'domains.yaml');
      if (await pathExists(teamDomainsPath)) {
        const localDomainsDir = path.join(process.cwd(), '.teamai');
        await fse.ensureDir(localDomainsDir);
        await fse.copy(teamDomainsPath, path.join(localDomainsDir, 'domains.yaml'), { overwrite: true });
      }
    } catch { /* non-critical */ }
  }

  // Step 3.6: Inject team culture into CLAUDE.md
  if (!options.dryRun) {
    try {
      const culturePath = path.join(localConfig.repo.localPath, 'culture.md');
      if (await pathExists(culturePath)) {
        const cultureContent = await readFileSafe(culturePath);
        if (cultureContent) {
          const compiled = compileCulture(cultureContent);
          if (compiled) {
            const baseDir = resolveBaseDir(localConfig);
            for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
              if (!toolPath.claudemd) continue;
              if (toolPath.rules && !await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) continue;

              const claudeMdPath = path.join(baseDir, toolPath.claudemd);
              try {
                await injectClaudeMdSection(claudeMdPath, TEAMAI_CULTURE_START, TEAMAI_CULTURE_END, compiled);
                log.debug(`Injected culture into ${tool} CLAUDE.md`);
              } catch (e) {
                log.warn(`Failed to inject culture into ${tool} CLAUDE.md: ${(e as Error).message}`);
              }
            }
            log.success('Synced team culture');
          }
        }
      }
    } catch (e) {
      log.debug(`Culture sync skipped: ${(e as Error).message}`);
    }
  }

  // Step 3.7: Inject shared claudemd instructions into CLAUDE.md
  if (!options.dryRun) {
    try {
      const claudemdContents = await collectClaudemdFiles(
          localConfig.repo.localPath, roleContext);
      if (claudemdContents.length > 0) {
        const compiled = compileClaudemd(claudemdContents);
        if (compiled) {
          const baseDir = resolveBaseDir(localConfig);
          for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
            if (!toolPath.claudemd) continue;
            if (toolPath.rules && !await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) continue;
            const claudeMdPath = path.join(baseDir, toolPath.claudemd);
            try {
              await injectClaudeMdSection(claudeMdPath, TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END, compiled);
              log.debug(`Injected shared instructions into ${tool} CLAUDE.md`);
            } catch (e) {
              log.warn(`Failed to inject shared instructions into ${tool} CLAUDE.md: ${(e as Error).message}`);
            }
          }
          log.success(`[${scopeLabel}] Synced shared instructions (${claudemdContents.length} file(s))`);
        }
      }
    } catch (e) {
      log.debug(`Shared instructions sync skipped: ${(e as Error).message}`);
    }
  }

  // Step 3.8: Inject teamai-recall subagent rules block (Phase 1)
  //
  // Only injected for Tier-1 tools that have BOTH `agents` and `claudemd`
  // configured. Tools without subagent support (cursor / codex / openclaw /
  // workbuddy) are skipped — for them the recall flow runs purely via the
  // TodoWrite hint hook and the manual `teamai recall` command.
  if (!options.dryRun && isRecallEnabled(localConfig, freshConfig)) {
    try {
      const baseDir = resolveBaseDir(localConfig);
      const recallBlock = compileRecallRulesBlock();
      let injected = 0;
      for (const [tool, toolPath] of Object.entries(freshConfig.toolPaths)) {
        if (!toolPath.claudemd || !toolPath.agents) continue;
        if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir)) continue;

        const claudeMdPath = path.join(baseDir, toolPath.claudemd);
        try {
          await injectClaudeMdSection(
            claudeMdPath,
            TEAMAI_RECALL_RULES_START,
            TEAMAI_RECALL_RULES_END,
            recallBlock,
          );
          injected++;
          log.debug(`Injected recall rules into ${tool} CLAUDE.md`);
        } catch (e) {
          log.warn(`Failed to inject recall rules into ${tool} CLAUDE.md: ${(e as Error).message}`);
        }
      }
      if (injected > 0) {
        log.debug(`[${scopeLabel}] Injected recall rules into ${injected} tool(s) CLAUDE.md`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Recall rules injection skipped: ${(e as Error).message}`);
    }
  }

  // Step 4: Deploy CLI built-in skills
  if (!options.dryRun) {
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      const skipRecallForSkills = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinSkills(freshConfig, localConfig, { reportingOnly, skipRecall: skipRecallForSkills });
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
      const skipRecall = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinRules(freshConfig, localConfig, { skipRecall });
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed built-in rules to ${deployed} tool(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in rules deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 4.6: Deploy CLI built-in agents (e.g. teamai-recall subagent)
  if (!options.dryRun) {
    try {
      const { deployBuiltinAgents } = await import('./builtin-agents.js');
      const skipRecall = !isRecallEnabled(localConfig, freshConfig);
      const deployed = await deployBuiltinAgents(freshConfig, localConfig, { skipRecall });
      if (deployed > 0) {
        log.debug(`[${scopeLabel}] Deployed built-in agents to ${deployed} location(s)`);
      }
    } catch (e) {
      log.debug(`[${scopeLabel}] Built-in agents deployment skipped: ${(e as Error).message}`);
    }
  }

  // Step 5: Auto-report usage data — handled centrally in pull() to avoid
  // double-truncation when both user and project scopes share events.
  // (no-op here; see pull() for the unified reporting logic)

  // Step 6: Show skill recommendations
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

/**
/**
 * Compile culture.md frontmatter + body into a CLAUDE.md injection block.
 *
 * The culture.md file uses gray-matter frontmatter for structured data (company,
 * team) and markdown body for prose guidelines.
 *
 * Returns null if the culture.md cannot be parsed or has no useful content.
 */
export function compileCulture(raw: string): string | null {
    let parsed: { data: Record<string, unknown>; content: string };
    try {
        parsed = matter(raw);
    } catch {
        return null;
    }

    const fm = CultureFrontmatterSchema.safeParse(parsed.data);
    if (!fm.success) return null;

    const frontmatter: CultureFrontmatter = fm.data;
    const lines: string[] = [];

    // Company section
    if (frontmatter.company) {
        const c = frontmatter.company;
        lines.push(`## Company: ${c.name}`);
        if (c.mission) lines.push(`**Mission:** ${c.mission}`);
        if (c.vision) lines.push(`**Vision:** ${c.vision}`);
        if (c.values && c.values.length > 0) {
            lines.push(`**Values:** ${c.values.join(', ')}`);
        }
        lines.push('');
    }

    // Team section
    if (frontmatter.team) {
        const t = frontmatter.team;
        lines.push(`## Team: ${t.name}`);
        if (t.mission) lines.push(`**Mission:** ${t.mission}`);
        if (t.goals && t.goals.length > 0) {
            lines.push('**Goals:**');
            for (const g of t.goals) {
                lines.push(`- ${g}`);
            }
        }
        lines.push('');
    }

    // Body: include all prose content as-is
    const body = parsed.content.trim();
    if (body) {
        lines.push(body);
        lines.push('');
    }

    if (lines.length === 0) return null;

    const block = [
        TEAMAI_CULTURE_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Culture (teamai)',
        '',
        ...lines,
        TEAMAI_CULTURE_END,
    ].join('\n');

    return block;
}

/**
 * Merge one or more claudemd markdown files into a single CLAUDE.md injection block.
 *
 * Unlike compileCulture(), no frontmatter parsing — content is injected as-is.
 * Returns null if all contents are empty.
 */
export function compileClaudemd(contents: string[]): string | null {
    const parts = contents
        .map((c) => c.trim())
        .filter(Boolean);
    if (parts.length === 0) return null;

    return [
        TEAMAI_CLAUDEMD_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        parts.join('\n\n'),
        '',
        TEAMAI_CLAUDEMD_END,
    ].join('\n');
}

/**
 * Build the CLAUDE.md block that instructs the main conversation to:
 *   1. Invoke the `teamai-recall` subagent before starting any task that
 *      involves code changes / troubleshooting / design.
 *   2. Declare which doc_ids were actually consulted at task completion.
 *
 * Only injected for Tier-1 tools (those with both `agents` and `claudemd`
 * paths configured) — see pull.ts Step 3.8.
 */
export function compileRecallRulesBlock(): string {
    const lines = [
        TEAMAI_RECALL_RULES_START,
        '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
        '',
        '## Team Knowledge Recall (teamai)',
        '',
        '**Before** starting a task that involves code changes, debugging,',
        'or design decisions, you **SHOULD** invoke the `teamai-recall`',
        'subagent via the Agent tool with a concise natural-language',
        'description of the task — unless one of these skip conditions applies:',
        '',
        '1. **User already provided context** — the user referenced specific files,',
        '   gave a solution, or said "the answer is in this directory/file".',
        '2. **Local files have the answer** — the task info is directly available',
        '   from the current workspace (e.g. fixing an obvious bug in the current file).',
        '3. **Trivial/local change** — small modifications to known files (typo fix,',
        '   parameter tweak, formatting) that need no additional knowledge.',
        '',
        'The subagent will return a compact summary of relevant team knowledge',
        '(skills, learnings, docs, rules) without polluting this conversation',
        'with raw content.',
        '',
        '**Important constraints on agent sequencing (when recall is invoked):**',
        '1. Invoke `teamai-recall` subagent **first and alone** — never',
        '   launch it in parallel with Explore or other research agents.',
        '2. After recall returns results, use Read to get full content of the',
        '   returned files if you need more detail. Do NOT launch Explore agents',
        '   to search for the same topics — recall results + Read is the complete',
        '   workflow for accessing team knowledge.',
        '3. Explore/research agents have their own scope and must NOT overlap',
        '   with recall:',
        '   - **recall subagent covers:** team learnings, codebase docs, skills,',
        '     rules, and anything under `.teamai/`, `learnings/`, `docs/team-codebase/`.',
        '   - **Explore agents cover:** navigating source code in the current',
        '     working directory, and web search for external information.',
        '   - Explore agents must never search paths covered by recall.',
        '',
        '**After** completing the task, in your final reply you **MUST**',
        'declare which knowledge entries were actually referenced, using an',
        'HTML comment of the form:',
        '',
        '```',
        '<!-- teamai:referenced-doc-ids: [doc-id-1, doc-id-2] -->',
        '```',
        '',
        'If the recall returned no relevant hits, declare an empty list',
        '(`<!-- teamai:referenced-doc-ids: [] -->`). Do not skip the',
        'declaration — downstream tooling parses it to credit knowledge use.',
        '',
        TEAMAI_RECALL_RULES_END,
    ];
    return lines.join('\n');
}

/**
 * Collect claudemd .md files filtered by the user's active knowledge namespaces.
 *
 * Walks claudemd/<namespace>/*.md for each active namespace.
 * Falls back to collecting ALL namespace dirs when no role context is available.
 */
async function collectClaudemdFiles(
    repoPath: string,
    roleContext: RolePullContext | null,
): Promise<string[]> {
    const claudemdDir = path.join(repoPath, 'claudemd');
    if (!await pathExists(claudemdDir)) return [];

    // Determine which namespace dirs to scan
    let namespaceDirs: string[];
    if (roleContext) {
        namespaceDirs = roleContext.activeNamespaces.knowledge;
    } else {
        // No role configured → scan all subdirectories
        namespaceDirs = await listDirs(claudemdDir);
    }

    const contents: string[] = [];
    for (const ns of namespaceDirs) {
        const nsDir = path.join(claudemdDir, ns);
        if (!await pathExists(nsDir)) continue;
        const files = (await listFiles(nsDir))
            .filter((f) => f.endsWith('.md'))
            .sort();
        for (const file of files) {
            const content = await readFileSafe(path.join(nsDir, file));
            if (content) contents.push(content);
        }
    }

    return contents;
}

/**
 * Auto-migrate hooks from old individual format to unified hook-dispatch format.
 * Runs at session start: if settings.json doesn't contain 'hook-dispatch' commands,
 * it means the user updated the CLI but hooks are still in old format.
 * Reinjects with the current version's hook definitions.
 */
async function autoMigrateHooksIfNeeded(): Promise<void> {
  const home = process.env.HOME ?? '';
  // Quick check: read the primary settings file and see if it has hook-dispatch
  const primarySettings = path.join(home, '.claude', 'settings.json');
  if (!await pathExists(primarySettings)) return;

  const content = await readFileSafe(primarySettings);
  if (!content) return;

  // If hook-dispatch is already present, no migration needed
  if (content.includes('hook-dispatch')) return;

  // If no teamai hooks at all (user never ran init), skip
  if (!content.includes('teamai')) return;

  // Old format detected — reinject all tools
  log.debug('Auto-migrating hooks to dispatch format...');
  const { autoDetectInit } = await import('./config.js');
  const { injectHooksToAllTools } = await import('./hooks.js');
  const { localConfig, teamConfig } = await autoDetectInit();
  const baseDir = resolveBaseDir(localConfig);
  await injectHooksToAllTools(teamConfig.toolPaths, baseDir, localConfig.enabledAgents);
  log.debug('Hooks migrated to dispatch format');
}

/**
 * Main pull entry point.
 *
 * Scope isolation (issue #73): when a project-scope install is detected in cwd,
 * the user scope is **not** touched — pull and reconcile run for the project
 * scope only. When no project scope is present, the user scope is pulled as
 * before. Cross-team source skills are always pulled, against whichever scope
 * is active.
 */
export async function pull(options: GlobalOptions): Promise<void> {
  // 0. Auto-migrate hooks if settings.json has old format (pre-dispatch era).
  //    This runs on the first session start after a CLI update — the new binary
  //    detects the old individual hooks and reinjects the merged dispatch format.
  try {
    await autoMigrateHooksIfNeeded();
  } catch {
    // Non-fatal — pull continues even if hook migration fails
  }

  // 1. Detect project scope first. Its presence decides whether user scope is
  //    processed at all (issue #73: project install isolates from user).
  let projectConfig: LocalConfig | null = null;
  try {
    projectConfig = await detectProjectConfig();
  } catch (e) {
    log.warn(`Project-scope detection error: ${(e as Error).message}`);
  }
  const projectMode = projectConfig !== null;

  // 2. User scope — only when NOT in project mode.
  let userConfig: LocalConfig | null = null;
  if (projectMode) {
    log.info('project scope detected, skipped user scope');
  } else {
    try {
      userConfig = await loadLocalConfigForScope('user');
      if (userConfig) {
        await pullForScope(userConfig, options);
      } else {
        log.debug('No user-scope config found, skipping user pull');
      }
    } catch (e) {
      log.warn(`User-scope pull error: ${(e as Error).message}`);
    }
  }

  // 3. Project scope.
  if (projectConfig) {
    try {
      await pullForScope(projectConfig, options);
    } catch (e) {
      log.warn(`Project-scope pull error: ${(e as Error).message}`);
    }
  }

  // 3.5. Reconcile built-in + team hooks for the active scope only. Runs OUTSIDE
  // pullForScope so it bypasses the "Already synced" rev fast-path — this is
  // what self-heals new built-in hooks and applies hooks.yaml changes on every
  // session start. In project mode user is null, so user hooks are left alone.
  await reconcileHooksAllScopes(projectMode ? null : userConfig, projectConfig, options);

  // 4. Auto-report usage data to all active scopes. Events live in a single
  //    shared file (~/.teamai/usage.jsonl), so we report to each repo with
  //    skipTruncate=true first, then truncate once at the end.
  //    Scope filtering: project scope only gets sessions whose cwd is under
  //    projectRoot; user scope excludes those sessions.
  if (!options.dryRun) {
    try {
      const { reportUsageToTeam } = await import('./team-push.js');
      const { truncateUsageAfterReport, readUsageEvents } = await import('./usage-tracker.js');
      const targets: Array<{ repoPath: string; username: string; opts: { skipTruncate: true; projectRoot?: string; excludeProjectRoots?: string[] } }> = [];
      if (projectConfig) {
        targets.push({
          repoPath: projectConfig.repo.localPath,
          username: projectConfig.username,
          opts: { skipTruncate: true, projectRoot: projectConfig.projectRoot },
        });
      }
      if (userConfig && userConfig.repo.kind !== 'http') {
        targets.push({
          repoPath: userConfig.repo.localPath,
          username: userConfig.username,
          opts: { skipTruncate: true, excludeProjectRoots: projectConfig?.projectRoot ? [projectConfig.projectRoot] : [] },
        });
      }

      const eventCount = (await readUsageEvents()).length;
      for (const t of targets) {
        try {
          await reportUsageToTeam(t.repoPath, t.username, t.opts);
        } catch (e) {
          log.error(`Auto-report to ${t.repoPath} skipped: ${(e as Error).message}`);
        }
      }
      if (eventCount > 0 && targets.length > 0) {
        await truncateUsageAfterReport(eventCount);
      }
    } catch (e) {
      log.debug(`Auto-report skipped: ${(e as Error).message}`);
    }
  }

  // 5. Pull cross-team source skills (always — even in project mode), against
  //    the active scope so deploys land in the right base dir.
  const sourceConfig = projectConfig ?? userConfig;
  if (sourceConfig) {
    try {
      const { pullSources } = await import('./source.js');
      await pullSources(sourceConfig, options);
    } catch (e) {
      log.debug(`Source pull skipped: ${(e as Error).message}`);
    }
  }
}

/**
 * Reconcile built-in (A) + team (B) hooks across all active scopes. Bypasses the
 * rev fast-path so team hook changes and newly shipped built-in hooks apply even
 * when "Already synced, skipping" short-circuited pullForScope.
 */
async function reconcileHooksAllScopes(
  userConfig: LocalConfig | null,
  projectConfig: LocalConfig | null,
  options: GlobalOptions,
): Promise<void> {
  if (options.dryRun) return;
  const scopes = [userConfig, projectConfig].filter((c): c is LocalConfig => !!c);
  for (const localConfig of scopes) {
    try {
      const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
      if (!teamConfig) continue;
      const { reconcileTeamHooksForConfig } = await import('./hooks.js');
      const teamDefs = await reconcileTeamHooksForConfig(teamConfig, localConfig, {
        auto: true,
        silent: options.silent,
        filterAgents: localConfig.enabledAgents,
      });
      if (teamDefs.length > 0) {
        log.debug(`[${localConfig.scope}] Reconciled ${teamDefs.length} team hook(s)`);
      }
    } catch (e) {
      log.debug(`[${localConfig.scope}] Hook reconcile skipped: ${(e as Error).message}`);
    }
  }
}