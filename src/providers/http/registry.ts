// ─── HTTP adapter registry ───────────────────────────────
//
// Maps a protocol adapter name (e.g. 'clawpro') to its implementation and
// builds HttpResourceProviders from persisted config. Deleting an adapter
// directory removes it here without touching the generic HTTP provider — the
// point of the ClawPro extraction in issue #404.

import type { HttpBackendAdapter, HttpProviderConfig } from '../types.js';
import { HttpResourceProvider } from './provider.js';
import { ClawProAdapter } from './adapters/clawpro/index.js';
import { listHttpProviderConfigs } from './store.js';

/** Adapter factories, keyed by adapter name. */
const ADAPTERS: Record<string, () => HttpBackendAdapter> = {
  clawpro: () => new ClawProAdapter(),
};

/** Names of the HTTP protocol adapters this build supports. */
export function availableHttpAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/** Instantiate an HTTP backend adapter by name. Throws for an unknown adapter. */
export function getHttpAdapter(name: string): HttpBackendAdapter {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(
      `Unknown HTTP adapter "${name}". Available: ${availableHttpAdapters().join(', ')}`,
    );
  }
  return factory();
}

/** Build a provider from one config. */
export function createHttpResourceProvider(config: HttpProviderConfig): HttpResourceProvider {
  return new HttpResourceProvider(config, getHttpAdapter(config.adapter));
}

/** Load every configured HTTP provider from the store. */
export async function loadHttpResourceProviders(): Promise<HttpResourceProvider[]> {
  const configs = await listHttpProviderConfigs();
  return configs.map(createHttpResourceProvider);
}
