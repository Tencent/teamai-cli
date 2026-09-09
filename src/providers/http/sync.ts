import { log } from '../../utils/logger.js';
import { loadLocalAgentConfig, reportAndSyncFromHook } from '../../local-agent.js';
import { syncResourceProviders } from '../resource-registry.js';
import { loadHttpResourceProviders } from './registry.js';

/** Dispatch one hook to every named HTTP provider, then the legacy provider if present. */
export async function syncHttpProvidersFromHook(
  stdin: Record<string, unknown>,
  tool: string,
): Promise<string | null> {
  const providers = await loadHttpResourceProviders();
  if (providers.length === 0) {
    return reportAndSyncFromHook(stdin, tool);
  }
  // Apply lower-priority snapshots first so a later successful provider is the
  // active on-disk source for any conflicting resource key.
  const results = await syncResourceProviders([...providers].reverse(), {
    cwd: typeof stdin.cwd === 'string' ? stdin.cwd : undefined,
    tool,
    trigger: 'hook',
    stdin,
  });
  for (const result of results) {
    if (!result.ok) log.warn(`[provider:${result.provider}] Sync failed: ${result.message ?? 'unknown error'}`);
  }

  // Existing ~/.teamai/local-agent installs remain live throughout migration.
  let legacyOutput: string | null = null;
  if (await loadLocalAgentConfig()) legacyOutput = await reportAndSyncFromHook(stdin, tool);
  return results.find((result) => result.hookOutput)?.hookOutput ?? legacyOutput;
}
