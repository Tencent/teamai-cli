import { knownSecrets } from '../../env-resolution.js';
import type { LocalConfig } from '../../types.js';
import { requiredKeysOf, startKeysOf } from '../../workflow/engine.js';

/** What `teamai workflow start` resolves to mask for workflow `name`. */
export async function startSecrets(config: LocalConfig, name: string): Promise<Record<string, string>> {
  return knownSecrets(config, await startKeysOf(config, name));
}

/** What a `teamai workflow` command on run `runId` resolves to mask. */
export async function runSecrets(config: LocalConfig, runId: string): Promise<Record<string, string>> {
  return knownSecrets(config, await requiredKeysOf(config, runId));
}
