// ─── `teamai provider` commands ──────────────────────────
//
// Manage named HTTP resource providers (issue #404, phase 2). Git provider
// management (`provider add git`, `set-primary`) and cross-provider write-target
// selection belong to a later phase and are intentionally not exposed here.

import { log } from './utils/logger.js';
import {
  listHttpProviderConfigs,
  getHttpProviderConfig,
  upsertHttpProviderConfig,
  removeHttpProviderConfig,
  removeHttpProviderState,
  migrateLegacyHttpProvider,
  assertValidProviderName,
} from './providers/http/store.js';
import {
  availableHttpAdapters,
  getHttpAdapter,
  createHttpResourceProvider,
} from './providers/http/registry.js';
import { syncResourceProviders } from './providers/resource-registry.js';
import type { HttpProviderConfig } from './providers/types.js';

interface AddHttpOptions {
  name: string;
  adapter?: string;
  token?: string;
  priority?: string;
}

/** `teamai provider add http <endpoint> --name --adapter --token --priority` */
export async function providerAddHttp(endpoint: string, opts: AddHttpOptions): Promise<void> {
  if (!opts.name) {
    log.error('A provider name is required: --name <name>');
    process.exit(1);
  }
  assertValidProviderName(opts.name);

  const adapter = opts.adapter ?? 'clawpro';
  // Fail early on an unknown adapter rather than after persisting config.
  if (!availableHttpAdapters().includes(adapter)) {
    log.error(`Unknown HTTP adapter "${adapter}". Available: ${availableHttpAdapters().join(', ')}`);
    process.exit(1);
  }

  if (await getHttpProviderConfig(opts.name)) {
    log.error(`Provider "${opts.name}" already exists. Remove it first or choose another name.`);
    process.exit(1);
  }

  const priority = parsePriority(opts.priority);
  const config: HttpProviderConfig = {
    name: opts.name,
    adapter,
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    priority,
  };

  await upsertHttpProviderConfig(config);
  // initialize is optional on the adapter interface; call it when present so the
  // credential and initial state land in the provider's isolated home.
  const backend = getHttpAdapter(adapter);
  if (backend.initialize) {
    await backend.initialize(config, opts.token);
  }

  log.success(`Added HTTP provider "${config.name}" (${config.adapter}) → ${config.endpoint}`);
}

/** `teamai provider list` */
export async function providerList(): Promise<void> {
  const configs = await listHttpProviderConfigs();
  if (configs.length === 0) {
    log.info('No HTTP providers configured. Add one with `teamai provider add http <endpoint> --name <name>`.');
    return;
  }
  log.info('HTTP providers:');
  for (const c of [...configs].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))) {
    log.info(`  ${c.name}  [${c.adapter}]  priority=${c.priority}`);
    log.info(`    ${c.endpoint}`);
  }
}

/** `teamai provider sync [--force]` */
export async function providerSync(opts: { force?: boolean }): Promise<void> {
  const configs = await listHttpProviderConfigs();
  if (configs.length === 0) {
    log.info('No HTTP providers configured.');
    return;
  }
  const providers = configs.map(createHttpResourceProvider);
  const results = await syncResourceProviders(providers, { trigger: 'manual', force: opts.force });
  for (const r of results) {
    if (r.ok) log.success(`  ${r.provider}: ok${r.changed ? ' (changed)' : ''}`);
    else log.error(`  ${r.provider}: ${r.message ?? 'failed'}`);
  }
}

/** `teamai provider remove <name>` */
export async function providerRemove(name: string): Promise<void> {
  const config = await getHttpProviderConfig(name);
  if (!config) {
    log.error(`No HTTP provider named "${name}".`);
    process.exit(1);
  }
  // Tear down the provider's resources first, then drop its config and state so
  // a failed teardown does not orphan installed resources.
  const provider = createHttpResourceProvider(config);
  await provider.teardown();
  await removeHttpProviderConfig(name);
  await removeHttpProviderState(name);
  log.success(`Removed HTTP provider "${name}".`);
}

interface MigrateLegacyOptions {
  name: string;
  priority?: string;
}

/** `teamai provider migrate-legacy --name --priority` */
export async function providerMigrateLegacy(opts: MigrateLegacyOptions): Promise<void> {
  if (!opts.name) {
    log.error('A provider name is required: --name <name>');
    process.exit(1);
  }
  const config = await migrateLegacyHttpProvider({
    name: opts.name,
    priority: parsePriority(opts.priority),
  });
  if (!config) {
    log.info('No legacy HTTP local agent to migrate (or it was already migrated).');
    return;
  }
  log.success(
    `Migrated legacy HTTP local agent to provider "${config.name}" ` +
      `(the old ~/.teamai/local-agent/ is kept as a rollback snapshot).`,
  );
}

/** Parse a --priority value, defaulting to 50 and rejecting non-integers. */
function parsePriority(raw?: string): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    log.error(`--priority must be an integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
}

/** Adapter names this build supports, for CLI help. */
export function providerAdapters(): string[] {
  return availableHttpAdapters();
}
