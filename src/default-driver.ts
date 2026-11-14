/**
 * `workflows.driver`: the driver `teamai score`, `teamai score --drain` and the finished-sessions hook start their runs
 * for. Each level keeps the value as written, so a wrong one never makes its file unreadable: it is skipped with a
 * warning, and the next level decides, as `workflows.retention` is. The order: `--driver`, this scope's config,
 * ~/.teamai/config.yaml, the team's teamai.yaml, then `local`. `workflow start` and `workflow resume` never read it:
 * without `--driver` they start a run unassigned, which a driver outside teamai relies on. `driveRun` in
 * workflow-drive.ts drives a run this machine drives; this module opens no driver, so the hooks can decide.
 */
import { loadTeamConfig } from './config.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { HOST_DRIVER, LOCAL_DRIVER, parseDriver, type Driver, type DriverName } from './workflow/driver-name.js';
import { resolveKeptSetting, type KeptValue } from './workflow/kept-setting.js';
import { resolveDriver } from './workflow/runtimes/definitions.js';
import type { RunState } from './workflow/types.js';

/** What a start decides by default: drive the run here, leave it awaiting a driver this machine does not run, or leave it to any driver. */
export type DefaultDrive = { kind: 'drive' | 'awaits'; driver: DriverName } | { kind: 'unassigned' };

/** A default driver, the name it is written as, and the file that set it: none for `local` when no level sets one. */
export interface ResolvedDefaultDriver { driver: Exclude<Driver, 'skill'>; text: string; file?: string }

/** The first level of `config`'s scope, with `team` its team's teamai.yaml, whose `workflows.driver` names a driver a default may be, else `local`. */
export async function resolveDefaultDriver(config: LocalConfig, team: Pick<TeamaiConfig, 'workflows'> | null): Promise<ResolvedDefaultDriver> {
  const resolved = await resolveKeptSetting(config, team, 'driver', (written, file): KeptValue<Exclude<Driver, 'skill'>> => {
    const parsed = parseDriver(written);

    if (!parsed.ok) return { ok: false, warning: `Ignoring workflows.driver in ${file}: ${parsed.reason}.` };
    const { driver } = parsed;

    if (driver === 'skill') return { ok: false, warning: `Ignoring workflows.driver in ${file}: the skill driver needs a coding session, so it drives only a run started with --driver skill.` };

    if (driver !== 'local' && driver !== 'none' && driver.external === HOST_DRIVER) {
      return { ok: false, warning: `Ignoring workflows.driver in ${file}: the host driver launches no AI tool, which the runs this setting starts use, so it drives only a run started with --driver host.` };
    }

    return { ok: true, value: driver };
  });

  if (!resolved) return { driver: 'local', text: 'local' };
  const { value: driver, file } = resolved;

  return { driver, text: driver === 'local' || driver === 'none' ? driver : driver.external, file };
}

/** Where driver `name` stands on this machine: driven here, defined here with a team runtime no one accepted here, or not here. */
type DriverHere = 'drives' | 'unaccepted' | 'absent';

async function driverHere(config: LocalConfig, name: DriverName): Promise<DriverHere> {
  // A teamai-local this machine cannot open is driven here, and the drive fails naming the file and why. One whose team
  // runtime no one accepted here waits, as any driver's does.
  const absent: DriverHere = name === LOCAL_DRIVER ? 'drives' : 'absent';
  const resolved = await resolveDriver(config, name, { personal: true });

  if (!resolved.ok) return absent;
  const { acceptRuntime, locateRuntime } = await import('./workflow/runtimes/locate.js');
  let here: DriverHere = 'drives';

  for (const { use } of resolved.driver.definition.runtimes) {
    const located = await locateRuntime(resolved.driver, use);

    if (!located.ok) return absent;

    if (!(await acceptRuntime(located.source, { mode: 'unattended', canAsk: false })).ok) here = 'unaccepted';
  }

  return here;
}

/**
 * Whether this machine drives runs for driver `name`: `local`, or a driver definition `config`'s member, team or teamai
 * gives, each of whose runtimes is installed here and, for a team runtime, accepted here. Nothing is asked: a run that
 * a hook or a cron job starts has nobody to accept a runtime, so it waits for a person to resume it.
 */
export async function drivesHere(config: LocalConfig, name: DriverName): Promise<boolean> {
  return await driverHere(config, name) === 'drives';
}

/** What a start in `config`'s scope does without `--driver`, from `workflows.driver`. */
export async function driveByDefault(config: LocalConfig): Promise<DefaultDrive> {
  const { driver } = await resolveDefaultDriver(config, await loadTeamConfig(config.repo.localPath, config));

  if (driver === 'none') return { kind: 'unassigned' };
  const name = driver === 'local' ? LOCAL_DRIVER : driver.external;

  return { kind: await drivesHere(config, name) ? 'drive' : 'awaits', driver: name };
}

/** The `awaits` a run that `decided` starts carries: the driver it awaits, or none. */
export function awaitsOf(decided: DefaultDrive): RunState['awaits'] {
  return decided.kind === 'awaits' ? { driver: decided.driver } : undefined;
}

/**
 * What a command in `config`'s scope says of run `run`, which awaits driver `driver`, with the command that drives it
 * here: on that driver when this machine has its definition, a person accepting its team runtime there; else on local.
 */
export async function awaitsLine(config: LocalConfig, run: string, driver: DriverName): Promise<string> {
  const here = await driverHere(config, driver);

  switch (here) {
    case 'drives':
      return `${run} waits for driver ${driver}. To drive it here: teamai workflow resume ${run} --driver ${driver}`;
    case 'unaccepted':
      return `${run} waits for driver ${driver}, whose team runtime this machine has not accepted. To review it and drive the run here: teamai workflow resume ${run} --driver ${driver}`;
    case 'absent':
      return `${run} waits for driver ${driver}, which this machine does not run. To drive it here: teamai workflow resume ${run} --driver local`;
    default: {
      const unhandled: never = here;

      return unhandled;
    }
  }
}

/** What a command says of run `run` of `workflow`, which `workflows.driver: none` left open for any driver. */
export function leftOpenLine(run: string, workflow: string): string {
  return `Left open: run ${run} of ${workflow}, which workflows.driver none leaves to any driver. A driver takes it with: teamai workflow next ${run} --json '{"driver":{…}}'`;
}
