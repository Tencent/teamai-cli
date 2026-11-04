/**
 * `workflows.driver`: the driver `teamai score`, `teamai score --drain` and the finished-sessions hook start their runs
 * for. Each level keeps the value as written, so a wrong one never makes its file unreadable: it is skipped with a
 * warning, and the next level decides, as `workflows.retention` is. The order: `--driver`, this scope's config,
 * ~/.teamai/config.yaml, the team's teamai.yaml, then `local`. `workflow start` and `workflow resume` never read it:
 * without `--driver` they start a run unassigned, which a driver outside teamai relies on. `driveRun` in
 * workflow-drive.ts drives a run this machine drives; this module loads no driver, so the hooks can decide.
 */
import { loadTeamConfig } from './config.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { LOCAL_DRIVER, parseDriver, type Driver, type DriverName } from './workflow/driver-name.js';
import { resolveKeptSetting, type KeptValue } from './workflow/kept-setting.js';
import type { RunState } from './workflow/types.js';

/** What a start decides by default: drive the run here, leave it awaiting a driver this machine does not run, or leave it to any driver. */
export type DefaultDrive = { kind: 'drive' | 'awaits'; driver: DriverName } | { kind: 'unassigned' };

/** A default driver, the name it is written as, and the file that set it: none for `local` when no level sets one. */
export interface ResolvedDefaultDriver { driver: Exclude<Driver, 'skill'>; text: string; file?: string }

/** The first level of `config`'s scope, with `team` its team's teamai.yaml, whose `workflows.driver` names a driver a default may be, else `local`. */
export async function resolveDefaultDriver(config: LocalConfig, team: Pick<TeamaiConfig, 'workflows'> | null): Promise<ResolvedDefaultDriver> {
  const resolved = await resolveKeptSetting(config, team, 'driver', (written, file): KeptValue<Exclude<Driver, 'skill'>> => {
    const parsed = parseDriver(written);

    if (parsed.ok && parsed.driver !== 'skill') return { ok: true, value: parsed.driver };
    const reason = parsed.ok ? 'the skill driver needs a coding session, so it drives only a run started with --driver skill' : parsed.reason;

    return { ok: false, warning: `Ignoring workflows.driver in ${file}: ${reason}.` };
  });

  if (!resolved) return { driver: 'local', text: 'local' };
  const { value: driver, file } = resolved;

  return { driver, text: driver === 'local' || driver === 'none' ? driver : driver.external, file };
}

/** Whether this machine drives runs for driver `name`: only `local`, until driver definitions are resolved from `config`'s member and team. */
export async function drivesHere(_config: LocalConfig, name: DriverName): Promise<boolean> {
  return name === 'local';
}

/** What a start in `config`'s scope does without `--driver`, from `workflows.driver`. */
export async function driveByDefault(config: LocalConfig): Promise<DefaultDrive> {
  const { driver } = await resolveDefaultDriver(config, await loadTeamConfig(config.repo.localPath));

  if (driver === 'none') return { kind: 'unassigned' };
  const name = driver === 'local' ? LOCAL_DRIVER : driver.external;

  return { kind: await drivesHere(config, name) ? 'drive' : 'awaits', driver: name };
}

/** The `awaits` a run that `decided` starts carries: the driver it awaits, or none. */
export function awaitsOf(decided: DefaultDrive): RunState['awaits'] {
  return decided.kind === 'awaits' ? { driver: decided.driver } : undefined;
}

/** What a command says of run `run`, which it started awaiting driver `driver`. */
export function awaitsLine(run: string, driver: DriverName): string {
  return `${run} waits for driver ${driver}, which this machine does not run. To drive it here: teamai workflow resume ${run} --driver local`;
}

/** What a command says of run `run` of `workflow`, which `workflows.driver: none` left open for any driver. */
export function leftOpenLine(run: string, workflow: string): string {
  return `Left open: run ${run} of ${workflow}, which workflows.driver none leaves to any driver. A driver takes it with: teamai workflow next ${run} --json '{"driver":{…}}'`;
}
