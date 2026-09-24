// ─── Resource provider sync ──────────────────────────────
//
// Drives a failure-isolated sync across the mounted resource providers. This is
// the sync-mechanism layer (git / http); it is distinct from the git-host
// registry in ./registry.ts, which maps a repo URL to a GitProvider.
//
// See issue #404. Multi-provider ownership arbitration, primary-write selection
// and cross-provider failover are a later phase and intentionally live outside
// this file.

import type { ResourceProvider, SyncContext, ProviderResult } from './types.js';
import { log } from '../utils/logger.js';

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
