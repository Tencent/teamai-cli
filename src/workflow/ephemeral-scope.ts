/**
 * The scope of a run started where no `teamai init` serves the directory: a config built for that run alone in a new
 * temporary directory, with a data home and an empty team repo of its own, or the team repo the command was given,
 * removed when the run ends. Every process of the run loads the same config through `TEAMAI_EPHEMERAL_CONFIG`
 * (`attemptEnv`). The scope writes nothing outside that directory, and each run builds a new one, so a run killed before
 * it removed it leaves nothing a later run reads.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadTeamConfig, readEphemeralConfig } from '../config.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

export type EphemeralScope = { config: LocalConfig; teamConfig: TeamaiConfig; close: () => Promise<void> };

/** The member's login name, which the run records as its starter, else `member` where the system has none. */
function memberName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'member';
  }
}

/**
 * Builds the scope of a run that starts in `checkout`, which `close` removes. A `teamRepo` checkout with a teamai.yaml
 * is the scope's team repo, read where it is; without one, the scope's team repo is empty.
 */
async function open(checkout: string, teamRepo?: string): Promise<EphemeralScope> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-ephemeral-'));
  const close = (): Promise<void> => fs.rm(root, { recursive: true, force: true });

  try {
    const given = teamRepo !== undefined && await fs.access(path.join(teamRepo, 'teamai.yaml')).then(() => true, () => false) ? teamRepo : undefined;
    const team = given ?? path.join(root, 'team');
    const file = path.join(root, 'data', 'config.yaml');
    await fs.mkdir(path.dirname(file));

    if (given === undefined) {
      await fs.mkdir(team);
      await fs.writeFile(path.join(team, 'teamai.yaml'), YAML.stringify({ team: 'ephemeral', repo: '', provider: 'git', usageReport: false }));
    }

    await fs.writeFile(file, YAML.stringify({ repo: { localPath: team, remote: '' }, username: memberName(), scope: 'workspace' }));
    const [config, teamConfig] = await Promise.all([readEphemeralConfig(file, checkout), loadTeamConfig(team)]);

    if (!config || !teamConfig) throw new Error(`The config built for this run in ${root} could not be read back. Run teamai init, then run the command again.`);

    return { config, teamConfig, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const EphemeralScope = { open } as const;
