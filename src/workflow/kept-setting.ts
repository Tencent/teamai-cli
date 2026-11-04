/**
 * A `workflows` member setting each level keeps as written, so a wrong value never makes its file unreadable: it is
 * skipped with a warning, and the next level decides. The levels: `config`'s scope file, ~/.teamai/config.yaml unless
 * the scope is the user's, then the team's teamai.yaml.
 */
import path from 'node:path';
import { loadMemberSettings, ownMemberSettings } from '../config.js';
import { getDataHome, getTeamaiHomeDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import { warnOnce } from '../utils/warn-once.js';

/** What a level's value is to the setting: the value it stands for, or the warning that skips its file. */
export type KeptValue<T> = { ok: true; value: T } | { ok: false; warning: string };

/** The first level of `config`'s scope whose `workflows.<key>` `take` accepts, and its file; undefined when none sets one. */
export async function resolveKeptSetting<T>(
  config: LocalConfig,
  team: Pick<TeamaiConfig, 'workflows'> | null,
  key: 'retention' | 'driver',
  // oxlint-disable-next-line teamai/no-unknown-parameters -- take is the parse: each level keeps the value as written
  take: (written: unknown, file: string) => KeptValue<T>,
): Promise<{ value: T; file: string } | undefined> {
  const machineFile = path.join(getTeamaiHomeDir(), 'config.yaml');
  const scopeFile = config.scope === 'user' ? machineFile : path.join(getDataHome(config), 'config.yaml');

  const levels = [
    { file: scopeFile, written: () => Promise.resolve(ownMemberSettings(config).workflows?.[key]) },
    ...config.scope === 'user' ? [] : [{ file: machineFile, written: async () => (await loadMemberSettings(machineFile)).workflows?.[key] }],
    { file: path.join(config.repo.localPath, 'teamai.yaml'), written: () => Promise.resolve(team?.workflows?.[key]) },
  ];

  for (const { file, written } of levels) {
    const value = await written();

    if (value === undefined) continue;
    const taken = take(value, file);

    if (taken.ok) return { value: taken.value, file };
    warnOnce(taken.warning);
  }

  return undefined;
}
