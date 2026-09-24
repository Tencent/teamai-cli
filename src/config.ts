import YAML from 'yaml';
import { ZodError } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {
  TeamaiConfigSchema,
  LocalConfigSchema,
  StateSchema,
  getUserConfigPath,
  getUserStatePath,
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
import { getUserHome } from './utils/home.js';
import { resolvePartitionDir, writeAnchorFile } from './utils/partition.js';
import { log } from './utils/logger.js';
import { loadRolesManifest, RolesManifestNotFoundError } from './roles.js';

async function migrateLegacyRoleConfig(config: LocalConfig, configPath: string): Promise<LocalConfig> {
  if (config.primaryRole) {
    return config;
  }

  let manifest;
  try {
    manifest = await loadRolesManifest(config.repo.localPath);
  } catch (error) {
    // A repo with no manifest has nothing to migrate. A broken one must not
    // fail the load: every command loads the config, `pull` included, so the
    // member could never pull the fix. Nor may it leave the config plainly
    // role-less, which matches every role-scoped hook, MCP server and env
    // variable. The role is unknown for this run: skills fail closed in
    // resolveResourceNamespaces, and role-scoped entries reach nobody.
    if (error instanceof RolesManifestNotFoundError) return config;
    log.warn(`Legacy role migration skipped: ${(error as Error).message}`);
    return { ...config, roleUnresolved: true };
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
    log.error(`Invalid teamai.yaml: ${describeConfigError(e)}`);
    return null;
  }
}

/**
 * Load the local config (~/.teamai/config.yaml)
 */
export async function loadLocalConfig(): Promise<LocalConfig | null> {
  const configPath = expandHome(getUserConfigPath());
  const content = await readFileSafe(configPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    const parsed = LocalConfigSchema.parse(raw);
    return await migrateLegacyRoleConfig(parsed, configPath);
  } catch (e) {
    log.error(`Invalid local config: ${describeConfigError(e)}`);
    return null;
  }
}

/**
 * Serialize a LocalConfig for on-disk storage, dropping runtime-only fields.
 * `dataHome` is derived from the projectAnchor at runtime and the config file
 * lives inside that directory, so it must never be persisted (a stale absolute
 * path would defeat the anchor-derived design and break on another machine).
 * `roleUnresolved` describes one load of the roles manifest, not the member.
 */
function serializeLocalConfig(config: LocalConfig): string {
  const { dataHome: _dataHome, roleUnresolved: _roleUnresolved, ...persisted } = config;
  return YAML.stringify(persisted);
}

/**
 * Save the local config
 */
export async function saveLocalConfig(config: LocalConfig): Promise<void> {
  await writeFile(expandHome(getUserConfigPath()), serializeLocalConfig(config));
}

/**
 * Load the local state (~/.teamai/state.json)
 */
export async function loadState(): Promise<State> {
  const raw = await readJson<Record<string, unknown>>(expandHome(getUserStatePath()));
  if (!raw) return StateSchema.parse({});
  return StateSchema.parse(raw);
}

/**
 * Save the local state
 */
export async function saveState(state: State): Promise<void> {
  await writeJson(expandHome(getUserStatePath()), state);
}

/**
 * No teamai config on this machine for the scope asked: the file does not
 * exist. Its own class so a command that can work without a team (the packaged
 * skills) falls back on this and nothing else. A config file that exists but
 * cannot be parsed, validated or migrated is a plain Error naming its path.
 */
export class NotInitializedError extends Error {
  readonly name = 'NotInitializedError';
}

/** The local config and the team config it points at, as the init checks return them. */
export type TeamaiInit = { localConfig: LocalConfig; teamConfig: TeamaiConfig };

/** What to do about a config file that exists but cannot be used. */
export const BROKEN_CONFIG_ADVICE = 'Fix the file, or move it aside and run `teamai init` to write a new one.';

/**
 * Require that teamai is initialized (local config exists)
 */
export async function requireInit(): Promise<TeamaiInit> {
  const localConfig = await loadLocalConfig();
  if (!localConfig) return throwMissingOrInvalid(expandHome(getUserConfigPath()));
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return throwTeamConfigMissingOrInvalid(localConfig.repo.localPath);
  return { localConfig, teamConfig };
}

/**
 * The loaders return null both when the config file is absent and when it could
 * not be used. Only the first is "not initialized"; telling a member with a
 * broken config to re-init sends them over a real setup. The loaders log a
 * parse or validation error, but not a file that is empty or cannot be opened,
 * so those two are named here.
 */
async function throwMissingOrInvalid(configPath: string): Promise<never> {
  if (!(await pathExists(configPath))) {
    throw new NotInitializedError('teamai is not initialized. Run `teamai init` first.');
  }
  const content = await readFileSafe(configPath);
  const why = content === null ? 'the file could not be opened'
    : content.trim() === '' ? 'it is empty'
    : 'it is not a valid teamai config (the error is printed above)';
  throw new Error(`The teamai config at ${configPath} could not be read: ${why}. ${BROKEN_CONFIG_ADVICE}`);
}

/**
 * `loadTeamConfig` returns null both when teamai.yaml is absent and when it
 * could not be used (it logs a parse or validation error). Only the first is
 * "not found": "check your repo path" sends the member after a path that is
 * right.
 */
async function throwTeamConfigMissingOrInvalid(repoPath: string): Promise<never> {
  const teamConfigPath = path.join(repoPath, 'teamai.yaml');
  if (!(await pathExists(teamConfigPath))) {
    throw new Error('Team config (teamai.yaml) not found. Check your repo path.');
  }
  const content = await readFileSafe(teamConfigPath);
  const why = content === null ? 'the file could not be opened'
    : content.trim() === '' ? 'it is empty'
    : 'it is not a valid team config (the error is printed above)';
  throw new Error(`The team config at ${teamConfigPath} could not be read: ${why}. Fix it in the team repo, or ask a team admin to.`);
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
    log.error(`Invalid ${scope} config at ${configPath}: ${describeConfigError(e)}`);
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
  const dataHome = getDataHome(config);
  const configPath = path.join(dataHome, 'config.yaml');
  await writeFile(expandHome(configPath), serializeLocalConfig(config));
  // If the config lives in a project partition, drop the `anchor` reverse-lookup
  // file next to it (issue #374 P3). Previously only migration wrote it, so
  // freshly-init'd partitions had no anchor and `status --all` could not resolve
  // them back to a project path. Skip user scope (dataHome is ~/.teamai, not a
  // partition) and legacy in-repo data homes.
  try {
    if (config.scope === 'project' && config.projectRoot) {
      const partition = await resolveProjectDataHome(config.projectRoot);
      if (path.resolve(expandHome(dataHome)) === path.resolve(partition)) {
        const anchors = await resolveAnchors(config.projectRoot);
        if (anchors) await writeAnchorFile(partition, anchors.projectAnchor);
      }
    }
  } catch {
    // anchor file is a best-effort convenience for status --all; never fail a save
  }
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
  // resolvePartitionDir (not bare projectDataHome) so an install whose partition
  // predates the #546 naming widening is adopted (renamed) at init time too.
  return anchors ? resolvePartitionDir(anchors.projectAnchor) : path.join(projectRoot, '.teamai');
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

/**
 * The config that governs a directory (default: the process cwd): the project
 * teamai is set up for there, else the user scope, else null — teamai is not
 * set up here. A project config that exists but cannot be read is null too,
 * never the user scope: that project's hooks and usage must not reach the
 * user-scope team (#748). The hook dispatcher and every usage reader and writer
 * resolve through this, so they always agree on the scope. A directory that no
 * longer exists (a hook payload naming a deleted worktree) holds no project
 * config; git refuses to open it, so it is not asked.
 */
export async function resolveConfigForDir(dir?: string): Promise<LocalConfig | null> {
  const target = dir ?? process.cwd();
  if (!(await pathExists(target))) return loadLocalConfig();
  let unreadable = false;
  const project = await detectProjectConfig(target, () => { unreadable = true; });
  if (project) return project;
  return unreadable ? null : loadLocalConfig();
}

/**
 * The member's per-machine tool roots as seen from `dir`: the project config
 * governing it when it records one, else the user-scope record. A project
 * config without a record follows user scope on purpose — the same rule
 * `init` applies when it fills a project config in — because the root is a
 * fact about the machine, and a user-scope `init` may have recorded it after
 * the project was set up. Readers that hold no resolved config (the local
 * agent, import, usage tracking) go through here.
 */
export async function resolveMemberToolRoots(dir?: string): Promise<Record<string, string> | undefined> {
  // A hook can report a directory that no longer exists (a deleted worktree);
  // git probing there throws, so it means user scope — as resolveConfigForDir.
  const project = dir === undefined || await pathExists(dir) ? await detectProjectConfig(dir) : null;
  return project?.toolRoots ?? (await loadLocalConfig())?.toolRoots;
}

/**
 * Told about a project-scope config file that exists but cannot be used, which
 * detection otherwise skips: `null` means "no project config here" to every
 * caller that does not ask.
 */
export type UnreadableConfigSink = (configPath: string, error: string) => void;

export async function detectProjectConfig(cwd?: string, onUnreadable?: UnreadableConfigSink): Promise<LocalConfig | null> {
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
    // resolvePartitionDir (not bare projectDataHome): a partition written
    // before the #546 naming widening still carries the legacy
    // `<basename>-<hash>` name; adoption renames it into the current name so
    // detection — and every command after it — keeps finding the config.
    const partitionDir = await resolvePartitionDir(anchors.projectAnchor);
    const fromPartition = await readConfigFrom(partitionDir, anchors.workspaceRoot, undefined, onUnreadable);
    if (fromPartition) return fromPartition;
    // 2. No partition config yet. A workspace that declares `mode: self` self-heals
    //    on a fresh clone (issue #198): bootstrapSelfRepo now writes the machine
    //    config into the PARTITION (P2), not <workspaceRoot>/.teamai. So run the
    //    self-heal and, on success, read the config back FROM THE PARTITION.
    const healed = await selfHealAndReadPartition(anchors.workspaceRoot, partitionDir, onUnreadable);
    if (healed) return healed;
    // 3. Otherwise read a legacy `<workspaceRoot>/.teamai` config directly — a
    //    pre-P2 self install (or any un-migrated install) whose config still lives
    //    in the repo. Double-read compat until migration relocates it.
    return readConfigFrom(legacyDir, anchors.workspaceRoot, undefined, onUnreadable);
  }

  // Not a git repo: fall back to a legacy `.teamai` directly at `dir` (also runs
  // the self-heal bootstrap for a freshly-cloned single-repo project).
  return readConfigFrom(path.join(dir, '.teamai'), dir, dir, onUnreadable);
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
/**
 * Self-heal a freshly-cloned single-repo project (issue #198), then read the
 * config back from the PARTITION. bootstrapSelfRepo is a no-op ('skip') for any
 * non-self workspace, so this stays cheap on the hot path; it only writes a
 * config (into the partition, per P2) when the workspace carries a `mode: self`
 * marker and the developer's git provider is already authenticated. Returns the
 * bootstrapped config, or null when nothing was healed.
 */
async function selfHealAndReadPartition(
  workspaceRoot: string,
  partitionDir: string,
  onUnreadable?: UnreadableConfigSink,
): Promise<LocalConfig | null> {
  try {
    const { bootstrapSelfRepo } = await import('./bootstrap.js');
    const result = await bootstrapSelfRepo(workspaceRoot, { silent: true });
    if (result !== 'bootstrapped') return null;
  } catch {
    return null;
  }
  return readConfigFrom(partitionDir, workspaceRoot, undefined, onUnreadable);
}

export async function readConfigFrom(
  dataHomeDir: string,
  projectRoot: string,
  selfHealRepoRoot?: string,
  onUnreadable?: UnreadableConfigSink,
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
  if (!content) {
    // The file exists (checked above) but gave nothing: unreadable or empty.
    onUnreadable?.(configPath, 'the file is empty or could not be read');
    return null;
  }
  try {
    const raw = YAML.parse(content);
    const config = LocalConfigSchema.parse(raw);
    if (config.scope !== 'project') {
      // Run from HOME, `<cwd>/.teamai/config.yaml` is the user config itself.
      // Anywhere else a config here that is not scope: project cannot say which
      // project it serves, and detection would read past it to the user config.
      if (!isUserTeamaiDir(dataHomeDir, projectRoot)) {
        onUnreadable?.(configPath, `it is scope: ${config.scope}, but a config inside a project must be scope: project`);
      }
      return null;
    }
    // Anchor projectRoot to the workspace root (resource landing) and dataHome to
    // the directory this config lives in (machine-data location). A persisted
    // projectRoot can be wrong (e.g. a `.teamai/` copied from the main checkout
    // into a worktree names the main checkout); overriding keeps landing tied to
    // the real workspace (also backfills when absent, #85).
    const resolved: LocalConfig = { ...config, projectRoot, dataHome: dataHomeDir };
    // Self mode (P2): the config now lives in the SHARED partition, but its
    // persisted repo.localPath / businessRepoRoot name the checkout that first
    // migrated (typically main). Every worktree reads that one config, so without
    // rebinding, a feature worktree would read main's knowledge
    // (getKnowledgeDir === repo.localPath) and write it into the feature tree.
    // Self's invariant is localPath === <workspaceRoot>/.teamai and
    // businessRepoRoot === <workspaceRoot>, so re-anchor both to THIS workspace.
    // (Non-self localPath is the team-repo clone path — shared across worktrees on
    // purpose — so it is left untouched.)
    if (config.repo.kind === 'self') {
      resolved.repo = {
        ...config.repo,
        localPath: path.join(projectRoot, '.teamai'),
        businessRepoRoot: projectRoot,
      };
    }
    return resolved;
  } catch (e) {
    onUnreadable?.(configPath, describeConfigError(e));
    return null;
  }
}

/**
 * Whether `dataHomeDir` is `<HOME>/.teamai`, decided by where the project is:
 * its root is HOME. Real paths, since a tmp HOME and the cwd can differ by a
 * symlink; but never the file's target, or a project config symlinked to the
 * user config would pass for it.
 */
function isUserTeamaiDir(dataHomeDir: string, projectRoot: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.resolve(dataHomeDir) === path.join(path.resolve(projectRoot), '.teamai')
    && real(projectRoot) === real(getUserHome());
}

/**
 * One line naming what is wrong. A Zod message is a JSON dump of its issues,
 * whose first line is `[`; each issue's field and reason is what a member fixes.
 */
function describeConfigError(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The project-scope config under `cwd` that exists but cannot be read, parsed
 * or validated, with the reason, or null. Detection skips such a file and falls
 * back to the next candidate — a legacy `.teamai/`, then the user config —
 * which for a command that must know which team it serves means answering for
 * the wrong one. So a broken higher-priority file is reported even when a later
 * candidate loads.
 */
export async function findUnreadableProjectConfig(cwd?: string): Promise<string | null> {
  let problem: string | null = null;
  await detectProjectConfig(cwd, (configPath, error) => { problem ??= `${configPath}: ${error}`; });
  return problem;
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
    if (scope === 'project') {
      throw new NotInitializedError(`teamai is not initialized in project scope at ${projectRoot}. Run \`teamai init\` first.`);
    }
    return throwMissingOrInvalid(expandHome(getConfigPath(scope, projectRoot)));
  }
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return throwTeamConfigMissingOrInvalid(localConfig.repo.localPath);
  return { localConfig, teamConfig };
}

/**
 * Auto-detect scope and return { localConfig, teamConfig }.
 * If cwd has a project-scope config, uses that; otherwise falls back to user scope.
 * This is the recommended entry point for commands that support both scopes.
 */
export async function autoDetectInit(cwd?: string): Promise<TeamaiInit> {
  const projectConfig = await detectProjectConfig(cwd);
  if (projectConfig) {
    const teamConfig = await loadTeamConfig(projectConfig.repo.localPath);
    if (!teamConfig) return throwTeamConfigMissingOrInvalid(projectConfig.repo.localPath);
    return { localConfig: projectConfig, teamConfig };
  }
  return requireInit();
}
