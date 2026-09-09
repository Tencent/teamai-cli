import type { ProviderResult, ResourceProvider, SyncContext } from './types.js';

export class ResourceProviderRegistry {
  private readonly providers = new Map<string, ResourceProvider>();

  register(provider: ResourceProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Resource provider "${provider.name}" is already registered.`);
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): ResourceProvider | undefined {
    return this.providers.get(name);
  }

  list(): ResourceProvider[] {
    return [...this.providers.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }
}

/** Run each provider exactly once and turn individual failures into provider-local results. */
export async function syncResourceProviders(
  providers: ResourceProvider[],
  context: SyncContext,
): Promise<ProviderResult[]> {
  const capable = providers.filter((provider) => provider.capabilities.pull || provider.capabilities.report);
  const results: ProviderResult[] = [];
  for (const provider of capable) {
    try {
      results.push(await provider.sync(context));
    } catch (error) {
      results.push({
        provider: provider.name,
        ok: false,
        changed: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function resolveWritableProvider(
  providers: ResourceProvider[],
  primaryProvider?: string,
): ResourceProvider {
  if (primaryProvider) {
    const selected = providers.find((provider) => provider.name === primaryProvider);
    if (!selected) throw new Error(`Resource provider "${primaryProvider}" was not found.`);
    if (!selected.capabilities.push) throw new Error(`Resource provider "${primaryProvider}" does not support push.`);
    return selected;
  }
  const writable = providers.filter((provider) => provider.capabilities.push);
  if (writable.length === 1) return writable[0];
  if (writable.length === 0) throw new Error('No configured resource provider supports push.');
  throw new Error('Multiple resource providers support push; configure primaryProvider or pass --provider.');
}
