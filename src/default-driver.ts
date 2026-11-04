/**
 * `workflows.driver`: the driver `teamai score`, `teamai score --drain` and the finished-sessions hook start their runs
 * for. Each level keeps the value as written, so a wrong one never makes its file unreadable: it is skipped with a
 * warning, and the next level decides, as `workflows.retention` is. The order: `--driver`, this scope's config,
 * ~/.teamai/config.yaml, the team's teamai.yaml, then `local`. `workflow start` and `workflow resume` never read it:
 * without `--driver` they start a run unassigned, which a driver outside teamai relies on. `driveRun` in
 * workflow-commands.ts drives a run this machine drives; this module loads no driver, so the hooks can decide.
 */
import path from 'node:path';
import { loadMemberSettings, loadTeamConfig, ownMemberSettings } from './config.js';
import { getDataHome, getTeamaiHomeDir, type LocalConfig } from './types.js';
import { warnOnce } from './utils/warn-once.js';
import { DriverNameSchema, parseDriver, type Driver, type DriverName } from './workflow/driver-name.js';

const LOCAL = DriverNameSchema.parse('local');

/** What a start decides by default: drive the run here, leave it awaiting a driver this machine does not run, or leave it to any driver. */
export type DefaultDrive = { kind: 'drive' | 'awaits'; driver: DriverName } | { kind: 'unassigned' };

/** A default driver, the name it is written as, and the file that set it: none for `local` when no level sets one. */
export interface ResolvedDefaultDriver { driver: Exclude<Driver, 'skill'>; text: string; file?: string }

/** The first level of `config`'s scope whose `workflows.driver` names a driver a default may be, else `local`. */
export async function resolveDefaultDriver(config: LocalConfig): Promise<ResolvedDefaultDriver> {
  const machineFile = path.join(getTeamaiHomeDir(), 'config.yaml');
  const scopeFile = config.scope === 'user' ? machineFile : path.join(getDataHome(config), 'config.yaml');

  const levels = [
    { file: scopeFile, value: () => Promise.resolve(ownMemberSettings(config).workflows?.driver) },
    ...config.scope === 'user' ? [] : [{ file: machineFile, value: async () => (await loadMemberSettings(machineFile)).workflows?.driver }],
    { file: path.join(config.repo.localPath, 'teamai.yaml'), value: async () => (await loadTeamConfig(config.repo.localPath))?.workflows?.driver },
  ];

  for (const { file, value } of levels) {
    const written = await value();

    if (written === undefined) continue;
    const parsed = parseDriver(written);

    if (parsed.ok && parsed.driver !== 'skill') {
      const { driver } = parsed;

      return { driver, text: driver === 'local' || driver === 'none' ? driver : driver.external, file };
    }

    const reason = parsed.ok ? 'the skill driver needs a coding session, so it drives only a run started with --driver skill' : parsed.reason;
    warnOnce(`Ignoring workflows.driver in ${file}: ${reason}.`);
  }

  return { driver: 'local', text: 'local' };
}

/** Whether this machine drives runs for driver `name`: only `local`, until driver definitions are resolved from `config`'s member and team. */
export async function drivesHere(_config: LocalConfig, name: DriverName): Promise<boolean> {
  return name === 'local';
}

/** What a start in `config`'s scope does without `--driver`, from `workflows.driver`. */
export async function driveByDefault(config: LocalConfig): Promise<DefaultDrive> {
  const { driver } = await resolveDefaultDriver(config);

  if (driver === 'none') return { kind: 'unassigned' };
  const name = driver === 'local' ? LOCAL : driver.external;

  return { kind: await drivesHere(config, name) ? 'drive' : 'awaits', driver: name };
}

/** What a command says of run `run`, which it started awaiting driver `driver`. */
export function awaitsLine(run: string, driver: DriverName): string {
  return `${run} waits for driver ${driver}, which this machine does not run. To drive it here: teamai workflow resume ${run} --driver local`;
}
