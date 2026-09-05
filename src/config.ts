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
  getDataHome,
} from './types.js';
import { readFileSafe, readJson, writeFile, writeJson, expandHome, pathExists } from './utils/fs.js';
import { resolveAnchors } from './utils/git.js';
import { projectDataHome } from './utils/partition.js';
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
 * Serialize a LocalConfig for on-disk storage, dropping runtime-only fields.
 * `dataHome` is derived from the projectAnchor at runtime and the config file
 * lives inside that directory, so it must never be persisted (a stale absolute
 * path would defeat the anchor-derived design and break on another machine).
 */
function serializeLocalConfig(config: LocalConfig): string {
  const { dataHome: _dataHome, ...persisted } = config;
  return YAML.stringify(persisted);
}

/**
 * Save the local config
 */
export async function saveLocalConfig(config: LocalConfig): Promise<void> {
  await writeFile(expandHome(TEAMAI_CONFIG_PATH), serializeLocalConfig(config));
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
 * - 'user' → reads ~/.teamai/config.yaml
 * - 'project' → partition-aware double-read via detectProjectConfig(projectRoot):
 *   tries `~/.teamai/projects/<slug>/config.yaml` (new/migrated) then the legacy
 *   `<projectRoot>/.teamai/config.yaml`, attaching dataHome + projectRoot.
 */
export async function loadLocalConfigForScope(
  scope: Scope,
  projectRoot?: string,
): Promise<LocalConfig | null> {
  if (scope === 'project') {
    if (!projectRoot) return null;
    // Reuse the single detection path so config location never drifts between
    // "detect the active project" and "load a named project's config".
    const detected = await detectProjectConfig(projectRoot);
    if (!detected) return null;
    return migrateLegacyRoleConfig(detected, path.join(getDataHome(detected), 'config.yaml'));
  }
  const configPath = getConfigPath(scope, projectRoot);
  const content = await readFileSafe(expandHome(configPath));
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const parsed = LocalConfigSchema.parse(raw);
    return await migrateLegacyRoleConfig(parsed, configPath);
  } catch (e) {
    log.error(`Invalid ${scope} config at ${configPath}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Save a LocalConfig. The file lives at `<dataHome>/config.yaml` — the partition
 * for a new project install (config.dataHome attached by detection/init), or the
 * legacy location otherwise. getDataHome resolves the right base for every mode
 * (user → ~/.teamai, project → partition ?? <projectRoot>/.teamai).
 */
export async function saveLocalConfigForScope(
  config: LocalConfig,
  _scope?: Scope,
  _projectRoot?: string,
): Promise<void> {
  const configPath = path.join(getDataHome(config), 'config.yaml');
  await writeFile(expandHome(configPath), serializeLocalConfig(config));
}

/**
 * Load state for a config (reads state.json from its data home).
 */
export async function loadStateForScope(localConfig: LocalConfig): Promise<State> {
  const statePath = getStatePath(localConfig);
  const raw = await readJson<Record<string, unknown>>(expandHome(statePath));
  if (!raw) return StateSchema.parse({});
  return StateSchema.parse(raw);
}

/**
 * Save state for a config (writes state.json into its data home).
 */
export async function saveStateForScope(state: State, localConfig: LocalConfig): Promise<void> {
  const statePath = getStatePath(localConfig);
  await writeJson(expandHome(statePath), state);
}

/**
 * Detect whether the given directory (default: cwd) has a project-scope teamai config.
 * Returns the parsed LocalConfig (with `dataHome` and `projectRoot` attached) if
 * scope === 'project', null otherwise.
 *
 * Resolution order (issue #374 P1):
 *  1. Legacy config directly at `<dir>/.teamai/config.yaml` — the fast path for
 *     an un-migrated install run from the repo root, and the self-heal bootstrap
 *     seam for single-repo mode. dataHome = `<dir>/.teamai`.
 *  2. Otherwise resolve the git anchors and try the per-project PARTITION
 *     (`~/.teamai/projects/<slug>/config.yaml`, keyed on the shared projectAnchor)
 *     — where a new/migrated install keeps its machine data out of the workspace.
 *     dataHome = the partition.
 *  3. Failing that, the repo's workspace-root `.teamai` (the subdirectory case for
 *     an un-migrated install). dataHome = `<workspaceRoot>/.teamai`.
 *
 * `dataHome` is always the directory the config was actually found in — the same
 * "anchor to where it lives" rule P0 applies to projectRoot — so every machine
 * file (state.json, search-index, env, ...) resolves beside it via getDataHome.
 */
/**
 * Resolve the machine-data home for a project given its workspace root:
 * the per-project partition (`~/.teamai/projects/<slug>/`, keyed on the shared
 * projectAnchor) when inside a git repo, else the legacy `<projectRoot>/.teamai`
 * (non-git dir). Used by init to place a NEW project's data outside the
 * workspace. Self mode does not call this (its data stays in the repo until P2).
 */
export async function resolveProjectDataHome(projectRoot: string): Promise<string> {
  const anchors = await resolveAnchors(projectRoot);
  return anchors ? projectDataHome(anchors.projectAnchor) : path.join(projectRoot, '.teamai');
}

/**
 * Resolve the machine-data home for a (scope, projectRoot) pair the SAME way
 * detection does — so subsystems that only carry `(scope, projectRoot)` (the
 * local-agent) land on the identical directory as callers that hold a full
 * LocalConfig and use `getDataHome(localConfig)`. Without this, a partitioned
 * install's reconcile side (partition) and the local-agent side (legacy) would
 * disagree on where managed-mcp.json / the resource cache live and desync.
 *
 * - user scope → `~/.teamai`
 * - project scope → the config's dataHome via detectProjectConfig's double-read
 *   (partition for a new/migrated install, else legacy `<projectRoot>/.teamai`),
 *   falling back to legacy when no config is present yet.
 */
export async function resolveDataHomeForScope(scope: Scope, projectRoot?: string): Promise<string> {
  if (scope !== 'project' || !projectRoot) return getTeamaiHome('user');
  const detected = await detectProjectConfig(projectRoot);
  if (detected) return getDataHome(detected);
  return path.join(projectRoot, '.teamai');
}

export async function detectProjectConfig(cwd?: string): Promise<LocalConfig | null> {
  const dir = cwd ?? process.cwd();

  // Resolve git anchors FIRST so the result never depends on which directory of
  // the repo we run from (issue #374 review): a repo with both a partition and a
  // legacy `.teamai/` must resolve to the SAME config whether run from the root
  // or a subdirectory. resolveAnchors returns null outside a git repo.
  const anchors = await resolveAnchors(dir);
  if (anchors) {
    const legacyDir = path.join(anchors.workspaceRoot, '.teamai');
    // Strict, cwd-independent order:
    // 1. An existing partition config is AUTHORITATIVE. It was written by a real
    //    `teamai init`, so it always wins — a mere working-tree `.teamai/teamai.yaml`
    //    (which may be untracked/unverified) must never hijack it. Switching that
    //    project to single-repo mode is `init --self`'s job (it retires the
    //    partition), not detection's.
    const fromPartition = await readConfigFrom(
      projectDataHome(anchors.projectAnchor),
      anchors.workspaceRoot,
    );
    if (fromPartition) return fromPartition;
    // 2. No partition yet: a workspace that declares `mode: self` self-heals the
    //    machine config under <workspaceRoot>/.teamai (issue #198 clone bootstrap).
    // 3. Otherwise read the legacy `<workspaceRoot>/.teamai` config directly.
    //    readConfigFrom runs the self-heal bootstrap when the config is missing,
    //    so both cases funnel through the same call.
    return readConfigFrom(legacyDir, anchors.workspaceRoot, anchors.workspaceRoot);
  }

  // Not a git repo: fall back to a legacy `.teamai` directly at `dir` (also runs
  // the self-heal bootstrap for a freshly-cloned single-repo project).
  return readConfigFrom(path.join(dir, '.teamai'), dir, dir);
}

/**
 * Read a project-scope config from `<dataHomeDir>/config.yaml`, attaching
 * `projectRoot` (the workspace root, where resources land) and `dataHome`
 * (where machine data lives). Returns null when there is no project-scope
 * config there.
 *
 * When `selfHealRepoRoot` is given and the config is missing, run the single-repo
 * self-heal (issue #198): a teammate who cloned a repo carrying
 * `.teamai/teamai.yaml` with `mode: self` has the knowledge on disk but no local
 * config (gitignored). bootstrapSelfRepo writes it under `<repoRoot>/.teamai`,
 * then we re-read. It is a no-op ('skip') for any non-self dir, so this stays
 * cheap on the hot path. Only passed for the legacy `<root>/.teamai` shape (the
 * partition is teamai-managed and never bootstrapped).
 */
async function readConfigFrom(
  dataHomeDir: string,
  projectRoot: string,
  selfHealRepoRoot?: string,
): Promise<LocalConfig | null> {
  const configPath = path.join(dataHomeDir, 'config.yaml');
  if (!(await pathExists(configPath))) {
    if (!selfHealRepoRoot) return null;
    try {
      const { bootstrapSelfRepo } = await import('./bootstrap.js');
      const result = await bootstrapSelfRepo(selfHealRepoRoot, { silent: true });
      if (result !== 'bootstrapped') return null;
    } catch {
      return null;
    }
    if (!(await pathExists(configPath))) return null;
  }
  const content = await readFileSafe(configPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const config = LocalConfigSchema.parse(raw);
    if (config.scope !== 'project') return null;
    // Anchor projectRoot to the workspace root (resource landing) and dataHome to
    // the directory this config lives in (machine-data location). A persisted
    // projectRoot can be wrong (e.g. a `.teamai/` copied from the main checkout
    // into a worktree names the main checkout); overriding keeps landing tied to
    // the real workspace (also backfills when absent, #85).
    return { ...config, projectRoot, dataHome: dataHomeDir };
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
