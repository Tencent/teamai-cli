// ─── `teamai provider` commands ──────────────────────────
//
// Manage named HTTP resource providers (issue #404, phase 2). Git provider
// management (`provider add git`, `set-primary`) and cross-provider write-target
// selection belong to a later phase and are intentionally not exposed here.

import path from 'node:path';
import { log } from './utils/logger.js';
import { getUserHome } from './utils/home.js';
import {
  listHttpProviderConfigs,
  getHttpProviderConfig,
  readHttpProviderHomeConfig,
  upsertHttpProviderConfig,
  writeHttpProviderHomeConfig,
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

/**
 * Run `fn` while holding the machine-level provider lock, so the single-provider
 * check-and-write in `provider add` and `migrate-legacy` cannot interleave and
 * both pass the empty/one-provider gate (review #6/P3). Callers still enforce
 * the gate; the lock only makes the check-then-act atomic across processes.
 */
async function withProviderLock<T>(fn: () => Promise<T>): Promise<T> {
  const { acquireLock, releaseLock } = await import('./update.js');
  const lockPath = path.join(getUserHome(), '.teamai', 'providers', '.add.lock');
  if (!(await acquireLock(lockPath))) {
    log.error('Another `teamai provider` operation is in progress. Try again in a moment.');
    process.exit(1);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

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

  const priority = parsePriority(opts.priority);
  const config: HttpProviderConfig = {
    name: opts.name,
    adapter,
    endpoint: endpoint.trim().replace(/\/+$/, ''),
    priority,
  };

  // Serialize the whole check-and-write under a machine-level lock so two
  // concurrent `provider add` / `migrate-legacy` runs cannot both see an empty
  // registry and each create a provider (the single-provider gate below is
  // otherwise a racy check-then-act). The lock also covers init + publish so a
  // rollback cannot interleave with another add.
  await withProviderLock(async () => {
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
      // Roll back what init wrote. Only delete the provider state when teardown
      // fully succeeded — if teardown could not remove everything (e.g. an
      // injected hook is locked), KEEP the state + manifest so the leftover can
      // be cleaned up on a retry rather than orphaned with its ownership record
      // destroyed (issue #404, review #5). teardown throws on partial failure.
      let teardownOk = true;
      try {
        await backend.teardown(config);
      } catch (teardownErr) {
        teardownOk = false;
        log.warn(`Rollback teardown for "${config.name}" hit an error: ${(teardownErr as Error).message}`);
      }
      if (teardownOk) {
        await removeHttpProviderState(config.name);
        await removeHttpProviderConfig(config.name);
      } else {
        // Drop the registry entry so hook dispatch won't load a broken provider,
        // but keep the state home for a retriable `provider remove`. Persist the
        // self-describing provider.json into the home so `provider remove` can
        // recover this config even without a registry entry (review #3) — init
        // may have failed before upsert wrote it.
        await removeHttpProviderConfig(config.name);
        await writeHttpProviderHomeConfig(config);
        log.warn(
          `Kept partial state for "${config.name}" (teardown incomplete); `
          + `run \`teamai provider remove ${config.name}\` after resolving the issue.`,
        );
      }
      log.error(`Failed to add provider "${config.name}": ${(e as Error).message}`);
      process.exit(1);
    }
  });

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
  let config = await getHttpProviderConfig(name);
  if (!config) {
    // No registry entry — but a failed `provider add` (or an interrupted one)
    // may have left a state home whose registry record was dropped so hook
    // dispatch would not load a broken provider. Recover that provider's config
    // from its own home so this command can still finish the cleanup (the retry
    // path review #3 asks for). Only error out when there is truly nothing.
    config = await readHttpProviderHomeConfig(name);
    if (!config) {
      log.error(`No HTTP provider named "${name}".`);
      process.exit(1);
    }
  }
  // Tear down the provider's resources first, then drop its config and state so
  // a failed teardown does not orphan installed resources. teardown throws when
  // it could not fully clean up, leaving the home for another retry.
  const provider = createHttpResourceProvider(config);
  try {
    await provider.teardown();
  } catch (e) {
    // Drop the registry entry (if any) so dispatch won't keep loading it, but
    // keep the state home so cleanup can be retried once the issue is resolved.
    await removeHttpProviderConfig(name);
    log.error(
      `Could not fully remove provider "${name}": ${(e as Error).message} `
      + 'Kept its state for a retry — re-run `teamai provider remove '
      + `${name}\` after resolving the issue.`,
    );
    process.exit(1);
  }
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
  // Hold the same lock as `provider add` so the gate below and the migration
  // cannot interleave with a concurrent add/migrate (review P3).
  const config = await withProviderLock(async () => {
    // Single-provider gate (issue #404 phase 2): a legacy migration must not
    // create a SECOND provider alongside an existing one. Only a provider with a
    // DIFFERENT name is a foreign second provider — an entry under this same
    // target name is either an already-finished migration (idempotent re-run) or
    // one interrupted after the registry write but before the marker, both of
    // which the store function resolves. Gating on "any entry" here would break
    // that idempotency/resume (a re-run would error instead of no-op), so only
    // reject a differently-named provider.
    const foreign = (await listHttpProviderConfigs()).filter((p) => p.name !== opts.name);
    if (foreign.length > 0) {
      log.error(
        `A named HTTP provider ("${foreign[0].name}") already exists; migrating the legacy `
        + 'singleton would create a second one, which is not supported yet (issue #404 phase 4).',
      );
      process.exit(1);
    }
    return migrateLegacyHttpProvider({
      name: opts.name,
      priority: parsePriority(opts.priority),
    });
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
