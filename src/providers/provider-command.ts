import { loadLocalConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { GlobalOptions, SourceConfig } from '../types.js';
import { loadTeamConfig } from '../config.js';
import { sourceAdd, sourceRemove } from '../source.js';
import { createHttpResourceProvider, loadHttpResourceProviders } from './http/registry.js';
import {
  addHttpProvider,
  getPrimaryProvider,
  listHttpProviderConfigs,
  removeHttpProviderConfig,
  setPrimaryProvider,
  migrateLegacyHttpProvider,
} from './http/store.js';
import { syncResourceProviders } from './resource-registry.js';

export async function providerAddHttp(
  endpoint: string,
  options: GlobalOptions & { name: string; adapter?: string; token?: string; priority?: string },
): Promise<void> {
  const adapter = options.adapter ?? 'clawpro';
  const priority = Number.parseInt(options.priority ?? '50', 10);
  if (!Number.isFinite(priority)) throw new Error('Provider priority must be an integer.');
  if (options.dryRun) {
    log.info(`[dry-run] Would add HTTP provider "${options.name}" (${adapter}) at ${endpoint}`);
    return;
  }
  // Resolve the adapter before persisting anything so an invalid adapter leaves
  // no half-created provider directory behind.
  const candidate = {
    name: options.name,
    type: 'http' as const,
    adapter,
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    priority,
  };
  createHttpResourceProvider(candidate);
  const config = await addHttpProvider({ name: options.name, adapter, endpoint, priority }, options.token);
  const provider = createHttpResourceProvider(config);
  try {
    await provider.adapter.initialize?.(config, options.token);
  } catch (error) {
    await removeHttpProviderConfig(config.name);
    throw error;
  }
  log.success(`HTTP provider "${config.name}" added (${config.adapter}, priority ${config.priority}).`);
}

export async function providerAddGit(
  repo: string,
  options: GlobalOptions & { name: string; priority?: string },
): Promise<void> {
  const priority = Number.parseInt(options.priority ?? '50', 10);
  if (!Number.isFinite(priority)) throw new Error('Provider priority must be an integer.');
  await sourceAdd(repo, { ...options, name: options.name, priority });
  log.info('Git providers are stored in teamai.yaml sources and shared with the team.');
}

async function gitSources(): Promise<SourceConfig[]> {
  const local = await loadLocalConfig();
  if (!local || local.repo.kind === 'http') return [];
  return (await loadTeamConfig(local.repo.localPath))?.sources ?? [];
}

async function hasWritableMain(): Promise<boolean> {
  const local = await loadLocalConfig();
  return !!local && local.repo.kind !== 'http';
}

export async function providerList(): Promise<void> {
  const [http, git, primary, writableMain] = await Promise.all([
    listHttpProviderConfigs(),
    gitSources(),
    getPrimaryProvider(),
    hasWritableMain(),
  ]);
  if (http.length === 0 && git.length === 0 && !writableMain) {
    log.info('No additional resource providers configured.');
    return;
  }
  if (writableMain) {
    log.info(`main  git  writable${primary === 'main' ? '  (primary)' : ''}`);
  }
  for (const source of git) {
    log.info(`${source.name}  git  priority=${source.priority ?? 50}${primary === source.name ? '  (primary)' : ''}`);
    log.dim(`  ${source.repo}`);
  }
  for (const config of http) {
    log.info(`${config.name}  http/${config.adapter}  priority=${config.priority}${primary === config.name ? '  (primary)' : ''}`);
    log.dim(`  ${config.endpoint}`);
  }
}

export async function providerSync(options: GlobalOptions): Promise<void> {
  const providers = await loadHttpResourceProviders();
  const results = await syncResourceProviders(providers, { cwd: process.cwd(), trigger: 'manual', force: options.force });
  for (const result of results) {
    if (result.ok) log.success(`[provider:${result.provider}] ${result.message ?? 'synced'}`);
    else log.warn(`[provider:${result.provider}] ${result.message ?? 'sync failed'}`);
  }
  // Main and subscribed Git providers reuse pull's mature clone/deploy path.
  const local = await loadLocalConfig();
  if (local && local.repo.kind !== 'http') {
    const { pull } = await import('../pull.js');
    await pull(options);
  }
}

export async function providerRemove(name: string, options: GlobalOptions): Promise<void> {
  const httpConfig = (await listHttpProviderConfigs()).find((item) => item.name === name);
  if (httpConfig) {
    if (options.dryRun) {
      log.info(`[dry-run] Would remove provider "${name}"`);
      return;
    }
    await createHttpResourceProvider(httpConfig).teardown();
    await removeHttpProviderConfig(name);
    log.success(`Provider "${name}" removed.`);
    return;
  }
  await sourceRemove(name, options);
}

export async function providerSetPrimary(name: string, options: GlobalOptions): Promise<void> {
  const names = new Set([
    ...((await hasWritableMain()) ? ['main'] : []),
    ...(await gitSources()).map((item) => item.name),
    ...(await listHttpProviderConfigs()).map((item) => item.name),
  ]);
  if (!names.has(name)) throw new Error(`Resource provider "${name}" was not found.`);
  if (options.dryRun) {
    log.info(`[dry-run] Would set primary provider to "${name}"`);
    return;
  }
  await setPrimaryProvider(name);
  log.success(`Primary provider set to "${name}".`);
}

export async function providerMigrateLegacy(
  options: GlobalOptions & { name?: string; priority?: string },
): Promise<void> {
  const name = options.name ?? 'clawpro';
  const priority = Number.parseInt(options.priority ?? '50', 10);
  if (!Number.isFinite(priority)) throw new Error('Provider priority must be an integer.');
  if (options.dryRun) {
    log.info(`[dry-run] Would migrate the legacy HTTP source to provider "${name}".`);
    return;
  }
  await migrateLegacyHttpProvider(name, priority);
  log.success(`Legacy HTTP source migrated to provider "${name}"; the old directory is retained as a rollback snapshot.`);
}
