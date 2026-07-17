import {
  detectProjectConfig,
  loadStateForScope,
  requireInit,
  saveLocalConfig,
  saveLocalConfigForScope,
  saveStateForScope,
} from './config.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig } from './types.js';

async function resolveExcludeScope(): Promise<LocalConfig> {
  const projectConfig = await detectProjectConfig();
  return projectConfig ?? (await requireInit()).localConfig;
}

async function saveExcludeScopeConfig(localConfig: LocalConfig): Promise<void> {
  if (localConfig.scope === 'project') {
    await saveLocalConfigForScope(localConfig, 'project', localConfig.projectRoot);
  } else {
    await saveLocalConfig(localConfig);
  }

  // A changed exclude list must bypass pull's unchanged-revision fast path so
  // excluded skills are removed, or newly included skills are restored.
  try {
    const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
  } catch {
    // Missing/corrupt state is non-critical: the next pull performs a full sync.
  }
}

export async function excludeList(_options: GlobalOptions): Promise<void> {
  const config = await resolveExcludeScope();
  const excludedSkills = config.excludedSkills ?? [];
  if (excludedSkills.length === 0) {
    log.info('No excluded skills. (pull syncs all role skills)');
    return;
  }

  log.info(`Excluded skills (${excludedSkills.length}):`);
  for (const skill of excludedSkills) log.dim(`  ${skill}`);
}

export async function excludeAdd(skills: string[], _options: GlobalOptions): Promise<void> {
  const config = await resolveExcludeScope();
  const existing = new Set(config.excludedSkills ?? []);
  const added = skills.filter((skill) => {
    if (existing.has(skill)) return false;
    existing.add(skill);
    return true;
  });

  if (added.length === 0) {
    log.info('Already excluded.');
    return;
  }

  await saveExcludeScopeConfig({ ...config, excludedSkills: [...existing].sort() });
  log.success(`Excluded: ${added.join(', ')}`);
  log.dim('Run `teamai pull` to remove them from local AI tools.');
}

export async function excludeRemove(skills: string[], _options: GlobalOptions): Promise<void> {
  const config = await resolveExcludeScope();
  const existing = new Set(config.excludedSkills ?? []);
  const removed = skills.filter((skill) => existing.delete(skill));

  if (removed.length === 0) {
    log.info('None of those skills were excluded.');
    return;
  }

  await saveExcludeScopeConfig({
    ...config,
    excludedSkills: existing.size > 0 ? [...existing].sort() : undefined,
  });
  log.success(`Removed from exclude list: ${removed.join(', ')}`);
  log.dim('Run `teamai pull` to sync them again.');
}
