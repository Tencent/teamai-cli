/**
 * Drives a run on this machine by the name of its driver. The one way `workflow start`, `teamai score` and
 * `teamai score --drain` drive a run here, so a driver this machine comes to drive is added in one place.
 */
import { resolveRunMode } from './launch-context.js';
import type { LocalConfig } from './types.js';
import type { DriverName } from './workflow/driver-name.js';
import { runLocalDriver, type LocalDriverOptions } from './workflow/drivers/local/local-driver.js';
import { disposeDriver, openDriver, type OpenedDriver } from './workflow/runtimes/sources.js';
import type { WorkflowEnvelope, WorkflowFailure } from './workflow/types.js';

/** The driver a drive runs on: one by its name, or a definition its caller opened and closes. */
export type DriveOn = { kind: 'named'; name: DriverName } | { kind: 'opened'; opened: OpenedDriver };

/**
 * Drives run `run` of `config` here from `cwd` on `on`, which `drivesHere` said this machine drives: `local`, the
 * definition a name stands for, opened for this drive and closed after it, or a definition the caller opened.
 */
export async function driveRun(config: LocalConfig, run: string, on: DriveOn, { cwd, options }: { cwd: string; options: LocalDriverOptions }): Promise<WorkflowEnvelope> {
  if (on.kind === 'opened') return runLocalDriver(config, run, cwd, { ...options, ...definedDrive(on.opened, options.tools ?? {}) });

  const opened = await openDriver(config, on.name, { personal: true, mode: resolveRunMode(process.env), canAsk: process.stdin.isTTY && process.stderr.isTTY, purpose: 'run', checkout: cwd });

  if (!opened.ok) return { error: opened.failure };

  try {
    return await runLocalDriver(config, run, cwd, { ...options, ...definedDrive(opened.opened, options.tools ?? {}) });
  } finally {
    await disposeDriver(opened.opened);
  }
}

/** What the local loop runs an opened definition with: its default tool under `tools`, the `--tools` given, and its runtimes. */
export function definedDrive(opened: OpenedDriver | undefined, tools: Record<string, string>): Pick<LocalDriverOptions, 'tools' | 'runtimes'> {
  const tool = opened?.driver.definition.tool;
  const drive: Pick<LocalDriverOptions, 'tools' | 'runtimes'> = { tools: tool === undefined ? tools : { default: tool, ...tools } };

  if (opened) drive.runtimes = { driver: opened.driver.name, asked: opened.asked, runtimes: opened.runtimes };

  return drive;
}

/** The refusal of a `--driver` that is neither `local` nor `skill`. */
export function unsupportedDriver(driver: string): WorkflowFailure {
  return { code: 'unsupported_driver', message: `Driver "${driver}" is not available. Use --driver local or --driver skill.` };
}
