// ─── Resource provider registry ──────────────────────────
//
// Holds the named ResourceProviders mounted for a run and drives a
// failure-isolated sync across them. This is the sync-mechanism layer (git /
// http); it is distinct from the git-host registry in ./registry.ts, which maps
// a repo URL to a GitProvider (github/tgit/…).
//
// See issue #404. Multi-provider ownership arbitration, primary-write selection
// and cross-provider failover are a later phase and intentionally live outside
// this file.

import type { ResourceProvider, SyncContext, ProviderResult } from './types.js';
import { log } from '../utils/logger.js';

/**
 * A set of uniquely-named resource providers. Registration rejects duplicate
 * names; listing returns providers by descending priority, then name, so
 * ordering is deterministic regardless of registration order.
 */
export class ResourceProviderRegistry {
  private readonly providers = new Map<string, ResourceProvider>();

  /** Register a provider. Throws if the name is already taken. */
  register(provider: ResourceProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Resource provider "${provider.name}" is already registered.`);
    }
    this.providers.set(provider.name, provider);
  }

  /** Look up a provider by name, or undefined if not registered. */
  get(name: string): ResourceProvider | undefined {
    return this.providers.get(name);
  }

  /** All providers, ordered by descending priority then name. */
  list(): ResourceProvider[] {
    return [...this.providers.values()].sort(
      (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
    );
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.size;
  }
}

/**
 * Sync every provider that can pull or report, isolating failures: one
 * provider throwing or timing out never aborts the others. Each provider's
 * outcome — success or a caught error rendered as `{ ok: false }` — is
 * returned so the caller can report per-provider status.
 *
 * Providers run lowest-priority first so that, once same-name arbitration
 * lands, a higher-priority provider applied later wins the final on-disk state.
 * Until then order only affects log sequencing.
 */
export async function syncResourceProviders(
  providers: ResourceProvider[],
  context: SyncContext,
): Promise<ProviderResult[]> {
  const active = providers.filter(
    (p) => p.capabilities.pull || p.capabilities.report,
  );
  // Ascending priority: apply the winner last (see doc comment).
  const ordered = [...active].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );

  const results: ProviderResult[] = [];
  for (const provider of ordered) {
    try {
      results.push(await provider.sync(context));
    } catch (e) {
      const message = (e as Error).message;
      log.debug(`[providers] "${provider.name}" sync failed (isolated): ${message}`);
      results.push({ provider: provider.name, ok: false, changed: false, message });
    }
  }
  return results;
}
