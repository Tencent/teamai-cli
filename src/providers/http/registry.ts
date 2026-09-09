import type { HttpBackendAdapter, HttpProviderConfig, ResourceProvider } from '../types.js';
import { ResourceProviderRegistry } from '../resource-registry.js';
import { ClawProAdapter } from './adapters/clawpro/index.js';
import { HttpResourceProvider } from './provider.js';
import { listHttpProviderConfigs } from './store.js';

const adapters = new Map<string, () => HttpBackendAdapter>([
  ['clawpro', () => new ClawProAdapter()],
]);

export function registerHttpAdapter(name: string, factory: () => HttpBackendAdapter): void {
  adapters.set(name, factory);
}

export function createHttpResourceProvider(config: HttpProviderConfig): HttpResourceProvider {
  const factory = adapters.get(config.adapter);
  if (!factory) throw new Error(`Unknown HTTP provider adapter: "${config.adapter}".`);
  return new HttpResourceProvider(config, factory());
}

export async function loadHttpResourceProviders(): Promise<ResourceProvider[]> {
  const registry = new ResourceProviderRegistry();
  for (const config of await listHttpProviderConfigs()) registry.register(createHttpResourceProvider(config));
  return registry.list();
}
