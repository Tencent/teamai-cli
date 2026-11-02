import type { LocalConfig, TeamaiConfig } from './types.js';

export type UpdatePolicy = 'auto' | 'prompt' | 'skip';

/**
 * Resolve the effective update policy.
 *
 * Priority: local.updatePolicy > team.autoUpdate > 'auto' (default).
 */
export function resolveEffectiveUpdatePolicy(
  localConfig: Pick<LocalConfig, 'updatePolicy'> | null,
  teamConfig: Pick<TeamaiConfig, 'autoUpdate'> | null,
): UpdatePolicy {
  if (localConfig?.updatePolicy !== undefined) {
    return localConfig.updatePolicy;
  }

  if (teamConfig?.autoUpdate === false) return 'skip';

  if (teamConfig?.autoUpdate === true) return 'auto';

  return 'auto';
}

/**
 * Return a new LocalConfig with the given updatePolicy applied.
 *
 * Pass `undefined` to clear the field (inherit team default).
 */
export function withUpdatePolicy(
  config: LocalConfig,
  policy: UpdatePolicy | undefined,
): LocalConfig {
  const { updatePolicy: _, ...rest } = config;

  return policy === undefined ? rest : { ...rest, updatePolicy: policy };
}

/**
 * Return a new TeamaiConfig with the given autoUpdate applied.
 *
 * Pass `undefined` to clear the field (no team opinion).
 */
export function withAutoUpdate(
  config: TeamaiConfig,
  value: boolean | undefined,
): TeamaiConfig {
  const { autoUpdate: _, ...rest } = config;

  return value === undefined ? rest : { ...rest, autoUpdate: value };
}
