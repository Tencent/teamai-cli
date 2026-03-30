import YAML from 'yaml';
import path from 'node:path';
import {
  TeamaiConfigSchema,
  LocalConfigSchema,
  StateSchema,
  TEAMAI_CONFIG_PATH,
  TEAMAI_STATE_PATH,
  type TeamaiConfig,
  type LocalConfig,
  type State,
} from './types.js';
import { readFileSafe, readJson, writeFile, writeJson, expandHome } from './utils/fs.js';
import { log } from './utils/logger.js';

/**
 * Load the team config (teamai.yaml) from the team repo
 */
export async function loadTeamConfig(repoPath: string): Promise<TeamaiConfig | null> {
  const content = await readFileSafe(path.join(repoPath, 'teamai.yaml'));
  if (!content) {
    log.debug('teamai.yaml not found in repo');
    return null;
  }
  try {
    const raw = YAML.parse(content);
    return TeamaiConfigSchema.parse(raw);
  } catch (e) {
    log.error(`Invalid teamai.yaml: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Load the local config (~/.teamai/config.yaml)
 */
export async function loadLocalConfig(): Promise<LocalConfig | null> {
  const content = await readFileSafe(expandHome(TEAMAI_CONFIG_PATH));
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    return LocalConfigSchema.parse(raw);
  } catch (e) {
    log.error(`Invalid local config: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Save the local config
 */
export async function saveLocalConfig(config: LocalConfig): Promise<void> {
  await writeFile(expandHome(TEAMAI_CONFIG_PATH), YAML.stringify(config));
}

/**
 * Load the local state (~/.teamai/state.json)
 */
export async function loadState(): Promise<State> {
  const raw = await readJson<Record<string, unknown>>(expandHome(TEAMAI_STATE_PATH));
  if (!raw) return StateSchema.parse({});
  return StateSchema.parse(raw);
}

/**
 * Save the local state
 */
export async function saveState(state: State): Promise<void> {
  await writeJson(expandHome(TEAMAI_STATE_PATH), state);
}

/**
 * Require that teamai is initialized (local config exists)
 */
export async function requireInit(): Promise<{ localConfig: LocalConfig; teamConfig: TeamaiConfig }> {
  const localConfig = await loadLocalConfig();
  if (!localConfig) {
    throw new Error('teamai is not initialized. Run `teamai init` first.');
  }
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) {
    throw new Error('Team config (teamai.yaml) not found. Check your repo path.');
  }
  return { localConfig, teamConfig };
}
