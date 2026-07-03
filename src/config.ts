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
  type Scope,
  getTeamaiHome,
  getConfigPath,
  getStatePath,
} from './types.js';
import { readFileSafe, readJson, writeFile, writeJson, expandHome, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { loadRolesManifest } from './roles.js';

async function migrateLegacyRoleConfig(config: LocalConfig, configPath: string): Promise<LocalConfig> {
  if (config.primaryRole) {
    return config;
  }

  let manifest;
  try {
    manifest = await loadRolesManifest(config.repo.localPath);
  } catch {
    return config;
  }

  const haiRole = manifest.roles.find((role) => role.id === 'hai');
  if (!haiRole) {
    return config;
  }

  const migrated: LocalConfig = {
    ...config,
    primaryRole: 'hai',
    additionalRoles: config.additionalRoles ?? [],
    resourceProfileVersion: manifest.version,
  };

  await writeFile(expandHome(configPath), YAML.stringify(migrated));
  log.info('Migrated legacy teamai config to default role profile: hai');
  return migrated;
}

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
  const configPath = expandHome(TEAMAI_CONFIG_PATH);
  const content = await readFileSafe(configPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const parsed = LocalConfigSchema.parse(raw);
    return await migrateLegacyRoleConfig(parsed, configPath);
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

// ─── Scope-aware config loading ─────────────────────────

/**
 * Load a LocalConfig for a specific scope.
 * - 'user' → reads ~/.teamai/config.yaml (same as loadLocalConfig)
 * - 'project' → reads <projectRoot>/.teamai/config.yaml
 */
export async function loadLocalConfigForScope(
  scope: Scope,
  projectRoot?: string,
): Promise<LocalConfig | null> {
  const configPath = getConfigPath(scope, projectRoot);
  const content = await readFileSafe(expandHome(configPath));
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const parsed = LocalConfigSchema.parse(raw);
    // Config files written before `projectRoot` was added to the schema (or
    // hand-edited) may be missing it. We already know the project root — it's
    // the directory this config was loaded for — so backfill it instead of
    // letting getTeamaiHome()/resolveBaseDir() silently fall back to the user
    // home directory later (#85).
    const withProjectRoot = scope === 'project' && projectRoot && !parsed.projectRoot
      ? { ...parsed, projectRoot }
      : parsed;
    return await migrateLegacyRoleConfig(withProjectRoot, configPath);
  } catch (e) {
    log.error(`Invalid ${scope} config at ${configPath}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Save a LocalConfig for a specific scope.
 */
export async function saveLocalConfigForScope(
  config: LocalConfig,
  scope: Scope,
  projectRoot?: string,
): Promise<void> {
  const configPath = getConfigPath(scope, projectRoot);
  await writeFile(expandHome(configPath), YAML.stringify(config));
}

/**
 * Load state for a specific scope.
 */
export async function loadStateForScope(scope: Scope, projectRoot?: string): Promise<State> {
  const statePath = getStatePath(scope, projectRoot);
  const raw = await readJson<Record<string, unknown>>(expandHome(statePath));
  if (!raw) return StateSchema.parse({});
  return StateSchema.parse(raw);
}

/**
 * Save state for a specific scope.
 */
export async function saveStateForScope(state: State, scope: Scope, projectRoot?: string): Promise<void> {
  const statePath = getStatePath(scope, projectRoot);
  await writeJson(expandHome(statePath), state);
}

/**
 * Detect whether the given directory (default: cwd) has a project-scope teamai config.
 * Returns the parsed LocalConfig if scope === 'project', null otherwise.
 */
export async function detectProjectConfig(cwd?: string): Promise<LocalConfig | null> {
  const dir = cwd ?? process.cwd();
  const configPath = path.join(dir, '.teamai', 'config.yaml');
  if (!(await pathExists(configPath))) return null;
  const content = await readFileSafe(configPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const config = LocalConfigSchema.parse(raw);
    if (config.scope !== 'project') return null;
    // Backfill projectRoot from the directory we actually found the config
    // in, so callers never see scope === 'project' with projectRoot missing
    // (see loadLocalConfigForScope for the same backfill) (#85).
    return config.projectRoot ? config : { ...config, projectRoot: dir };
  } catch {
    return null;
  }
}

/**
 * Require init for a specific scope.
 * For 'user' scope, behaves like original requireInit.
 * For 'project' scope, loads from projectRoot.
 */
export async function requireInitForScope(
  scope: Scope,
  projectRoot?: string,
): Promise<{ localConfig: LocalConfig; teamConfig: TeamaiConfig }> {
  const localConfig = await loadLocalConfigForScope(scope, projectRoot);
  if (!localConfig) {
    throw new Error(
      scope === 'project'
        ? `teamai is not initialized in project scope at ${projectRoot}. Run \`teamai init\` first.`
        : 'teamai is not initialized. Run `teamai init` first.',
    );
  }
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) {
    throw new Error('Team config (teamai.yaml) not found. Check your repo path.');
  }
  return { localConfig, teamConfig };
}

/**
 * Auto-detect scope and return { localConfig, teamConfig }.
 * If cwd has a project-scope config, uses that; otherwise falls back to user scope.
 * This is the recommended entry point for commands that support both scopes.
 */
export async function autoDetectInit(): Promise<{ localConfig: LocalConfig; teamConfig: TeamaiConfig }> {
  const projectConfig = await detectProjectConfig();
  if (projectConfig) {
    const teamConfig = await loadTeamConfig(projectConfig.repo.localPath);
    if (!teamConfig) {
      throw new Error('Team config (teamai.yaml) not found. Check your repo path.');
    }
    return { localConfig: projectConfig, teamConfig };
  }
  return requireInit();
}
