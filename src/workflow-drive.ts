/**
 * Drives a run on this machine by the name of its driver. The one way `workflow start`, `teamai score` and
 * `teamai score --drain` drive a run here, so a driver this machine comes to drive is added in one place.
 */
import type { LocalConfig } from './types.js';
import type { DriverName } from './workflow/driver-name.js';
import { runLocalDriver, type LocalDriverOptions } from './workflow/drivers/local/local-driver.js';
import type { WorkflowEnvelope, WorkflowFailure } from './workflow/types.js';

/**
 * Drives run `run` of `config` here as driver `name`, which `drivesHere` said this machine drives: the local driver from
 * `cwd`.
 */
export async function driveRun(config: LocalConfig, run: string, name: DriverName, { cwd, options }: { cwd: string; options: LocalDriverOptions }): Promise<WorkflowEnvelope> {
  if (name === 'local') return runLocalDriver(config, run, cwd, options);

  return { error: unsupportedDriver(name) };
}

/** The refusal of a `--driver` that is neither `local` nor `skill`. */
export function unsupportedDriver(driver: string): WorkflowFailure {
  return { code: 'unsupported_driver', message: `Driver "${driver}" is not available. Use --driver local or --driver skill.` };
}
