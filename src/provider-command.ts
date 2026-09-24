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
  legacySingletonActive,
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
  // Validate the name here (not just deep in the store) so an invalid name is a
  // clean error + exit, never an uncaught stack trace.
  try {
    assertValidProviderName(opts.name);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

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

  // Single-provider gate (issue #404, phase 2). Running two HTTP providers
  // concurrently is unsafe until the ownership ledger (phase 4) arbitrates
  // same-name resources across providers — otherwise one provider's uninstall
  // deletes files another provider installed, and serial hook sync can exceed
  // the foreground budget. Until then, allow exactly one HTTP provider (plus
  // the legacy singleton, which double-track dispatch already handles).
  const existing = await listHttpProviderConfigs();
  if (existing.length > 0) {
    log.error(
      `An HTTP provider ("${existing[0].name}") is already configured. Multiple HTTP `
      + 'providers need cross-provider ownership arbitration (issue #404 phase 4) and '
      + 'are not supported yet. Remove the existing one with `teamai provider remove '
      + `${existing[0].name}\` first.`,
    );
    process.exit(1);
  }
  if (await legacySingletonActive()) {
    log.error(
      'A legacy HTTP local agent is already configured. Migrate it with '
      + '`teamai provider migrate-legacy --name <name>` instead of adding a second '
      + 'HTTP provider (multiple providers need issue #404 phase 4).',
    );
    process.exit(1);
  }

  const priority = parsePriority(opts.priority);
  const config: HttpProviderConfig = {
    name: opts.name,
    adapter,
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    priority,
  };

  // Initialize the backend BEFORE publishing the registry record, so a failed
  // init (bad token, unwritable dir, hook injection failure) never leaves a
  // registered-but-broken provider that later hook dispatches keep loading.
  // Publish the registry record only after init succeeds; on any failure run a
  // FULL teardown so nothing init already did — including the hooks it injected
  // into the tools' settings — is left behind, then start clean on retry.
  const backend = getHttpAdapter(adapter);
  try {
    if (backend.initialize) {
      await backend.initialize(config, opts.token);
    }
    await upsertHttpProviderConfig(config);
  } catch (e) {
    try {
      await backend.teardown(config);
    } catch (teardownErr) {
      log.warn(`Rollback teardown for "${config.name}" hit an error: ${(teardownErr as Error).message}`);
    }
    await removeHttpProviderState(config.name);
    await removeHttpProviderConfig(config.name);
    log.error(`Failed to add provider "${config.name}": ${(e as Error).message}`);
    process.exit(1);
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

/** `teamai provider sync` */
export async function providerSync(): Promise<void> {
  const configs = await listHttpProviderConfigs();
  if (configs.length === 0) {
    log.info('No HTTP providers configured.');
    return;
  }
  const providers = configs.map(createHttpResourceProvider);
  const results = await syncResourceProviders(providers, { trigger: 'manual' });
  for (const r of results) {
    if (r.ok) log.success(`  ${r.provider}: ok${r.changed ? ' (changed)' : ''}`);
    else log.error(`  ${r.provider}: ${r.message ?? 'failed'}`);
  }
  // Exit non-zero if any provider failed, so scripts/CI can detect it.
  if (results.some((r) => !r.ok)) process.exit(1);
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
  try {
    assertValidProviderName(opts.name);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }
  // Single-provider gate (issue #404 phase 2): migrating a legacy singleton
  // while a named provider already exists would leave two named HTTP providers,
  // bypassing the one-provider limit. Refuse until phase 4's arbitration lands.
  const existing = await listHttpProviderConfigs();
  if (existing.length > 0) {
    log.error(
      `A named HTTP provider ("${existing[0].name}") already exists; migrating the legacy `
      + 'singleton would create a second one, which is not supported yet (issue #404 phase 4).',
    );
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
