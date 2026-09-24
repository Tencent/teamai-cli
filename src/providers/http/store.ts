// ─── HTTP provider store ─────────────────────────────────
//
// On-disk layout for named HTTP providers (issue #404). Each provider's state
// is isolated so credentials, manifests, bindings, plugin state and caches of
// one backend never touch another's:
//
//   ~/.teamai/providers/http/<name>/          state home (config.json, manifest, …)
//   ~/.teamai/credentials/<name>              credential (0600), outside config
//   ~/.teamai/providers/settings.json         registry (which providers exist)
//
// The legacy single HTTP backend at ~/.teamai/local-agent/ keeps working
// untouched; `migrateLegacyHttpProvider` promotes it to a named provider with
// an atomic copy + rollback snapshot, and leaves a marker so the old singleton
// stops claiming the backend.

import path from 'node:path';
import fse from 'fs-extra';
import { getUserHome } from '../../utils/home.js';
import {
  ensureDir,
  pathExists,
  readJson,
  remove,
  writeJsonAtomic,
} from '../../utils/fs.js';
import { readFileSafe } from '../../utils/fs.js';
import { writeTokenFile } from './adapters/clawpro/client.js';
import type { HttpProviderExecutionContext } from './adapters/clawpro/client.js';
import type { HttpProviderConfig } from '../types.js';

const PROVIDERS_DIR = 'providers';
const HTTP_DIR = 'http';
const CREDENTIALS_DIR = 'credentials';
const REGISTRY_FILE = 'settings.json';
const PROVIDER_CONFIG_FILE = 'provider.json';
const LEGACY_DIR = 'local-agent';

function teamaiHome(): string {
  return path.join(getUserHome(), '.teamai');
}

function httpProvidersRoot(): string {
  return path.join(teamaiHome(), PROVIDERS_DIR, HTTP_DIR);
}

/** State home for one named HTTP provider. */
export function httpProviderHome(name: string): string {
  return path.join(httpProvidersRoot(), name);
}

/** Credential-file path for one named HTTP provider (0600, outside config). */
export function httpProviderCredentialPath(name: string): string {
  return path.join(teamaiHome(), CREDENTIALS_DIR, name);
}

/** Build the execution context a named provider run needs (see withHttpProvider). */
export function httpProviderExecutionContext(name: string): HttpProviderExecutionContext {
  return {
    name,
    home: httpProviderHome(name),
    credentialPath: httpProviderCredentialPath(name),
  };
}

function registryPath(): string {
  return path.join(teamaiHome(), PROVIDERS_DIR, REGISTRY_FILE);
}

interface ProviderRegistryFile {
  http?: HttpProviderConfig[];
}

/**
 * Windows reserved device names (case-insensitive). Windows forbids these both
 * bare and with any extension (`CON`, `CON.txt`, `LPT1.foo` all resolve to the
 * device), so match an optional `.<ext>` suffix too.
 */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * A provider name becomes a single path segment for its state dir and
 * credential file, so it must be safe on every platform. Beyond the character
 * set, reject anything that could collide with another name on a
 * case-insensitive filesystem (`Foo` vs `foo`), a name ending in `.` or a
 * space (Windows strips them, so `name.` and `name` would share a path), and
 * Windows reserved device names (`CON`, `COM1`, …).
 */
export function assertValidProviderName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid provider name "${name}". Use letters, digits, '.', '_' or '-', starting alphanumeric.`,
    );
  }
  if (name.endsWith('.')) {
    throw new Error(`Invalid provider name "${name}": must not end with '.'.`);
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    throw new Error(`Invalid provider name "${name}": reserved device name.`);
  }
}

/**
 * Reject a name that collides with an existing provider on a case-insensitive
 * filesystem (`Foo` when `foo` exists). Same-name replacement is allowed (that
 * is an intentional upsert), so only a *different* name with the same lowercase
 * form is a conflict. Call before writing a NEW provider.
 */
async function assertNameNotCaseColliding(name: string): Promise<void> {
  const lower = name.toLowerCase();
  const clash = (await listHttpProviderConfigs()).find(
    (p) => p.name !== name && p.name.toLowerCase() === lower,
  );
  if (clash) {
    throw new Error(
      `Provider name "${name}" collides with existing "${clash.name}" on a `
      + 'case-insensitive filesystem. Choose a distinct name.',
    );
  }
}

/** Read the registry of configured HTTP providers (empty when none). */
export async function listHttpProviderConfigs(): Promise<HttpProviderConfig[]> {
  const file = await readJson<ProviderRegistryFile>(registryPath());
  return file?.http ?? [];
}

/** Look up one HTTP provider's config by name. */
export async function getHttpProviderConfig(name: string): Promise<HttpProviderConfig | undefined> {
  return (await listHttpProviderConfigs()).find((p) => p.name === name);
}

/**
 * Read a provider's self-describing config from its own state home
 * (`~/.teamai/providers/http/<name>/provider.json`), independent of the
 * registry. Used to recover a provider whose registry entry was dropped after a
 * failed add/remove so `provider remove` can still find and finish its cleanup
 * (issue #404, review #3). Returns undefined when the home has no config.
 */
export async function readHttpProviderHomeConfig(name: string): Promise<HttpProviderConfig | undefined> {
  try {
    assertValidProviderName(name);
  } catch {
    return undefined;
  }
  const cfg = await readJson<HttpProviderConfig>(
    path.join(httpProviderHome(name), PROVIDER_CONFIG_FILE),
  );
  return cfg?.name ? cfg : undefined;
}

/**
 * Persist a provider's self-describing config into its own state home WITHOUT
 * touching the registry. Used by a failed `provider add` that keeps partial
 * state for a retriable `provider remove`, so the recovery read above can find
 * the config even though the registry entry was dropped (issue #404, review #3).
 */
export async function writeHttpProviderHomeConfig(config: HttpProviderConfig): Promise<void> {
  assertValidProviderName(config.name);
  await ensureDir(httpProviderHome(config.name));
  await writeJsonAtomic(path.join(httpProviderHome(config.name), PROVIDER_CONFIG_FILE), config);
}

/** Add or replace an HTTP provider in the registry, persisting its config. */
export async function upsertHttpProviderConfig(config: HttpProviderConfig): Promise<void> {
  assertValidProviderName(config.name);
  await assertNameNotCaseColliding(config.name);
  const existing = await listHttpProviderConfigs();
  const next = existing.filter((p) => p.name !== config.name);
  next.push(config);
  next.sort((a, b) => a.name.localeCompare(b.name));
  await ensureDir(path.dirname(registryPath()));
  await writeJsonAtomic(registryPath(), { http: next });

  // Also persist the per-provider config into its own home, so the state
  // directory is self-describing and survives a registry rebuild.
  await ensureDir(httpProviderHome(config.name));
  await writeJsonAtomic(path.join(httpProviderHome(config.name), PROVIDER_CONFIG_FILE), config);
}

/** Remove an HTTP provider from the registry. Does not delete its state (teardown does). */
export async function removeHttpProviderConfig(name: string): Promise<boolean> {
  const existing = await listHttpProviderConfigs();
  const next = existing.filter((p) => p.name !== name);
  if (next.length === existing.length) return false;
  await ensureDir(path.dirname(registryPath()));
  await writeJsonAtomic(registryPath(), { http: next });
  return true;
}

/** Delete a named provider's state home and credential file. */
export async function removeHttpProviderState(name: string): Promise<void> {
  await remove(httpProviderHome(name));
  await remove(httpProviderCredentialPath(name));
}

// ─── Legacy singleton migration ──────────────────────────

function legacyHome(): string {
  return path.join(teamaiHome(), LEGACY_DIR);
}

/**
 * True when a legacy ~/.teamai/local-agent/ singleton owns the backend — i.e.
 * its config.json exists. Migration DELETES this dir (no marker/snapshot), so
 * its mere presence is the "active" signal and a re-written config after a
 * migrate+remove is active again with no extra bookkeeping.
 */
export async function legacySingletonActive(): Promise<boolean> {
  return pathExists(path.join(legacyHome(), 'config.json'));
}

interface LegacyConfigShape {
  endpoint?: string;
  token?: string;
  priority?: number;
}

/**
 * Promote the legacy singleton to a named HTTP provider. Copies the legacy
 * state home into the provider's home via a staging directory + atomic rename,
 * moves the credential to the isolated 0600 file, publishes the provider, and
 * then DELETES the legacy dir. No rollback snapshot is kept: retaining it caused
 * a whole class of "snapshot revival" / "double uninstall" bugs (a later
 * `source add-http` reviving stale bindings/manifest, `teamai uninstall`
 * running a plugin uninstall_cmd twice — issue #404 reviews #6/#7), and the
 * legacy dir's own disappearance is the migrated signal (no marker needed).
 *
 * Idempotent: once the legacy dir is gone, a second call returns null.
 *
 * @returns the provider config it registered, or null when there was no legacy
 *          singleton to migrate.
 */
export async function migrateLegacyHttpProvider(options: {
  name: string;
  adapter?: string;
  priority?: number;
}): Promise<HttpProviderConfig | null> {
  assertValidProviderName(options.name);
  const legacyConfigPath = path.join(legacyHome(), 'config.json');
  const legacy = await readJson<LegacyConfigShape>(legacyConfigPath);
  if (!legacy?.endpoint) return null; // nothing (or already migrated → dir gone)

  const config: HttpProviderConfig = {
    name: options.name,
    adapter: options.adapter ?? 'clawpro',
    endpoint: legacy.endpoint,
    priority: options.priority ?? legacy.priority ?? 50,
  };

  // Retriability: the legacy dir is deleted LAST, so reaching this point means
  // any previous attempt was interrupted before it finished — the legacy backend
  // is still authoritative. Partial state a previous attempt left (a registry
  // entry, a half-copied home) carries no unique data and belongs to THIS same
  // migration, so we discard and rebuild it rather than failing. A registry
  // entry for this name whose endpoint DIFFERS is a foreign `provider add`
  // conflict — reject that.
  const home = httpProviderHome(options.name);
  const existingEntry = await getHttpProviderConfig(options.name);
  if (existingEntry && existingEntry.endpoint !== config.endpoint) {
    throw new Error(`Provider "${options.name}" already exists; choose another name.`);
  }
  await remove(home);

  // Extract the credential first. Prefer the legacy inline token, then the
  // legacy ~/.teamai/token file.
  const token =
    legacy.token ??
    (await readFileSafe(path.join(teamaiHome(), 'token')))?.trim() ??
    undefined;

  // Stage a full copy, then atomically move it into place so an interrupted
  // migration never leaves a half-populated provider home.
  const staging = `${home}.migrating`;
  await remove(staging);
  await ensureDir(path.dirname(home));
  await fse.copy(legacyHome(), staging);
  // Redact the inline token from the staged config.json BEFORE publishing the
  // directory — the credential belongs only in the isolated 0600 file, and the
  // published home must never contain it, not even in the crash window between
  // move and a later cleanup (issue #404, review #3).
  const stagedConfigPath = path.join(staging, 'config.json');
  const stagedConfig = await readJson<LegacyConfigShape & Record<string, unknown>>(stagedConfigPath);
  if (stagedConfig && 'token' in stagedConfig) {
    delete stagedConfig.token;
    await writeJsonAtomic(stagedConfigPath, stagedConfig);
  }
  // Write the isolated credential before publishing the home, so the credential
  // exists the moment the provider becomes visible.
  if (token) {
    await ensureDir(path.dirname(httpProviderCredentialPath(options.name)));
    await writeTokenFile(httpProviderCredentialPath(options.name), token);
  }
  await fse.move(staging, home);

  await upsertHttpProviderConfig(config);

  // Delete the legacy dir LAST. A crash before this re-runs the migration (the
  // legacy config is still there); after it, the legacy singleton no longer
  // exists so there is nothing to revive or double-uninstall.
  await remove(legacyHome());

  return config;
}
