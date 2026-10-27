import YAML from 'yaml';
import { ZodError, z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {
  TeamaiConfigSchema,
  LocalConfigSchema,
  installScopeName,
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
  MemberSettingsSchema,
  MemberWorkflowSettingsSchema,
  type MemberSettings,
  type MemberWorkflowSettings,
} from './types.js';
import { readFileSafe, readJson, writeFileAtomic, writeJsonAtomic, expandHome, pathExists } from './utils/fs.js';
import { nearestGitEntry, resolveAnchors } from './utils/git.js';
import { getUserHome } from './utils/home.js';
import { resolvePartitionDir, writeAnchorFile } from './utils/partition.js';
import { log } from './utils/logger.js';
import { listRoleIds, loadRolesManifest, RolesManifestNotFoundError } from './roles.js';
import { loadRoleAssignmentsIfPresent, resolveAssignedRoles, ROLE_ASSIGNMENTS_FILE } from './role-assignments.js';
import { warnOnce } from './utils/warn-once.js';
import { AllowSchema } from './workflow/requirements.js';

/**
 * Loads that serve a --dry-run write nothing: the legacy role migration, the
 * partition adoption and the self-mode bootstrap stay in memory.
 */
type LoadOptions = {
  dryRun?: boolean;
  /** Omit the legacy-role preview notice for a read-only load on a plain command. */
  suppressMigrationNotice?: boolean;
  /**
   * false: a single-repo clone with no config yet loads as no config, without
   * the clone-time self-heal. For `init`, which sets the project up itself.
   */
  selfHeal?: boolean;
};

async function migrateLegacyRoleConfig(
  config: LocalConfig,
  configPath: string,
  options: LoadOptions = {},
): Promise<LocalConfig> {
  const migrated = await resolveLegacyRole(config);
  if (migrated.primaryRole === config.primaryRole) return migrated;

  if (options.dryRun) {
    if (!options.suppressMigrationNotice) log.info('[dry-run] Would migrate legacy teamai config to default role profile: hai');
    return migrated;
  }
  await writeFileAtomic(expandHome(configPath), serializeLocalConfig(migrated));
  log.info('Migrated legacy teamai config to default role profile: hai');
  return migrated;
}

/** `config` with the `hai` role the team declares, when it holds no role; nothing is written. */
export async function resolveLegacyRole(config: LocalConfig): Promise<LocalConfig> {
  // The assignment overlay runs first, and an assignment already decided this
  // member's roles — holding none is one of its answers (`default: []`).
  // Migrating would persist a `hai` the team did not assign.
  if (config.primaryRole || config.roleAssignment) {
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

  return {
    ...config,
    primaryRole: 'hai',
    additionalRoles: config.additionalRoles ?? [],
    resourceProfileVersion: manifest.version,
  };
}

/**
 * The roles `manifest/members.yaml` assigns this member, overlaid on the config
 * this machine holds (#1186).
 *
 * Every reader of `primaryRole`/`additionalRoles` — pull, push, the namespace
 * filter, the hooks and env a role scopes — then sees the team's assignment
 * without knowing it was assigned, and `teamai roles set` has nothing left to
 * change. The overlay is runtime-only: `serializeLocalConfig` writes the local
 * selection back, so a save by any other command never freezes a copy of the
 * assignment into the config file.
 *
 * Absence of the file is the only case that leaves the local selection in
 * charge. A file that exists but cannot be read, or that assigns a role
 * `roles.yaml` does not declare, leaves this member with fewer roles — never
 * with the selection the file was written to take over.
 */
async function applyRoleAssignment(config: LocalConfig): Promise<LocalConfig> {
  // Idempotent: a project config passes through `readConfigFrom` and then the
  // loader that migrates it, and the second pass must not read the overlaid
  // roles as the local selection to keep.
  if (config.roleAssignment) return config;

  let assignments;
  try {
    assignments = await loadRoleAssignmentsIfPresent(config.repo.localPath, config.repo);
  } catch (error) {
    warnOnce(`${ROLE_ASSIGNMENTS_FILE} could not be read: ${(error as Error).message}`);
    warnOnce(`Roles are assigned in ${ROLE_ASSIGNMENTS_FILE} while that file exists, so this run holds none. `
      + 'Fix it in the team repo, or ask a code owner of manifest/ to.');
    return withAssignedRoles(config, [], 'default');
  }
  if (!assignments) return config;

  const { roles, source } = resolveAssignedRoles(assignments, config.username);
  return withAssignedRoles(config, await declaredRoles(config.repo.localPath, roles), source);
}

/** The assigned ids `manifest/roles.yaml` still declares, with a word about the rest. */
async function declaredRoles(repoPath: string, roles: string[]): Promise<string[]> {
  if (roles.length === 0) return roles;

  let declared: Set<string>;
  try {
    declared = new Set(listRoleIds(await loadRolesManifest(repoPath)));
  } catch (error) {
    // Without a roles manifest nothing maps an assigned id to its namespaces.
    // The id doubles as a namespace in the legacy fallback, but guessing that
    // here would deliver directories no reviewed manifest named.
    warnOnce(`${ROLE_ASSIGNMENTS_FILE} assigns ${roles.join(', ')}, but manifest/roles.yaml could not be read: `
      + `${(error as Error).message}. No role resources are delivered until it can.`);
    return [];
  }

  const unknown = roles.filter((role) => !declared.has(role));
  if (unknown.length > 0) {
    warnOnce(`${ROLE_ASSIGNMENTS_FILE} assigns ${unknown.join(', ')}, which manifest/roles.yaml does not declare. `
      + `Ignoring ${unknown.length === 1 ? 'it' : 'them'}; fix one file or the other in the team repo.`);
  }
  return roles.filter((role) => declared.has(role));
}

/** `config` with the member's own selection back in place of an overlay. */
function withLocalRoles(config: LocalConfig): LocalConfig {
  const { roleAssignment, ...local } = config;
  if (!roleAssignment) return config;
  const restored: LocalConfig = { ...local, additionalRoles: roleAssignment.local.additionalRoles };
  if (roleAssignment.local.primaryRole) restored.primaryRole = roleAssignment.local.primaryRole;
  else delete restored.primaryRole;
  return restored;
}

/** `config` with its own settings restored before a fresh machine overlay is applied. */
function withLocalMemberSettings(config: LocalConfig): LocalConfig {
  if (!config.memberSettingsOverlay) return config;
  const { memberSettingsOverlay, ...rest } = config;
  for (const key of MEMBER_SETTING_KEYS) delete (rest as Record<string, unknown>)[key];
  const restored = { ...rest, ...memberSettingsOverlay.local };
  if (restored.workflows && !restored.workflows.tools) restored.workflows.tools = {};
  return restored as LocalConfig;
}

/**
 * Refresh the runtime-only role and machine-setting overlays on a config that
 * is already in memory. `init` and `pull` both reconcile hooks, MCP and env
 * before another load occurs, so they must see the same effective member
 * settings as ordinary config readers while keeping the caller's identity.
 * A user config also takes the settings it does not set from a settings-only
 * machine file, which is a no-op once that file holds the install.
 */
export async function refreshRoleAssignment(config: LocalConfig): Promise<void> {
  let resolved = await applyRoleAssignment(withLocalRoles(withLocalMemberSettings(config)));
  if (config.roleAssignment && !resolved.roleAssignment) resolved = await resolveLegacyRole(resolved);
  if (resolved.roleAssignment) delete resolved.roleUnresolved;
  if (resolved.scope !== 'user') {
    resolved = applyMachineSettings(resolved, await loadMemberSettings());
  } else {
    // A user init promotes a settings-only machine file, and saveLocalConfig
    // keeps its settings below the in-memory ones. Rank them the same here so
    // the reconcile that follows acts on what the save writes (#1484).
    const { workflows, ...machine } = await readSettingsOnlyConfig(expandHome(getUserConfigPath()));
    resolved = { ...machine, ...(workflows ? { workflows: { ...workflows, tools: workflows.tools ?? {} } } : {}), ...resolved };
  }

  // `resolved` can alias `config` when there is no role or settings overlay.
  // Snapshot it before clearing runtime-only values; otherwise the cleanup
  // below deletes the values from both objects and Object.assign cannot restore
  // a local override such as recallEnabled: false.
  const refreshed = { ...resolved };
  for (const key of MEMBER_SETTING_KEYS) delete (config as Record<string, unknown>)[key];
  delete config.memberSettingsOverlay;
  // Role assignment is runtime-only too. Clear the old overlay before copying
  // the refreshed result, otherwise an assignment removal keeps the previous
  // role metadata on the same object even though `resolved` handed it back.
  delete config.roleAssignment;
  delete config.roleUnresolved;
  delete config.primaryRole;
  Object.assign(config, refreshed);
}

/** `roles` as this member's effective selection, primary first. */
function withAssignedRoles(config: LocalConfig, roles: string[], source: 'assigned' | 'default'): LocalConfig {
  const [primaryRole, ...additionalRoles] = roles;
  const assigned: LocalConfig = {
    ...config,
    additionalRoles,
    roleAssignment: {
      source,
      local: {
        ...(config.primaryRole ? { primaryRole: config.primaryRole } : {}),
        additionalRoles: config.additionalRoles ?? [],
      },
    },
  };
  if (primaryRole) assigned.primaryRole = primaryRole;
  else delete assigned.primaryRole;
  return assigned;
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
 * `teamai.yaml` `language` for the scope that owns `config` (#1014).
 * No config, a missing file, or a file that does not parse means no override:
 * callers keep the historical bilingual agent text.
 */
export async function loadTeamAgentLanguage(
  config: { repo: { localPath: string } } | null,
): Promise<'en' | 'zh' | undefined> {
  if (!config) return undefined;
  return (await loadTeamConfig(config.repo.localPath))?.language;
}

/**
 * Same as {@link loadTeamAgentLanguage}, resolved the way a hook finds its
 * scope: project over user, and a removed worktree keeps the scope its session
 * recorded. A lookup failure keeps the historical bilingual text.
 */
export async function loadTeamAgentLanguageForHook(
  payload: Record<string, unknown>,
  tool?: string,
): Promise<'en' | 'zh' | undefined> {
  try {
    const { resolveHookConfig } = await import('./dashboard-collector.js');
    return loadTeamAgentLanguage(await resolveHookConfig(payload, tool ?? 'claude'));
  } catch {
    return undefined;
  }
}

/**
 * Whether a config file is an install record. Member settings live in the same
 * path as the historical user install, but a file without `repo` is only a
 * machine-settings file and must not be treated as an initialized user scope.
 */
function isSettingsOnlyConfig(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    && !Object.prototype.hasOwnProperty.call(raw, 'repo');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const MEMBER_SETTING_KEYS = Object.keys(MemberSettingsSchema.shape) as Array<keyof MemberSettings>;

/** Warn about one invalid machine-level setting while still accepting its valid siblings. */
function memberSettingAt(
  raw: Record<string, unknown>,
  key: string,
  schema: z.ZodTypeAny,
  configPath: string,
  invalidValue?: unknown,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
  const parsed = schema.safeParse(raw[key]);
  if (parsed.success) return parsed.data;
  warnOnce(`Ignoring ${key} in ${configPath}: ${describeConfigError(parsed.error)}.`);
  return invalidValue;
}

/** The valid values of `workflows` in a machine file, merged by key rather than as one all-or-nothing object. */
function readMachineWorkflowSettings(raw: Record<string, unknown>, configPath: string): MemberWorkflowSettings | undefined {
  const workflow = asRecord(raw.workflows);
  if (!workflow) {
    if (Object.prototype.hasOwnProperty.call(raw, 'workflows')) {
      warnOnce(`Ignoring workflows in ${configPath}: expected an object.`);
    }
    return undefined;
  }
  const settings: Record<string, unknown> = {};
  for (const key of ['max_parallel', 'auto_approve', 'sandbox'] as const) {
    const value = memberSettingAt(workflow, key, MemberWorkflowSettingsSchema.shape[key], configPath);
    if (value !== undefined) settings[key] = value;
  }

  const tools = asRecord(workflow.tools);
  if (tools) {
    const accepted: Record<string, string> = {};
    for (const [name, value] of Object.entries(tools)) {
      const parsed = z.string().min(1).safeParse(value);
      if (parsed.success) accepted[name] = parsed.data;
      else warnOnce(`Ignoring workflows.tools.${name} in ${configPath}: ${describeConfigError(parsed.error)}.`);
    }
    if (Object.keys(accepted).length > 0) settings.tools = accepted;
  } else if (Object.prototype.hasOwnProperty.call(workflow, 'tools')) {
    warnOnce(`Ignoring workflows.tools in ${configPath}: expected an object.`);
  }

  const allow = asRecord(workflow.allow);
  if (allow) {
    const accepted: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(AllowSchema.shape)) {
      const invalidFallback = key === 'network' ? false : [];
      const value = memberSettingAt(allow, key, schema, configPath, invalidFallback);
      if (value !== undefined) accepted[key] = value;
    }
    // A malformed policy must remain restrictive. In particular, silently
    // dropping `network: "false"` would turn a deny into the default allow.
    if (Object.keys(accepted).length > 0) settings.allow = accepted;
  } else if (Object.prototype.hasOwnProperty.call(workflow, 'allow')) {
    warnOnce(`Ignoring workflows.allow in ${configPath}: expected an object.`);
    settings.allow = { network: false, env: [] };
  }

  return Object.keys(settings).length > 0 ? MemberWorkflowSettingsSchema.parse(settings) : undefined;
}

/** Read valid member settings from a machine file, whether or not it is a user-scope install. */
export async function loadMemberSettings(configPath = expandHome(getUserConfigPath())): Promise<MemberSettings> {
  const content = await readFileSafe(configPath);
  if (!content) return {};
  let raw: Record<string, unknown> | undefined;
  try {
    raw = asRecord(YAML.parse(content));
  } catch {
    return {};
  }
  if (!raw) return {};

  const settings: Record<string, unknown> = {};
  for (const key of MEMBER_SETTING_KEYS) {
    if (key === 'workflows') continue;
    const value = memberSettingAt(raw, key, MemberSettingsSchema.shape[key], configPath);
    if (value !== undefined) settings[key] = value;
  }
  const workflows = readMachineWorkflowSettings(raw, configPath);
  if (workflows !== undefined) settings.workflows = workflows;
  return MemberSettingsSchema.parse(settings);
}

/** Overlay the machine settings below a workspace/self config and remember that config's own values for a later save. */
function applyMachineSettings(config: LocalConfig, machine: MemberSettings): LocalConfig {
  if (config.scope === 'user' || config.memberSettingsOverlay) return config;
  const local = MemberSettingsSchema.parse(config);
  // `ai.tool` has a dedicated precedence reader (`aiToolSettings`) used by
  // tool-launch. Do not inject the machine copy into every workspace config;
  // keeping it in this overlay would create a second, stale reader.
  const { ai: _machineAi, ...machineWithoutAi } = machine;
  const { ai: _localAi, ...localWithoutAi } = local;
  const merged: MemberSettings = { ...machineWithoutAi, ...localWithoutAi };

  const mergedWorkflows = machine.workflows || local.workflows
    ? {
        ...machine.workflows,
        ...local.workflows,
        tools: { ...machine.workflows?.tools, ...local.workflows?.tools },
        allow: { ...machine.workflows?.allow, ...local.workflows?.allow },
      }
    : undefined;
  const workflows = mergedWorkflows
    ? { ...mergedWorkflows, tools: mergedWorkflows.tools ?? {} }
    : undefined;
  const modelAliases = machine.modelAliases || local.modelAliases
    ? { ...machine.modelAliases, ...local.modelAliases }
    : undefined;
  const effective: Partial<LocalConfig> = {
    ...merged,
    ...(workflows ? { workflows } : { workflows: undefined }),
    ...(modelAliases ? { modelAliases } : { modelAliases: undefined }),
  };
  return { ...config, ...effective, memberSettingsOverlay: { local } };
}

/** Apply the machine settings after the role overlay, at every existing config-load seam. */
async function applyConfigOverlays(config: LocalConfig): Promise<LocalConfig> {
  const assigned = await applyRoleAssignment(config);
  if (assigned.scope === 'user') return assigned;
  return applyMachineSettings(assigned, await loadMemberSettings());
}

/** Mark settings a command deliberately wrote, so a later save keeps them even when they equal a machine value. */
export function markMemberSettingsWritten(config: LocalConfig, written: MemberSettings): LocalConfig {
  const local = config.memberSettingsOverlay?.local ?? MemberSettingsSchema.parse(config);
  const workflows = local.workflows || written.workflows
    ? {
        ...local.workflows,
        ...written.workflows,
        tools: { ...local.workflows?.tools, ...written.workflows?.tools },
        allow: { ...local.workflows?.allow, ...written.workflows?.allow },
      }
    : undefined;
  return {
    ...config,
    ...written,
    ...(workflows ? { workflows: { ...workflows, tools: workflows.tools ?? {} } } : {}),
    memberSettingsOverlay: { local: { ...local, ...written, ...(workflows ? { workflows } : {}) } },
  } as LocalConfig;
}

/** Whether `configPath` holds an install. A file that cannot be read or parsed counts as one, so its install is kept. */
async function holdsInstall(configPath: string): Promise<boolean> {
  if (!(await pathExists(configPath))) return false;
  const content = await readFileSafe(configPath);
  if (content === null) return true;
  try {
    return !isSettingsOnlyConfig(YAML.parse(content));
  } catch {
    return true;
  }
}

/** Whether ~/.teamai/config.yaml holds a user-scope install, rather than nothing or only the member's settings. */
export async function hasUserScopeInstall(): Promise<boolean> {
  return holdsInstall(expandHome(getUserConfigPath()));
}

/**
 * The `ai` setting of the config file `configPath`. Only `ai` is parsed, so a file that holds no install, or one with
 * an unrelated key the full config would refuse, still sets it.
 */
async function readAiSetting(configPath: string): Promise<LocalConfig['ai']> {
  const content = await readFileSafe(configPath);
  if (!content) return undefined;
  try {
    const parsed = LocalConfigSchema.pick({ ai: true }).safeParse(YAML.parse(content));
    if (parsed.success) return parsed.data.ai;
    log.warn(`Ignoring ai in ${configPath}: ${describeConfigError(parsed.error)}. Set it as ai: { tool: <tool id> }.`);
  } catch (e) {
    log.warn(`Ignoring ai.tool: ${configPath} is not valid YAML (${describeConfigError(e)}).`);
  }
  return undefined;
}

/** `ai.tool` as one level sets it: the current scope's own config (`project`) or ~/.teamai/config.yaml (`machine`). */
export interface AiToolSetting {
  level: 'project' | 'machine';
  tool: string;
  /** The file it is set in, which a message tells the member to change. */
  file: string;
}

/**
 * The `ai.tool` settings that apply in `scope`, the project's first: its own config when it is a project, self or
 * workspace install, then ~/.teamai/config.yaml. Without a scope, or in user scope, only the machine's.
 */
export async function aiToolSettings(scope: LocalConfig | undefined): Promise<AiToolSetting[]> {
  const machine = expandHome(getUserConfigPath());
  const project = scope && scope.scope !== 'user' ? path.join(getDataHome(scope), 'config.yaml') : undefined;
  const levels = [...(project && project !== machine ? [{ level: 'project' as const, file: project }] : []), { level: 'machine' as const, file: machine }];
  const settings: AiToolSetting[] = [];
  for (const { level, file } of levels) {
    const tool = (await readAiSetting(file))?.tool;
    if (tool) settings.push({ level, tool, file });
  }
  return settings;
}

/**
 * Load the local config (~/.teamai/config.yaml). Null when it is missing, holds only the member's settings, or
 * cannot be used, which is logged.
 */
export async function loadLocalConfig(options: LoadOptions = {}): Promise<LocalConfig | null> {
  const configPath = expandHome(getUserConfigPath());
  const content = await readFileSafe(configPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    if (isSettingsOnlyConfig(raw)) return null;
    const parsed = LocalConfigSchema.parse(raw);
    return await migrateLegacyRoleConfig(await applyConfigOverlays(parsed), configPath, options);
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
 * `roleUnresolved` describes one load of the roles manifest, not the member,
 * and `children` one read of a workspace (#913).
 * The workspace scope is written under its current name, `workspace` (#1099).
 * Only a write that happens anyway uses it (a save, or the legacy role
 * migration); a plain load leaves a `scope: project` file as it is.
 */
function serializeLocalConfig(config: LocalConfig, carriedSettings?: MemberSettings): string {
  // The overlaid roles are the team's, read fresh on every load. Writing them
  // would leave a stale copy behind once the assignment changes or the file
  // goes, and a stale copy is exactly what a member must not be able to keep.
  const { dataHome: _dataHome, roleUnresolved: _roleUnresolved, children: _children, roleAssignment: _assignment, memberSettingsOverlay: overlay, ...persisted } = withLocalRoles(config);
  const localSettings = overlay?.local ?? MemberSettingsSchema.parse(persisted);
  const settings = {
    ...localSettings,
    ...(localSettings.workflows ? {
      workflows: {
        ...localSettings.workflows,
        ...(localSettings.workflows.tools ? { tools: localSettings.workflows.tools } : {}),
        ...(localSettings.workflows.allow ? { allow: localSettings.workflows.allow } : {}),
      },
    } : {}),
  };
  for (const key of MEMBER_SETTING_KEYS) delete (persisted as Record<string, unknown>)[key];
  return YAML.stringify({ ...carriedSettings, ...settings, ...persisted, scope: installScopeName(persisted.scope) });
}

/** Read valid member settings before user init promotes a machine file to an install. */
async function readSettingsOnlyConfig(configPath: string): Promise<MemberSettings> {
  const content = await readFileSafe(configPath);
  if (!content) return {};
  try {
    if (!isSettingsOnlyConfig(YAML.parse(content))) return {};
  } catch {
    return {};
  }
  return loadMemberSettings(configPath);
}

/**
 * Save the local config. User-scope init may promote a settings-only machine
 * file, so retain all of its settings rather than only the historical ai key.
 */
export async function saveLocalConfig(config: LocalConfig): Promise<void> {
  const configPath = expandHome(getUserConfigPath());
  const carriedSettings = await readSettingsOnlyConfig(configPath);
  const ai = config.ai ?? await readAiSetting(configPath);
  await writeFileAtomic(configPath, serializeLocalConfig(ai ? { ...config, ai } : config, carriedSettings));
}

/** Writes a project/local config; its own file remains an install record. */
async function writeLocalConfig(configPath: string, config: LocalConfig): Promise<void> {
  const ai = config.ai ?? await readAiSetting(configPath);
  await writeFileAtomic(configPath, serializeLocalConfig(ai ? { ...config, ai } : config));
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
  // state.json holds the pull/push bases (lastPullRev, per-checkout targets).
  // A torn in-place write reads back as parse({}) on the next run, which drops
  // every base and re-opens the stale-base overwrites #827 closed (#854).
  await writeJsonAtomic(expandHome(getUserStatePath()), state);
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
 * A problem `findUnreadableProjectConfig` (or its sink) reported, as a member
 * reads it: a parse error spans several lines (a code frame), and its first
 * names the file, the line and the column, which is what the member acts on.
 */
export function describeUnreadableConfig(problem: string): string {
  return `${problem.trim().split('\n')[0].trim().replace(/:$/, '')}. ${BROKEN_CONFIG_ADVICE}`;
}

export class UnreadableProjectConfigError extends Error {
  constructor(problem: string) {
    super(describeUnreadableConfig(problem));
    this.name = 'UnreadableProjectConfigError';
  }
}

/**
 * Require that teamai is initialized (local config exists)
 */
export async function requireInit(options: LoadOptions = {}): Promise<TeamaiInit> {
  const localConfig = await loadLocalConfig(options);
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
export async function throwMissingOrInvalid(configPath: string): Promise<never> {
  if (!(await holdsInstall(configPath))) {
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
  options: LoadOptions = {},
): Promise<LocalConfig | null> {
  if (scope === 'project') {
    if (!projectRoot) return null;
    // Reuse the single detection path so config location never drifts between
    // "detect the active project" and "load a named project's config".
    const detected = await findProjectConfig(projectRoot, undefined, options);
    if (!detected) return null;
    return migrateLegacyRoleConfig(await applyRoleAssignment(detected), path.join(getDataHome(detected), 'config.yaml'), options);
  }
  const configPath = getConfigPath(scope, projectRoot);
  const content = await readFileSafe(expandHome(configPath));
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    if (scope === 'user' && isSettingsOnlyConfig(raw)) return null;
    const parsed = LocalConfigSchema.parse(raw);
    return await migrateLegacyRoleConfig(await applyConfigOverlays(parsed), configPath, options);
  } catch (e) {
    log.error(`Invalid ${installScopeName(scope)} config at ${configPath}: ${describeConfigError(e)}`);
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
  await writeLocalConfig(expandHome(configPath), config);
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
  // Nothing in the checkout says a partition project governs it until its first
  // pull registers it, so the env loader must not give it the user env meanwhile.
  if (config.scope === 'project' && config.projectRoot) {
    const { markEnvScopePending } = await import('./resources/env-loader.js');
    await markEnvScopePending(config.projectRoot);
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
  await writeJsonAtomic(expandHome(statePath), state);
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
export async function resolveProjectDataHome(projectRoot: string, options: LoadOptions = {}): Promise<string> {
  const anchors = await resolveAnchors(projectRoot);
  // resolvePartitionDir (not bare projectDataHome) so an install whose partition
  // predates the #546 naming widening is adopted (renamed) at init time too.
  return anchors ? resolvePartitionDir(anchors.projectAnchor, options) : path.join(projectRoot, '.teamai');
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
 * never the user scope, nor a lower-priority project config that detection
 * reads after it (a legacy `.teamai/` behind a broken partition may name
 * another team): that project's hooks and usage must not reach a team it may
 * not belong to (#748). So is a directory with a `.git` entry in it or above
 * whose repository git cannot read: which project governs it is unknown, and
 * `onUnreadable` is told that `.git`. The hook dispatcher and every usage reader and writer
 * resolve through this, so they always agree on the scope. A directory that no
 * longer exists (a hook payload naming a deleted worktree) holds no project
 * config; git refuses to open it, so it is not asked. Hooks go through
 * resolveHookConfig (dashboard-collector.ts), which gives such a payload the
 * scope its session last recorded (#810). `onUnreadable` is told which file
 * could not be read, for a caller that names it.
 */
export async function resolveConfigForDir(
  dir?: string,
  onUnreadable?: UnreadableConfigSink,
  options: LoadOptions = {},
): Promise<LocalConfig | null> {
  const target = dir ?? process.cwd();
  if (!(await pathExists(target))) return loadLocalConfig(options);
  const gitEntry = await nearestGitEntry(target);
  if (gitEntry && !(await resolveAnchors(target))) {
    onUnreadable?.(gitEntry, 'git could not read this repository, so which project governs this directory is unknown. Run `git status` here to see why');
    return null;
  }
  let unreadable = false;
  const project = await detectProjectConfig(target, (configPath, error) => {
    unreadable = true;
    onUnreadable?.(configPath, error);
  }, options);
  if (unreadable) return null;
  return project ?? loadLocalConfig(options);
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
export async function resolveMemberToolRoots(
  dir?: string,
  options: LoadOptions = {},
): Promise<Record<string, string> | undefined> {
  // A hook can report a directory that no longer exists (a deleted worktree);
  // git probing there throws, so it means user scope — as resolveConfigForDir.
  const project = dir === undefined || await pathExists(dir) ? await detectProjectConfig(dir, undefined, options) : null;
  return project?.toolRoots ?? (await loadLocalConfig(options))?.toolRoots;
}

/**
 * Told about a project-scope config file that exists but cannot be used, which
 * detection otherwise skips: `null` means "no project config here" to every
 * caller that does not ask.
 */
export type UnreadableConfigSink = (configPath: string, error: string) => void;

export async function detectProjectConfig(
  cwd?: string,
  onUnreadable?: UnreadableConfigSink,
  options: LoadOptions = {},
): Promise<LocalConfig | null> {
  // `hai` is resolved in memory: many callers are metadata lookups or dry
  // runs, which must not write the config. loadLocalConfigForScope persists it.
  const found = await findProjectConfig(cwd, onUnreadable, options);
  return found && resolveLegacyRole(found);
}

async function findProjectConfig(
  cwd: string | undefined,
  onUnreadable: UnreadableConfigSink | undefined,
  options: LoadOptions,
): Promise<LocalConfig | null> {
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
    const partitionDir = await resolvePartitionDir(anchors.projectAnchor, options);
    const fromPartition = await readConfigFrom(partitionDir, anchors.workspaceRoot, undefined, onUnreadable);
    if (fromPartition) return fromPartition;
    // 2. No partition config yet. A workspace that declares `mode: self` self-heals
    //    on a fresh clone (issue #198): bootstrapSelfRepo now writes the machine
    //    config into the PARTITION (P2), not <workspaceRoot>/.teamai. So run the
    //    self-heal and, on success, read the config back FROM THE PARTITION.
    const healed = await selfHealAndReadPartition(anchors.workspaceRoot, partitionDir, onUnreadable, options);
    if (healed) return healed;
    // 3. Otherwise read a legacy `<workspaceRoot>/.teamai` config directly — a
    //    pre-P2 self install (or any un-migrated install) whose config still lives
    //    in the repo. Double-read compat until migration relocates it.
    return readConfigFrom(legacyDir, anchors.workspaceRoot, undefined, onUnreadable);
  }

  // Not a git repo: fall back to a legacy `.teamai` directly at `dir` (also runs
  // the self-heal bootstrap for a freshly-cloned single-repo project).
  return readConfigFrom(path.join(dir, '.teamai'), dir, dir, onUnreadable, options);
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
  options: LoadOptions = {},
): Promise<LocalConfig | null> {
  if (options.selfHeal === false) return null;
  if (options.dryRun) return previewSelfHeal(workspaceRoot, partitionDir, workspaceRoot);
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
  options: LoadOptions = {},
): Promise<LocalConfig | null> {
  const configPath = path.join(dataHomeDir, 'config.yaml');
  if (!(await pathExists(configPath))) {
    if (!selfHealRepoRoot || options.selfHeal === false) return null;
    if (options.dryRun) return previewSelfHeal(selfHealRepoRoot, dataHomeDir, projectRoot);
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
        onUnreadable?.(configPath, `it is scope: ${installScopeName(config.scope)}, but a config inside a workspace must be scope: workspace`);
      }
      return null;
    }
    return await applyMachineSettings(await applyRoleAssignment(anchorProjectConfig(config, dataHomeDir, projectRoot)), await loadMemberSettings());
  } catch (e) {
    onUnreadable?.(configPath, describeConfigError(e));
    return null;
  }
}

/**
 * The config a self-mode bootstrap would write for `repoRoot`, read back as
 * readConfigFrom would read it from `dataHomeDir` — for a --dry-run, which
 * previews the bootstrap instead of running it. Null when it would not run.
 */
async function previewSelfHeal(repoRoot: string, dataHomeDir: string, projectRoot: string): Promise<LocalConfig | null> {
  try {
    const { previewSelfBootstrap } = await import('./bootstrap.js');
    const config = await previewSelfBootstrap(repoRoot);
    return config ? anchorProjectConfig(LocalConfigSchema.parse(config), dataHomeDir, projectRoot) : null;
  } catch {
    return null;
  }
}

function anchorProjectConfig(config: LocalConfig, dataHomeDir: string, projectRoot: string): LocalConfig {
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
 * A scope this CLI does not know is most likely one a newer teamai wrote, as
 * `workspace` is for a CLI older than #1099, so it says how to get past it.
 */
function describeConfigError(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((issue) => {
      if (issue.code === 'invalid_enum_value' && issue.path.join('.') === 'scope') {
        return `scope "${String(issue.received)}" is not one this teamai knows; a newer teamai may have written it. Run \`teamai update\``;
      }
      return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
    }).join('; ');
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
export async function findUnreadableProjectConfig(cwd?: string, options: LoadOptions = {}): Promise<string | null> {
  let problem: string | null = null;
  await detectProjectConfig(cwd, (configPath, error) => { problem ??= `${configPath}: ${error}`; }, options);
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
      throw new NotInitializedError(`teamai is not initialized in workspace scope at ${projectRoot}. Run \`teamai init\` first.`);
    }
    return throwMissingOrInvalid(expandHome(getConfigPath(scope, projectRoot)));
  }
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return throwTeamConfigMissingOrInvalid(localConfig.repo.localPath);
  return { localConfig, teamConfig };
}

/**
 * Auto-detect scope and return { localConfig, teamConfig }.
 * If cwd has a project-scope config, uses it. If a project config exists but
 * cannot be read, throws instead of falling back to another team's config.
 * Otherwise falls back to user scope.
 * This is the recommended entry point for commands that support both scopes.
 * A workspace comes with the children set up under it (#913), so a command
 * resolves what pull delivers; `children: false` skips that walk, for a path
 * a hook runs that reads no selection.
 */
export async function autoDetectInit(cwd?: string, options: LoadOptions & { children?: boolean } = {}): Promise<TeamaiInit> {
  let unreadable: string | undefined;
  const projectConfig = await detectProjectConfig(cwd, (configPath, error) => {
    unreadable ??= `${configPath}: ${error}`;
  }, options);
  if (unreadable) throw new UnreadableProjectConfigError(unreadable);
  if (projectConfig) {
    const teamConfig = await loadTeamConfig(projectConfig.repo.localPath);
    if (!teamConfig) return throwTeamConfigMissingOrInvalid(projectConfig.repo.localPath);
    if (options.children === false) return { localConfig: projectConfig, teamConfig };
    // Loaded here: the walk reaches this module through the resolvers it imports.
    const { readWorkspaceChildren } = await import('./workspace-children.js');
    return { localConfig: await readWorkspaceChildren(projectConfig), teamConfig };
  }
  return requireInit(options);
}
