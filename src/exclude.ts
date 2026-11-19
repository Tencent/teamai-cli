import {
  detectProjectConfig,
  loadStateForScope,
  requireInit,
  saveLocalConfig,
  saveLocalConfigForScope,
  saveStateForScope,
} from './config.js';
import path from 'node:path';
import { log } from '@teamai/shared/log';
import { listFilesRecursive, readFileSafe } from './utils/fs.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import type { GlobalOptions, LocalConfig } from './types.js';

async function resolveExcludeScope(options: GlobalOptions = {}): Promise<LocalConfig> {
  const projectConfig = await detectProjectConfig(undefined, undefined, options);

  return projectConfig ?? (await requireInit(options)).localConfig;
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
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // Missing/corrupt state is non-critical: the next pull performs a full sync.
  }
}

export async function excludeList(_options: GlobalOptions): Promise<void> {
  // Read-only: the load never persists a migration (#893).
  const config = await resolveExcludeScope({ dryRun: true });
  const excludedSkills = config.excludedSkills ?? [];

  if (excludedSkills.length === 0) {
    log.info('Nothing is excluded. (pull syncs all role skills)');

    return;
  }

  log.info(`Excluded (${excludedSkills.length}):`);

  for (const skill of excludedSkills) log.dim(`  ${skill}`);
}

/**
 * The skills and MCP servers this team repo declares, by name, across the flat and namespaced layouts: an exclusion of a
 * name none of them has matches nothing, so it is worth a warning rather than a silent no-op.
 */
async function teamResourceNames(repoPath: string): Promise<Set<string>> {
  const names = new Set<string>();
  const skills = await listFilesRecursive(path.join(repoPath, 'skills'));

  for (const file of skills) {
    const base = path.basename(file);

    if (base === 'SKILL.md') names.add(path.basename(path.dirname(file)));
    else if (base.endsWith('.md')) names.add(base.slice(0, -'.md'.length));
  }

  const mcp = await listFilesRecursive(path.join(repoPath, 'mcp'));

  for (const file of mcp) {
    if (path.extname(file) !== '.yaml' && path.extname(file) !== '.yml') continue;

    const content = await readFileSafe(path.join(repoPath, 'mcp', file));

    for (const server of content ? parseTeamMcpServers(content) ?? [] : []) names.add(server.name);
  }

  return names;
}

export async function excludeAdd(skills: string[], options: GlobalOptions): Promise<void> {
  const config = await resolveExcludeScope(options);
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

  const known = await teamResourceNames(config.repo.localPath);
  const unknown = added.filter((skill) => !known.has(skill));

  if (known.size > 0 && unknown.length > 0) {
    log.warn(`No team skill or MCP server named ${unknown.map((skill) => `"${skill}"`).join(', ')} is in this team repo; the exclusion applies if one is added later.`);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would exclude: ${added.join(', ')}`);

    return;
  }

  await saveExcludeScopeConfig({ ...config, excludedSkills: [...existing].sort() });
  log.success(`Excluded: ${added.join(', ')}`);
  log.dim('Run `teamai pull` to remove them from local AI tools.');
}

export async function excludeRemove(skills: string[], options: GlobalOptions): Promise<void> {
  const config = await resolveExcludeScope(options);
  const existing = new Set(config.excludedSkills ?? []);
  const removed = skills.filter((skill) => existing.delete(skill));

  if (removed.length === 0) {
    log.info('None of those were excluded.');

    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove from exclude list: ${removed.join(', ')}`);

    return;
  }

  await saveExcludeScopeConfig({
    ...config,
    excludedSkills: existing.size > 0 ? [...existing].sort() : undefined,
  });
  log.success(`Removed from exclude list: ${removed.join(', ')}`);
  log.dim('Run `teamai pull` to sync them again.');
}
