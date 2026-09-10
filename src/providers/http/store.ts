import path from 'node:path';
import { ensureDir, listDirs, pathExists, readFileSafe, readJson, remove, writeJsonAtomic } from '../../utils/fs.js';
import { getUserHome } from '../../utils/home.js';
import { assertSafeResourceName } from '../../utils/path-safety.js';
import type { HttpProviderConfig } from '../types.js';
import fse from 'fs-extra';

export function getHttpProvidersRoot(): string {
  return path.join(getUserHome(), '.teamai', 'providers', 'http');
}

export function getHttpProviderHome(name: string): string {
  assertSafeResourceName(name);
  return path.join(getHttpProvidersRoot(), name);
}

export function getHttpProviderCredentialPath(name: string): string {
  assertSafeResourceName(name);
  return path.join(getUserHome(), '.teamai', 'credentials', name);
}

export async function addHttpProvider(
  input: Omit<HttpProviderConfig, 'type' | 'createdAt'>,
  token?: string,
): Promise<HttpProviderConfig> {
  assertSafeResourceName(input.name);
  if (await pathExists(path.join(getHttpProviderHome(input.name), 'provider.json'))) {
    throw new Error(`HTTP provider "${input.name}" already exists.`);
  }
  const config: HttpProviderConfig = {
    ...input,
    type: 'http',
    endpoint: input.endpoint.trim().replace(/\/+$/, ''),
    createdAt: new Date().toISOString(),
  };
  if (!config.endpoint) throw new Error('HTTP provider endpoint is required.');
  try {
    await ensureDir(getHttpProviderHome(input.name));
    await writeJsonAtomic(path.join(getHttpProviderHome(input.name), 'provider.json'), config);
    if (token !== undefined) {
      const credentialPath = getHttpProviderCredentialPath(input.name);
      await ensureDir(path.dirname(credentialPath));
      await import('node:fs/promises').then((fs) => fs.writeFile(credentialPath, `${token}\n`, { mode: 0o600 }));
      await import('node:fs/promises').then((fs) => fs.chmod(credentialPath, 0o600));
    }
  } catch (error) {
    await removeHttpProviderConfig(input.name);
    throw error;
  }
  return config;
}

export async function listHttpProviderConfigs(): Promise<HttpProviderConfig[]> {
  if (!await pathExists(getHttpProvidersRoot())) return [];
  const configs: HttpProviderConfig[] = [];
  for (const name of await listDirs(getHttpProvidersRoot())) {
    const config = await readJson<HttpProviderConfig>(path.join(getHttpProviderHome(name), 'provider.json'));
    if (config?.type === 'http' && config.name === name && config.enabled !== false) configs.push(config);
  }
  return configs.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

export async function readHttpProviderCredential(name: string): Promise<string | null> {
  return (await readFileSafe(getHttpProviderCredentialPath(name)))?.trim() || null;
}

export async function removeHttpProviderConfig(name: string): Promise<void> {
  await remove(getHttpProviderHome(name));
  await remove(getHttpProviderCredentialPath(name));
}

export async function setPrimaryProvider(name: string): Promise<void> {
  assertSafeResourceName(name);
  const settingsPath = path.join(getUserHome(), '.teamai', 'providers', 'settings.json');
  await ensureDir(path.dirname(settingsPath));
  await writeJsonAtomic(settingsPath, { primaryProvider: name });
}

export async function getPrimaryProvider(): Promise<string | undefined> {
  const settings = await readJson<{ primaryProvider?: string }>(
    path.join(getUserHome(), '.teamai', 'providers', 'settings.json'),
  );
  return settings?.primaryProvider;
}

/**
 * Copy the legacy singleton into a named ClawPro provider. The legacy directory
 * stays as a rollback snapshot and is disabled only after every new file lands.
 */
export async function migrateLegacyHttpProvider(name: string, priority = 50): Promise<HttpProviderConfig> {
  assertSafeResourceName(name);
  const legacyHome = path.join(getUserHome(), '.teamai', 'local-agent');
  const legacyConfig = await readJson<{ endpoint?: string; token?: string }>(path.join(legacyHome, 'config.json'));
  if (!legacyConfig?.endpoint) throw new Error('No legacy HTTP local-agent configuration was found.');
  if (await pathExists(path.join(getHttpProviderHome(name), 'provider.json'))) {
    throw new Error(`HTTP provider "${name}" already exists.`);
  }

  const target = getHttpProviderHome(name);
  const staging = `${target}.migrating-${process.pid}`;
  await ensureDir(path.dirname(target));
  const config: HttpProviderConfig = {
    name,
    type: 'http',
    adapter: 'clawpro',
    endpoint: legacyConfig.endpoint.trim().replace(/\/+$/, ''),
    priority,
    createdAt: new Date().toISOString(),
  };
  try {
    await remove(staging);
    await fse.copy(legacyHome, staging, { overwrite: false, errorOnExist: true });
    await writeJsonAtomic(path.join(staging, 'provider.json'), config);
    await writeJsonAtomic(path.join(staging, 'config.json'), { ...legacyConfig, token: undefined });
    await import('node:fs/promises').then((fs) => fs.rename(staging, target));

    const legacyCredential = legacyConfig.token
      ?? (await readFileSafe(path.join(getUserHome(), '.teamai', 'token')))?.trim();
    if (legacyCredential) {
      const credentialPath = getHttpProviderCredentialPath(name);
      await ensureDir(path.dirname(credentialPath));
      const fsPromises = await import('node:fs/promises');
      await fsPromises.writeFile(credentialPath, `${legacyCredential}\n`, { mode: 0o600 });
      await fsPromises.chmod(credentialPath, 0o600);
    }
    await import('node:fs/promises').then((fs) => fs.writeFile(path.join(legacyHome, 'migrated-to'), `${name}\n`));
  } catch (error) {
    await remove(staging);
    await removeHttpProviderConfig(name);
    throw error;
  }
  return config;
}
