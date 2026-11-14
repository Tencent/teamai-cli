import { resolveDefaultDriver } from './default-driver.js';
import type { Check } from './doctor.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { LOCAL_DRIVER } from './workflow/driver-name.js';
import { sandboxEntryChecks } from './workflow/runtimes/sources.js';

/** The drivers this member runs: the default one `workflows.driver` names, then each one their config tunes. */
async function driversInUse(localConfig: LocalConfig, teamConfig: Pick<TeamaiConfig, 'workflows'> | null): Promise<string[]> {
  const { driver } = await resolveDefaultDriver(localConfig, teamConfig);
  const named = driver === 'none' ? [] : [driver === 'local' ? LOCAL_DRIVER : driver.external];

  return [...new Set([...named, ...Object.keys(localConfig.workflows?.drivers ?? {})])];
}

/**
 * For each sandbox entry of the drivers in use, the sandbox profile it runs (where it comes from, its revision and its
 * provider) and whether this machine can start it, as far as a check that starts no sandbox can tell. Built only for
 * `doctor`: each opens the sandbox runtime, which a pull never waits on.
 */
export async function buildSandboxProfileChecks({ localConfig, teamConfig }: { localConfig: LocalConfig; teamConfig: Pick<TeamaiConfig, 'workflows'> | null }, checkout: string): Promise<Check[]> {
  const entries = (await Promise.all((await driversInUse(localConfig, teamConfig)).map((name) => sandboxEntryChecks(localConfig, name, checkout)))).flat();

  return Promise.all(entries.map(async ({ driver, asked, located, canStart }): Promise<Check> => {
    if (!located.ok) {
      return { name: `Sandbox profile "${asked}" of driver ${driver} is declared`, source: 'local', check: async () => false, fix: located.failure.message };
    }

    const { profile } = located;
    const started = await canStart();

    return {
      name: `Sandbox profile "${asked}" of driver ${driver} (${profile.location}, revision ${profile.revision.slice(0, 12)}, provider ${profile.provider ?? 'unset'}) can start here`,
      source: 'local',
      check: async () => started.ok,
      ...(!started.ok && { fix: started.failure.message }),
    };
  }));
}
