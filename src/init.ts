import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { readWorkspaceChildren } from './workspace-children.js';
import { hasUserScopeInstall, saveLocalConfig, loadTeamConfig, saveLocalConfigForScope, loadLocalConfigForScope, loadStateForScope, refreshRoleAssignment, saveStateForScope, resolveProjectDataHome } from './config.js';
import { codexTrustPolicy, deliveredHookFiles, describeUnappliedTeamHooks, hasTeamaiHooks, reconcileHooks, reconcileTeamHooksForConfig, reportCodexTrust, trustCodexForScope } from './hooks.js';
import { configureGitUser, resolveAnchors, initRepo, isGitRepo, getRemoteUrl, getConfiguredRemoteUrl, remotesMatch, redactGitCredentials, pullRepoFastForward, DetachedTeamRepoError, pushRepoDirectly, autoPushViaMR, gitBlockTimeoutMs, createGitWithBlockTimeout } from './utils/git.js';
import { withTimeout } from './utils/async.js';
import { getProvider, detectProvider, detectProviderForInit, RepoNotFoundError, OrganizationNotFoundError, RepoCreatePermissionError } from './providers/index.js';
import { parseGenericGitExistingRemote } from './providers/git/repo-url.js';
import { probeSelfHostedGitLab } from './providers/gitlab/probe.js';
import { ensureDir, writeFile, writeFileAtomic, pathExists, expandHome, readFileSafe, remove } from './utils/fs.js';
import { queueOwner, sameQueueOwner, setAsideQueueOnModeSwitch } from './utils/pending-learnings.js';
import { dropAllSearchIndexes } from './utils/search-index.js';
import { reportsBranch } from './utils/reports-branch.js';
import { learningsBranch } from './utils/learnings-branch.js';

/**
 * A re-init that changes the install's kind or team repository keeps the data
 * home (git and self mode share the partition, #808; #823 item 13), and what it
 * holds was written for the previous repository: set the queue aside and drop
 * the search indexes, which the new install rebuilds from its own knowledge.
 * A config that exists but cannot be read names no owner, so it counts as
 * another. `save` writes the new config.
 */
async function settleModeSwitch(previous: LocalConfig | null, next: LocalConfig, save: () => Promise<void>): Promise<void> {
  const switched = await setAsideQueueOnModeSwitch(previous, next, async () => {
    const ownerChanged = previous
      ? !sameQueueOwner(queueOwner(previous), queueOwner(next))
      : await holdsInstallFor(next.scope, path.join(getDataHome(next), 'config.yaml'));
    if (ownerChanged) await dropAllSearchIndexes(getDataHome(previous ?? next));
    await save();
  });
  if (switched.status === 'busy') {
    log.error(
      `Another teamai command is writing this project's queued learnings (${switched.lockPath} is held), ` +
        'so init did not save the new config. Run init again when it finishes.',
    );
    process.exit(1);
  }
}

/** Whether `scope`'s config file holds an install. ~/.teamai/config.yaml may hold only the member's own settings. */
async function holdsInstallFor(scope: Scope, configPath: string): Promise<boolean> {
  return scope === 'user' ? hasUserScopeInstall() : pathExists(configPath);
}

/**
 * Move a config that names another install out of the way, to a free
 * `config.yaml.previous` name beside it, before init clones the new team repo
 * where that install's clone was. If init then stops before it saves the new
 * config, no command runs the old config against the new clone (#823 item 17):
 * they all ask for `teamai init` instead. Nothing is deleted.
 */
async function moveConfigAside(configPath: string, next: LocalConfig): Promise<void> {
  let aside = `${configPath}.previous`;
  for (let n = 1; await pathExists(aside); n++) aside = `${configPath}.previous.${n}`;
  await fs.promises.rename(configPath, aside);
  log.warn(
    `Moved ${configPath} to ${aside}: it is another install's config, and init replaces its team repo with ` +
      `${redactGitCredentials(next.repo.remote)}. If init stops before it finishes, run it again.`,
  );
}

/**
 * The config {@link moveConfigAside} set aside last. An init that stopped after
 * it (a failed clone, an unknown --role) saved no config, so the rerun reads
 * this one for the settings a re-init carries forward instead of dropping them.
 */
async function loadConfigSetAside(configPath: string): Promise<LocalConfig | null> {
  let latest: string | undefined;
  for (let n = 0, aside = `${configPath}.previous`; await pathExists(aside); aside = `${configPath}.previous.${++n}`) latest = aside;
  return latest ? readConfigFile(latest) : null;
}

/** The config file at `configPath` as written: nothing a load fills in from another level. Null when it cannot be read. */
async function readConfigFile(configPath: string): Promise<LocalConfig | null> {
  try {
    return LocalConfigSchema.parse(YAML.parse(await readFileSafe(configPath) ?? ''));
  } catch (e) {
    log.debug(`Not carrying settings from ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The settings of the config file a re-init replaces that it keeps as the file had them (#1458): every key but the ones
 * init decides on each run, the install, the role and project selection, the agents and the tool roots. The tag
 * subscription and the skill exclusions name content of the team repo they were chosen from, so they are kept only
 * when the re-init stays on that repo, `remote`.
 */
function settingsReinitKeeps(file: LocalConfig | null, remote: string) {
  if (!file) return {};
  const {
    repo, username: _username, provider: _provider, scope: _scope, projectRoot: _projectRoot,
    primaryRole: _primaryRole, additionalRoles: _additionalRoles, projects: _projects, resourceProfileVersion: _version,
    inheritUserScope: _inheritUserScope, enabledAgents: _enabledAgents, disabledAgents: _disabledAgents, toolRoots: _toolRoots,
    ...settings
  } = file;
  const { subscribedTags: _subscribedTags, excludedSkills: _excludedSkills, ...anyTeamSettings } = settings;
  return remotesMatch(repo.remote, remote) ? settings : anyTeamSettings;
}
import { log, spinner } from './utils/logger.js';
import {
  CLAUDE_TOOL_ID,
  detectToolRoot,
  isAgentExcluded,
  RELOCATABLE_TOOLS,
  resolveHookScope,
  scopedToolPaths,
  toolRootRejection,
  type TeamaiConfig,
  getTeamaiHomeDir,
  REPORTS_BRANCH,
  type GlobalOptions,
  type LocalConfig,
  LocalConfigSchema,
  ProviderNameSchema,
  type ProviderName,
  type Scope,
  parseInstallScope,
  getTeamaiHome,
  getConfigPath,
  getDataHome,
  installScopeName,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { describeRoles, listRoleIds, loadRolesManifest, RolesManifestNotFoundError } from './roles.js';
import { loadRoleAssignmentsIfPresent, resolveAssignedRoles, ROLE_ASSIGNMENTS_FILE } from './role-assignments.js';
import { loadProjectsManifest, listProjectIds, type ProjectsManifest } from './projects.js';
import { memberReadRoots, readMemberConfig, mergeMemberConfig } from './members.js';
import { noDryRunPreview } from './dry-run-guard.js';
import { askQuestion, askConfirmation, askSelection, closePrompt, isInteractive, parseSelection } from './utils/prompt.js';
import {
  normalizeAgentList,
  detectHomeInstalledAgents,
  SELF_MODE_AGENT_CHOICES,
  KNOWN_AGENTS,
} from './known-agents.js';
import { TOOLS } from './tools.js';
import { describeToolHomeChange, recordToolHomes } from './tool-home-record.js';

function validAgentIds(teamConfig?: TeamaiConfig | null): string[] {
  return [...new Set([
    ...Object.keys(TOOLS),
    ...KNOWN_AGENTS.map((agent) => agent.id),
    ...Object.keys(teamConfig?.toolPaths ?? {}),
  ])].sort();
}

function unknownAgentIds(agentIds: string[], teamConfig?: TeamaiConfig | null): string[] {
  const known = new Set(validAgentIds(teamConfig));
  return agentIds.filter((id) => !known.has(id));
}

function validateGitInitAgentIds(agentIds: string[], teamConfig?: TeamaiConfig | null): boolean {
  const unknown = unknownAgentIds(agentIds, teamConfig);
  if (unknown.length === 0) return true;

  const subject = unknown.map((id) => '"' + id + '"').join(', ');
  const explanation = unknown.length === 1
    ? subject + ' is neither a built-in agent nor a key in the team\'s toolPaths in teamai.yaml.'
    : subject + ' are neither built-in agents nor keys in the team\'s toolPaths in teamai.yaml.';
  log.error(
    'Unknown --agent id' + (unknown.length === 1 ? '' : 's') + ': ' + explanation +
    ' Valid ids: ' + validAgentIds(teamConfig).join(', ') + '.',
  );
  return false;
}

function warnAboutUncheckedHttpAgentIds(agentIds: string[]): void {
  const unknown = unknownAgentIds(agentIds);
  if (unknown.length === 0) return;
  log.warn(
    'Cannot check custom --agent id(s) ' + unknown.map((id) => '"' + id + '"').join(', ') +
    ' during HTTP init because the team config is unavailable. They may be valid once the team config is available.',
  );
}

/**
 * Record each relocated tool root (every entry of `RELOCATABLE_TOOLS`, by the
 * variable it names) into the config being written, so every later run targets
 * the directory the tool reads.
 *
 * `init` is the only command that reads these variables. They live in one
 * shell profile, while teamai also runs from session hooks and from other
 * terminals; resolving them on each run would make the sync target depend on
 * who started the process. Recorded once, a root is the member's own setting
 * like `enabledAgents` — and `teamai doctor` reports it when the two drift.
 */
function recordToolRoots(localConfig: LocalConfig): void {
  for (const [tool, { label, envVar }] of Object.entries(RELOCATABLE_TOOLS)) {
    // Unset is "not this shell's business"; set-but-blank is the explicit way to
    // say the relocation is over, since nothing else can tell the two apart.
    if (process.env[envVar] === '' && localConfig.toolRoots?.[tool]) {
      delete localConfig.toolRoots[tool];
      if (Object.keys(localConfig.toolRoots).length === 0) delete localConfig.toolRoots;
      log.info(`Cleared the recorded ${label} root (${envVar} is blank); ${label} syncs to the default root again`);
      continue;
    }
    const root = detectToolRoot(tool);
    if (!root) continue;
    const rejection = toolRootRejection(root);
    if (rejection) {
      log.warn(`${envVar} (${root}) was not recorded: ${rejection}.`);
      continue;
    }
    localConfig.toolRoots = { ...localConfig.toolRoots, [tool]: root };
    log.info(`Recorded ${envVar} as the ${label} root: ${root}`);
  }
}

/**
 * A re-init that moves a tool root leaves the previous root's active config
 * live: hooks keep firing in the tool that still reads it and sync into the
 * new root — one install split across two directories — and the managed MCP
 * servers (and, for Claude Code, the gateway credentials the local agent
 * delivered) stay in files nothing should read any more. Strip them before the
 * new root is saved. Skills, rules and instruction files teamai wrote there are
 * inert copies, so they are reported, not touched. Nothing happens when the
 * root did not move, and no file is created just to be cleaned.
 */
async function releasePreviousToolRoots(
  teamConfig: TeamaiConfig | null,
  previous: LocalConfig | null,
  next: LocalConfig,
): Promise<void> {
  if (!previous || !teamConfig) return;
  const hookScope = resolveHookScope(next);
  for (const [tool, { label }] of Object.entries(RELOCATABLE_TOOLS)) {
    // A tool this member does not sync got nothing from teamai in either root.
    if (isAgentExcluded(previous, tool)) continue;
    const settingsOf = (config: LocalConfig): string | undefined =>
      scopedToolPaths(teamConfig, { ...config, scope: hookScope.scope })[tool]?.settings;
    const before = settingsOf(previous);
    if (!before || before === settingsOf(next)) continue;
    const oldSettings = path.join(hookScope.baseDir, before);
    if (await pathExists(oldSettings) && await hasTeamaiHooks(oldSettings, tool, hookScope.manifestPath)) {
      const previousRootCodexTrust = codexTrustPolicy({ codexTrustEnabled: next.codexTrustEnabled, toolRoots: previous.toolRoots });
      // With the manifest, so team hooks go too — removeHooks() alone keeps them.
      await reconcileHooks(oldSettings, tool, [], { removeAll: true, manifestPath: hookScope.manifestPath, codexTrust: previousRootCodexTrust });
    }
    if (next.scope === 'user') {
      // The user-scope MCP file and the gateway env are addressed through the
      // previous config, so they resolve to the old root (or ~/.claude.json).
      const { reconcileMcpForConfig } = await import('./mcp-reconcile.js');
      // Only this tool's file: the reconciler walks every MCP-capable tool of
      // the config it is handed, and the other tools' servers did not move.
      const toolOnly = { ...teamConfig, toolPaths: { [tool]: teamConfig.toolPaths[tool] } };
      const { changes } = await reconcileMcpForConfig(toolOnly, previous, { removeAll: true });
      const removed = changes.filter((c) => c.action === 'removed').length;
      if (removed > 0) log.info(`Removed ${removed} teamai-managed MCP server(s) from the previous ${label} root`);
      if (tool === CLAUDE_TOOL_ID) {
        const { releaseClaudeModelConfig } = await import('./local-agent.js');
        await releaseClaudeModelConfig(path.dirname(oldSettings));
      }
    }
    // No previous root on disk means nothing teamai wrote was left behind.
    if (!await pathExists(path.dirname(oldSettings))) continue;
    log.warn(
      `${label} now syncs to ${next.toolRoots?.[tool] ?? 'the default root'}; skills, rules and instruction files `
      + `that teamai wrote under ${path.dirname(oldSettings)} were left in place.`,
    );
  }
}

/** Resolve + realpath so macOS /var → /private/var (and similar) compare equal. */
function resolveRealPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function parseRoleSelection(answer: string, max: number): number[] {
  if (!answer.trim()) return [];

  const selections = answer
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => !Number.isNaN(value));

  if (selections.length === 0) {
    throw new Error('Please enter one or more role numbers, separated by commas.');
  }

  for (const selection of selections) {
    if (selection < 1 || selection > max) {
      throw new Error(`Role selection out of range. Choose numbers between 1 and ${max}.`);
    }
  }

  return [...new Set(selections)];
}

/**
 * The person did not pick a role at the prompt. Single-repo `init` treats this
 * like a repo with no manifest — the role can be set later with `teamai roles
 * set` — while every other caller lets it abort, as it always has.
 */
class NoRoleSelectedError extends Error {}

async function promptForRoleProfile(
  repo: { localPath: string; kind?: string },
  username: string,
  roleFlag?: string,
): Promise<Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'resourceProfileVersion'>> {
  const repoPath = repo.localPath;
  // The team assigns roles (#1186): there is nothing to pick, and nothing to
  // write — every load reads the assignment from the team repo.
  const assignments = await loadRoleAssignmentsIfPresent(repoPath, repo);
  if (assignments) {
    if (roleFlag) {
      throw new Error(
        `Roles are assigned in ${ROLE_ASSIGNMENTS_FILE} in the team repo, so --role cannot set one. `
        + 'Open a merge request against that file, or ask a code owner of manifest/ to.',
      );
    }
    const { roles } = resolveAssignedRoles(assignments, username);
    log.info(roles.length > 0
      ? `Roles assigned to ${username} in ${ROLE_ASSIGNMENTS_FILE}: ${roles.join(', ')}`
      : `No roles assigned to ${username} in ${ROLE_ASSIGNMENTS_FILE}; you receive shared resources only.`);
    return { additionalRoles: [] };
  }

  const manifest = await loadRolesManifest(repoPath);
  const roleLabels = describeRoles(manifest.roles);

  // If --role flag provided, resolve it directly by ID
  if (roleFlag) {
    const match = manifest.roles.find((r) => r.id === roleFlag);
    if (!match) {
      throw new Error(
        `Unknown role "${roleFlag}". Available roles: ${manifest.roles.map((r) => r.id).join(', ')}`,
      );
    }
    return {
      primaryRole: match.id,
      additionalRoles: [],
      resourceProfileVersion: manifest.version,
    };
  }

  // Auto-select when only one role is available
  if (manifest.roles.length === 1) {
    const only = manifest.roles[0];
    log.info(`Role: ${roleLabels[0]} (auto-selected)`);
    return {
      primaryRole: only.id,
      additionalRoles: [],
      resourceProfileVersion: manifest.version,
    };
  }

  log.info('Available roles:');
  roleLabels.forEach((label, index) => {
    log.info(`  ${index + 1}. ${label}`);
  });

  const primaryAnswer = await askQuestion('Primary role (number or comma-separated numbers, primary first): ').catch(() => {
    throw new Error(
      'This team repo has several roles and there is no terminal to pick one. ' +
        `Pass --role <id> (one of: ${listRoleIds(manifest).join(', ')}).`,
    );
  });
  const selectedIndexes = parseRoleSelection(primaryAnswer, manifest.roles.length);
  const [primaryIndex, ...additionalIndexes] = selectedIndexes;
  if (!primaryIndex) {
    throw new NoRoleSelectedError('A primary role is required.');
  }

  const primaryRole = manifest.roles[primaryIndex - 1];

  return {
    primaryRole: primaryRole.id,
    additionalRoles: additionalIndexes.map((index) => manifest.roles[index - 1].id),
    resourceProfileVersion: manifest.version,
  };
}

/** Reserved value for `--project`: expand to every id the manifest declares. */
export const ALL_PROJECTS_SELECTOR = 'all';

/** Dedupe while preserving order. */
function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * Resolve the active logical projects for this directory from the `--project`
 * flag. Non-interactive and non-auto: a lone project is NOT auto-activated (a
 * member may legitimately belong to no project — see issue #375 Q1). Accepts a
 * comma-separated list. Returns `{ projects: [] }` when no flag and no manifest,
 * so behavior is unchanged for teams without project partitioning.
 *
 * The literal `all` is a reserved selector (issue #509): it expands to every id
 * declared by `manifest/projects.yaml` and that snapshot is what gets persisted,
 * so a monorepo keeps a single `--project all` in its onboarding docs instead of
 * repeating the id list. It stays an EXPLICIT operator choice to activate
 * everything, project-private learnings included — it does not introduce
 * auto-activation, which the multi-project design deliberately avoids.
 */
export async function resolveActiveProjects(
  repoPath: string,
  projectFlag?: string,
): Promise<Pick<LocalConfig, 'projects'>> {
  const requested = (projectFlag ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return { projects: [] };
  }

  const manifest = await loadProjectsManifest(repoPath);
  if (!manifest) {
    throw new Error(
      `--project given but no projects manifest (manifest/projects.yaml) exists in the team repo.`,
    );
  }

  const declared = listProjectIds(manifest);

  if (requested.includes(ALL_PROJECTS_SELECTOR)) {
    // `all` already covers the rest, so a mixed list is redundant at best and a
    // typo in one of the other ids at worst — reject instead of guessing.
    if (requested.length > 1) {
      throw new Error(
        `--project "${ALL_PROJECTS_SELECTOR}" already covers every declared project; ` +
        `drop the other ids (got: ${requested.join(', ')}).`,
      );
    }

    if (declared.length === 0) {
      log.warn(
        `--project "${ALL_PROJECTS_SELECTOR}" was given but manifest/projects.yaml declares no projects; ` +
        'nothing was activated.',
      );
      return { projects: [] };
    }

    // A real project named `all` is shadowed by the selector. It is never
    // silently dropped — the expansion still covers it — but it can no longer be
    // activated on its own through this flag; `teamai projects set all` takes
    // plain ids and still selects exactly it.
    if (declared.includes(ALL_PROJECTS_SELECTOR)) {
      log.warn(
        `manifest/projects.yaml declares a project with the id "${ALL_PROJECTS_SELECTOR}", which is the ` +
        `reserved --project selector: every project is activated (that one included). To activate only it, ` +
        `run \`teamai projects set ${ALL_PROJECTS_SELECTOR}\`.`,
      );
    }

    // This is a snapshot in the manifest's own order. It needs no dedupe: the
    // manifest schema rejects duplicate ids, so listProjectIds yields each once.
    return { projects: declared };
  }

  const validIds = new Set(declared);
  for (const id of requested) {
    if (!validIds.has(id)) {
      throw new Error(
        `Unknown project "${id}". Available projects: ${[...validIds].join(', ') || '(none)'}`,
      );
    }
  }

  return { projects: dedupeIds(requested) };
}

/**
 * Resolve `init` project membership. An explicit flag always wins; otherwise an
 * interactive init offers the manifest's projects, while a blank answer or a
 * non-interactive run keeps the existing no-project default.
 */
async function resolveProjectsForInit(
  repoPath: string,
  projectFlag?: string,
  manifestOverride?: ProjectsManifest | null,
): Promise<Pick<LocalConfig, 'projects'>> {
  if (projectFlag !== undefined) return resolveActiveProjects(repoPath, projectFlag);

  const manifest = manifestOverride !== undefined ? manifestOverride : await loadProjectsManifest(repoPath);
  if (!manifest || manifest.projects.length === 0) return { projects: [] };

  log.info('Available projects:');
  manifest.projects.forEach((project, index) => {
    const name = project.name ? ` (${project.name})` : '';
    log.info(`  ${index + 1}. ${project.id}${name}`);
  });

  const answer = await askQuestion(
    'Project(s) for this directory (comma-separated numbers; press Enter for none): ',
    '',
  );
  if (!answer.trim()) {
    log.info(
      `This team repo declares projects: ${listProjectIds(manifest).join(', ')}. ` +
        'Run `teamai projects set <id>` to activate one.',
    );
    return { projects: [] };
  }

  const selected = parseSelection(answer, manifest.projects.length);
  if (!selected) {
    throw new Error(
      `Invalid project selection. Choose numbers between 1 and ${manifest.projects.length}, separated by commas, or press Enter for none.`,
    );
  }

  return { projects: selected.map((index) => manifest.projects[index].id) };
}

/**
 * Resolve init install scope from `--scope` / default.
 *
 * - Explicit `user` / `workspace` (or its older name `project`) → use as-is (`explicit: true`)
 * - Invalid value → throw
 * - Omitted → **workspace** (cwd), unless cwd === home (E1: fall back to user)
 *
 * Local install location is decided only by the CLI; remote `teamai.yaml.scope`
 * is ignored (see issue #250).
 */
export function resolveInitScope(
  rawScope: string | undefined,
  cwd: string,
  homeDir: string,
): { scope: Scope; projectRoot?: string; explicit: boolean; fallbackReason?: string } {
  const cwdResolved = resolveRealPath(cwd);
  const homeResolved = resolveRealPath(homeDir);
  const atHome = cwdResolved === homeResolved;

  if (rawScope !== undefined && rawScope !== '') {
    const scope = parseInstallScope(rawScope);
    if (scope === 'project' && atHome) {
      throw new Error(
        'Cannot use the workspace scope in your home directory (paths would collide with user scope). ' +
        'cd to a workspace directory first, or omit --scope / use --scope user.',
      );
    }
    return {
      scope,
      projectRoot: scope === 'project' ? cwdResolved : undefined,
      explicit: true,
    };
  }

  // Implicit default: project, with E1 fallback when cwd is $HOME
  if (atHome) {
    return {
      scope: 'user',
      projectRoot: undefined,
      explicit: false,
      fallbackReason:
        'cwd is your home directory; using user scope to avoid path collision with ~/.teamai',
    };
  }

  return {
    scope: 'project',
    projectRoot: cwdResolved,
    explicit: false,
  };
}

/**
 * Resolve the project-local user-scope inheritance setting.
 *
 * An omitted flag preserves an existing project setting so additive re-init
 * operations such as `init --agent` do not silently disable inheritance.
 */
export function resolveInheritUserScope(
  scope: Scope,
  requested: boolean | undefined,
  existing: boolean | undefined,
): boolean | undefined {
  if (requested === true && scope !== 'project') {
    throw new Error('--inherit-user-scope can only be used with workspace scope.');
  }
  if (scope !== 'project') return undefined;
  return requested ?? existing;
}

/**
 * Merge positional `teamai init <repo>` with `--repo` alias.
 * `--repo` is permanently kept as an equivalent alias (no deprecation warning).
 */
export function resolveInitRepo(
  positional: string | undefined,
  repoFlag: string | undefined,
): string | undefined {
  const pos = positional?.trim() || undefined;
  const flag = repoFlag?.trim() || undefined;
  if (pos && flag && pos !== flag) {
    throw new Error(
      `Conflicting repo values: positional "${pos}" vs --repo "${flag}". Pass only one.`,
    );
  }
  return pos ?? flag;
}

/**
 * Validate `init --provider`: an explicit provider that replaces auto-detection
 * (#789), so a member of a GitLab team can use plain git without a token.
 */
export function resolveInitProvider(raw: string | undefined): ProviderName | undefined {
  if (raw === undefined) return undefined;
  const parsed = ProviderNameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid --provider "${raw}". Use one of: ${ProviderNameSchema.options.join(', ')}, `
      + 'or omit --provider to detect it from the repo URL.',
    );
  }
  return parsed.data;
}

/**
 * The provider init uses for `input`: the `--provider` choice when given, else
 * auto-detection.
 */
async function selectInitProvider(input: string, forced: ProviderName | undefined): Promise<string> {
  if (!forced) return detectProviderForInit(input);
  // The GitLab API client targets GITLAB_URL or TEAMAI_GITLAB_HOST (default
  // gitlab.com), not the repo URL's host, so on an unconfigured host it would
  // send the token elsewhere.
  if (forced === 'gitlab' && detectProvider(input) === 'git') {
    throw new Error(
      '--provider gitlab needs this GitLab instance configured. Set GITLAB_URL to its base URL '
      + '(for example https://gitlab.example.com) and GITLAB_TOKEN, then run teamai init again. '
      + 'To use your existing Git authentication without a token, pass --provider git.',
    );
  }
  log.info(`Provider: ${forced} (--provider; auto-detection skipped)`);
  return forced;
}

/**
 * The provider a new teamai.yaml records for the whole team. `--provider git`
 * is one member's opt-out, so the host's provider is resolved as init would
 * without the flag. An unconfigured self-hosted GitLab stops init: recording
 * `git` there would cost every teammate automatic merge requests.
 */
async function newTeamConfigProvider(input: string, providerName: string, forced: ProviderName | undefined): Promise<string> {
  if (forced !== 'git') return providerName;
  const detected = detectProvider(input);
  if (detected !== 'git') return detected;
  const gitlab = await probeSelfHostedGitLab(input);
  if (!gitlab) return 'git';
  throw new Error(
    `Creating teamai.yaml records the team's provider, and ${gitlab.baseUrl} is a self-hosted GitLab `
    + `that is not configured. Set GITLAB_URL=${gitlab.baseUrl} and run teamai init again. `
    + '--provider git still keeps this machine on your Git authentication, without a GitLab token.',
  );
}

/** Init and later readers must agree on the repository that owns a workspace. */
async function resolveInitContext(scopeFlag: string | undefined) {
  const cwd = await fs.promises.realpath(process.cwd());
  const root = scopeFlag === 'user' ? cwd : (await resolveAnchors(cwd))?.workspaceRoot ?? cwd;
  const resolved = resolveInitScope(scopeFlag, root, getUserHome());
  const inside = resolved.scope === 'project' && resolved.projectRoot !== cwd;
  // A rejected init must not migrate roles, adopt a partition or bootstrap the ancestor.
  const existingLocalConfig = await loadLocalConfigForScope(resolved.scope, resolved.projectRoot,
    inside ? { dryRun: true, suppressMigrationNotice: true, selfHeal: false } : undefined);
  const existingFile = inside && resolved.projectRoot && (
    await pathExists(path.join(await resolveProjectDataHome(resolved.projectRoot, { dryRun: true }), 'config.yaml'))
    || await pathExists(path.join(resolved.projectRoot, '.teamai', 'config.yaml'))
  );
  if (inside && (existingLocalConfig || existingFile)) {
    throw new Error(
      `${cwd} is inside the repository ${resolved.projectRoot}, which already has a workspace config. `
      + 'A plain folder inside a repository cannot have its own config; only repositories are children of a workspace. '
      + `Run teamai init in ${resolved.projectRoot} to change that config, or make ${cwd} a repository of its own.`,
    );
  }
  return { ...resolved, existingLocalConfig };
}

function printScopeSummary(
  scope: Scope,
  projectRoot: string | undefined,
  explicit: boolean,
  configPath: string,
): void {
  const baseDir = scope === 'project' ? (projectRoot ?? process.cwd()) : getUserHome();
  log.info(`Scope: ${installScopeName(scope)}${scope === 'project' ? ` (${projectRoot})` : ''}`);
  log.info(`  config    → ${configPath}`);
  log.info(`  resources → ${baseDir}/.claude/skills, ...`);
  if (!explicit && scope === 'project') {
    log.info('  Tip: run with `--scope user` to install under your home directory (~/)');
  }
}

/** Walk up from dir looking for a `.git` entry (file or directory). */
async function isInsideGitRepo(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (;;) {
    if (await pathExists(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Git-free HTTP onboarding (issue #1). A read-only consumer only needs an API
 * key: no git auth, no clone, no member/reviewer push. Skills/rules/CLAUDE.md are
 * delivered on each session via the report/sync/ack lifecycle (the local-agent
 * bypass), not by cloning a repo.
 */
export async function initHttp(
  url: string,
  options: GlobalOptions & { scope?: string; role?: string; project?: string; agent?: string | string[]; force?: boolean; token?: string; inheritUserScope?: boolean },
): Promise<void> {
  const { resolveApiKey, saveApiKey, getApiKeyPath } = await import('./api-key.js');

  log.info('Initializing teamai (HTTP read-only consumer)...');
  const requestedAgents = normalizeAgentList(options.agent);
  warnAboutUncheckedHttpAgentIds(requestedAgents);

  // Step 0: scope (same rules as git init — default project)
  let scope: Scope;
  let projectRoot: string | undefined;
  let explicit: boolean;
  let fallbackReason: string | undefined;
  let existingLocalConfig: LocalConfig | null;
  try {
    ({ scope, projectRoot, explicit, fallbackReason, existingLocalConfig } = await resolveInitContext(options.scope));
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  let inheritUserScope: boolean | undefined;
  try {
    inheritUserScope = resolveInheritUserScope(
      scope,
      options.inheritUserScope,
      existingLocalConfig?.inheritUserScope,
    );
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (fallbackReason) {
    log.warn(fallbackReason);
  }
  const teamaiHome = scope === 'project' && projectRoot
    ? (existingLocalConfig?.dataHome ?? await resolveProjectDataHome(projectRoot))
    : getTeamaiHome(scope, projectRoot);
  printScopeSummary(scope, projectRoot, explicit, path.join(teamaiHome, 'config.yaml'));

  if (scope === 'project' && !(await isInsideGitRepo(process.cwd()))) {
    log.warn(`cwd is not inside a git repository; will create ${teamaiHome}/`);
  }

  // Re-init guard
  const existingConfigPath = path.join(teamaiHome, 'config.yaml');
  if (await holdsInstallFor(scope, existingConfigPath) && !options.force) {
    const confirmed = await askConfirmation(`teamai already initialized at ${existingConfigPath}. Overwrite? [y/N] `);
    if (!confirmed) {
      log.info('Aborted. Existing config is unchanged.');
      return;
    }
  }
  const replacedFile = existingLocalConfig && await readConfigFile(existingConfigPath);

  // Step 1: API key. Persist --token when given (one command sets endpoint+key),
  // otherwise fall back to TEAMAI_API_TOKEN / an existing ~/.teamai/apikey.
  if (options.token && options.token.trim()) {
    await saveApiKey(options.token.trim());
    log.success(`API key saved to ${getApiKeyPath()}`);
  }
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log.error('No API key found. Pass --token <key> to `teamai init --http`, or set TEAMAI_API_TOKEN.');
    process.exit(1);
  }

  // Step 2: write a minimal local teamai.yaml stub (default toolPaths) to drive
  // hook injection + the reporter. Skills/rules/CLAUDE.md are not cloned; they
  // are delivered on each session via report/sync/ack (see Step 6).
  const localPath = expandHome(path.join(teamaiHome, 'team-repo'));
  await ensureDir(localPath);
  const stubPath = path.join(localPath, 'teamai.yaml');
  if (!(await pathExists(stubPath))) {
    await writeFile(stubPath, YAML.stringify({ team: 'http-reporting', repo: url, sharing: {} }));
  }
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.error('Failed to write a valid teamai.yaml stub. Check filesystem permissions.');
    process.exit(1);
  }

  // Step 4: save local config (kind: http; only the URL is stored, never the key)
  const localConfig: LocalConfig = {
    ...settingsReinitKeeps(replacedFile, url),
    repo: { localPath, remote: url, kind: 'http', url },
    username: 'http-consumer',
    scope,
    projectRoot,
    additionalRoles: [],
    ...(scope === 'project' ? { dataHome: teamaiHome } : {}),
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };
  try {
    Object.assign(localConfig, await promptForRoleProfile(localConfig.repo, localConfig.username, options.role));
  } catch (error) {
    // Two cases leave the role unset on purpose: a repo with no roles manifest,
    // and a person who skipped the prompt. Anything else — a manifest that does
    // not parse, an unknown `--role` — must not be swallowed: a role-less config
    // matches every role when hooks are reconciled, so it would install exactly
    // the hooks the manifest restricts.
    const lenient = error instanceof RolesManifestNotFoundError || error instanceof NoRoleSelectedError;
    if (!lenient) throw error;
  }
  // The team's assignment, if it has one (#1186). This config is handed to the
  // hook, MCP and env reconciliation below before any load can overlay it, and
  // a role-less config matches every role-scoped entry. Runtime-only: the save
  // writes the member's own selection, which an assignment leaves empty.
  await refreshRoleAssignment(localConfig);
  Object.assign(localConfig, await resolveProjectsForInit(localPath, options.project));

  // Persist --agent into enabledAgents (additive across runs)
  if (requestedAgents.length > 0) {
    const existing = await loadLocalConfigForScope(scope, projectRoot);
    const prev = existing?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...requestedAgents])];
    localConfig.disabledAgents = (existing?.disabledAgents ?? []).filter((t) => !requestedAgents.includes(t));
  }

  // Carry the member's recorded tool roots across a re-init. `init` is
  // re-runnable and CLAUDE_CONFIG_DIR / CODEX_HOME live in one shell profile, so a re-init
  // from a shell that does not export it must not quietly send every later sync
  // back to the default root. recordToolRoots then overwrites a tool's
  // entry when its variable IS set.
  // A project-scope config with no record of its own starts from the user-scope
  // one: the root is a fact about this machine, and project hooks land in HOME.
  const carriedToolRoots = existingLocalConfig?.toolRoots
    ?? (scope === 'project' ? (await loadLocalConfigForScope('user'))?.toolRoots : undefined);
  if (carriedToolRoots) localConfig.toolRoots = { ...carriedToolRoots };
  recordToolRoots(localConfig);
  for (const change of await recordToolHomes('init')) log.info(describeToolHomeChange(change));
  await releasePreviousToolRoots(teamConfig, existingLocalConfig, localConfig);

  await ensureDir(teamaiHome);
  await settleModeSwitch(existingLocalConfig, localConfig, async () => {
    if (scope === 'project') {
      await saveLocalConfigForScope(localConfig, scope, projectRoot);
    } else {
      await ensureDir(getTeamaiHomeDir());
      await saveLocalConfig(localConfig);
    }
  });
  log.success(`Local config saved to ${teamaiHome}/config.yaml`);

  // Invalidate cache so the next pull does a full sync.
  try {
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // state may not exist yet
  }

  // Step 4.5: seed a custom agent's configured root before hook injection —
  // see the matching comment in the git-mode `init` path (#867).
  try {
    const { seedSelfModeToolDirs } = await import('./known-agents.js');
    const seeded = await seedSelfModeToolDirs(localConfig, teamConfig);
    if (seeded.length > 0) log.debug(`Seeded tool dirs for: ${seeded.join(', ')}`);
  } catch (e) {
    log.debug(`Tool-dir seeding skipped: ${(e as Error).message}`);
  }

  // Step 5: inject hooks (built-in dispatch incl. the reporter) via the same
  // authoritative path the git init uses, so HTTP consumers behave identically.
  const filterAgents = requestedAgents.length > 0 ? requestedAgents : undefined;
  await runInitScript(localConfig, 'preInit', options.dryRun);
  await reconcileHooksForInit(teamConfig, localConfig, filterAgents);

  // Step 6: also initialize local-agent config so the new hook-dispatch --stdin
  // path can deliver rules/claudemd (not just skills).
  const { initLocalAgentHttp } = await import('./local-agent.js');
  try {
    await initLocalAgentHttp({ endpoint: url, token: options.token, force: options.force, filterAgents });
  } catch (e) {
    log.debug(`Local agent init: ${(e as Error).message}`);
  }

  await runInitScript(localConfig, 'postInit', options.dryRun, true);

  log.success('teamai initialized (HTTP read-only)!');
  log.info('Skills/rules will auto-sync on each session start via report/sync. This team is read-only (no push).');
  closePrompt();
}

/**
 * Install the hooks for a fresh init. When the team hooks do not resolve, the
 * built-in hooks are still installed; say that the team hooks were not, so the
 * success line that follows does not claim them. Then name each installed tool
 * that gets no rules in this scope, and why (#946).
 */
async function reconcileHooksForInit(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  filterAgents: string[] | undefined,
): Promise<void> {
  let reconciled: Awaited<ReturnType<typeof reconcileTeamHooksForConfig>>;
  try {
    // A workspace's hooks include its children's, as pull delivers them (#913).
    reconciled = await reconcileTeamHooksForConfig(teamConfig, await readWorkspaceChildren(localConfig), { filterAgents });
  } catch (e) {
    // The agent hooks are in place; the rest of init still runs.
    log.error((e as Error).message);
    process.exitCode = 1;
    return;
  } finally {
    // Git-hook installation can fail after the Codex hooks were written.
    reportCodexTrust(await trustCodexForScope(teamConfig, localConfig, { filterAgents, force: true }), 'all');
  }
  if (!reconciled.ok) log.warn(describeUnappliedTeamHooks(reconciled));
  // The hooks install the extensions and plugins that add team instructions
  // for Pi, OMP and Hermes; name what keeps a tool from getting them (#945).
  try {
    const { instructionChannelProblems } = await import('./instruction-targets.js');
    for (const problem of await instructionChannelProblems(teamConfig, localConfig)) log.warn(problem);
  } catch (e) {
    log.debug(`Team instruction check skipped: ${(e as Error).message}`);
  }
  // A tool with no rules channel in this scope is told so here, not left to
  // look delivered (#946).
  const { ruleChannelNotes } = await import('./resources/rules.js');
  for (const note of await ruleChannelNotes(localConfig)) log.info(note);
}

/**
 * `scripts.preInit` or `scripts.postInit`. A non-interactive init skips them
 * (they may read the terminal). A non-zero exit does not fail init. When
 * `syncMcp` is set and the script ran, reconcile MCP so a value it collected
 * is in the tool config. Git init has no closing pull, so it syncs MCP here too.
 */
async function runInitScript(
  localConfig: LocalConfig,
  event: 'preInit' | 'postInit',
  dryRun: boolean | undefined,
  syncMcp = false,
): Promise<void> {
  if (dryRun) return;
  const { isInteractive } = await import('./utils/prompt.js');
  const { runTeamScript, syncMcpAfterPostInit } = await import('./team-scripts.js');
  const result = await runTeamScript(localConfig, event, { interactive: isInteractive(), announce: true });
  if (syncMcp && result.status === 'ran') await syncMcpAfterPostInit(localConfig);
}

/**
 * Build the .teamai/.gitignore for single-repo mode. Unlike the standalone
 * project-scope gitignore, knowledge (skills/rules/docs/learnings) is COMMITTED
 * to main here, so it must NOT be ignored.
 *
 * As of P2 (issue #374) a self install's machine data (class A1 —
 * config/state/env backup/search index/managed-mcp/resource cache) lives in the
 * per-project partition `~/.teamai/projects/<slug>/`, NOT the repo, so it does
 * not need ignoring at all. These entries are kept as belt-and-suspenders:
 *  - a pre-P2 self install still has them in the repo until migration relocates
 *    them (double-read compat window), and
 *  - should any A1 path ever fail to route to the partition, the ignore keeps it
 *    out of a commit rather than leaking (esp. plaintext env.local/token).
 * `workspaces/` is NEW here — before P2 the user-scope managed-mcp.json and the
 * per-worktree `workspaces/<id>/` tree were NOT ignored, so a self repo that ran
 * MCP reconcile or the local agent would leak them into `git status`.
 */
export function buildSelfModeGitignore(): string {
  return [
    '# teamai single-repo mode — machine-local state (never commit).',
    '# As of P2 this data lives in ~/.teamai/projects/<slug>/; these entries guard',
    '# pre-P2 installs (pre-migration) and any un-relocated path.',
    'config.yaml',
    // The temp copy an interrupted config save leaves (writeFileAtomic, #831).
    'config.yaml.*.tmp',
    'state.json',
    'token',
    'teamai.lock',
    '.update-lock',
    '.reports-lock',
    '.learnings-lock',
    '.bootstrap-lock',
    '.sync-lock',
    // NB: env/ is intentionally NOT ignored in single-repo mode — team env vars
    // (.teamai/env/env.yaml) are committed to main so `teamai push` can carry them
    // and teammates get them on clone. env.yaml holds plaintext key/value pairs, so
    // only put non-secret config there; keep real secrets out of the repo.
    'env.sh',
    // What env.sh has exported, as hashes (#879 Conflict 10).
    'env.sh.exports.json',
    // env.local is the machine-local env backup pull writes for ${VAR}
    // resolution (self mode uses this name to avoid colliding with the env/ dir).
    'env.local',
    'usage.jsonl',
    // The usage lock, a rewrite's temp copy and the events a hook records while
    // the lock is held (#788).
    'usage.jsonl.*',
    'usage.pending-*.jsonl',
    'known-skills.json',
    'search-index.json',
    'managed-mcp.json',
    // The hook index, which releases before #993 wrote here.
    'managed-hooks.json',
    // Per-worktree machine data (managed-mcp.json + the local-agent resource
    // cache). Not ignored before P2 — a real leak source in self repos.
    'workspaces/',
    'dashboard/',
    '# git worktrees for the reports and learnings orphan branches, and knowledge PRs',
    'reports-wt/',
    'learnings-wt/',
    'knowledge-wt/',
    '# contributions not published yet — machine-local until they reach the team repo',
    'pending-learnings/',
    '# report data lives on the teamai-reports orphan branch, not on main',
    'members/',
    'sessions/',
    'votes/',
    'stats/',
    'pending-review.jsonl',
    '',
    '# Knowledge (skills/, rules/, docs/, learnings/) is intentionally committed to main.',
    '',
  ].join('\n');
}

/** The `.gitignore` project-scope init writes beside its local config, once. */
export function buildProjectScopeGitignore(): string {
  return [
    '# teamai local config (do not commit)',
    'config.yaml',
    // The temp copy an interrupted config save leaves (writeFileAtomic, #831).
    'config.yaml.*.tmp',
    'state.json',
    'token',
    'teamai.lock',
    '.update-lock',
    'env',
    'env.sh',
    'env.sh.exports.json',
    'sessions/',
    'dashboard/',
    'usage.jsonl',
    'usage.jsonl.*',
    'usage.pending-*.jsonl',
    'known-skills.json',
    'learnings/',
    'search-index.json',
    'votes/',
    '',
  ].join('\n');
}

/**
 * Migrate an existing single-repo `.teamai/.gitignore` written by an older teamai.
 * Early versions ignored `env`, which hid `.teamai/env/env.yaml` from push and
 * kept it off main; later versions also predate the machine-local package lock.
 * Pure (no I/O) so it can be unit-tested.
 *
 * Removes a standalone `env` ignore line (NOT `env.sh` / `env.local` / `env/`, and
 * not commented lines), and ensures `env.local` and `teamai.lock` are ignored.
 * Returns whether anything changed plus the new content.
 */
export function migrateSelfModeGitignoreContent(content: string): { changed: boolean; content: string } {
  const lines = content.split('\n');
  let changed = false;

  // Drop a bare `env` ignore line (trimmed exact match). Keep env.sh/env.local/env/.
  const filtered = lines.filter((line) => {
    if (line.trim() === 'env') {
      changed = true;
      return false;
    }
    return true;
  });

  // Ensure an entry older files predate is present. Insert it next to the entry
  // it belongs with when that one is there, else before a trailing blank line.
  const ensure = (entry: string, anchor: string): void => {
    if (filtered.some((l) => l.trim() === entry)) return;
    const anchorIdx = filtered.findIndex((l) => l.trim() === anchor);
    const at = anchorIdx >= 0
      ? anchorIdx
      : filtered.reduce((acc, l, i) => (l.trim() ? i : acc), -1);
    filtered.splice(at + 1, 0, entry);
    changed = true;
  };

  ensure('env.local', 'env.sh');
  ensure('teamai.lock', 'token');
  // The learnings worktree and its lock arrived with the teamai-learnings branch
  // (#485). Without them a contribution shows up in the business repo's git status.
  ensure('learnings-wt/', 'reports-wt/');
  ensure('.learnings-lock', '.reports-lock');
  ensure('pending-learnings/', 'knowledge-wt/');
  // The usage lock, rewrite temps and pending events arrived with the usage cap (#788).
  ensure('usage.jsonl.*', 'usage.jsonl');
  ensure('usage.pending-*.jsonl', 'usage.jsonl.*');
  // config.yaml has been saved atomically, through a temp copy, since #831.
  ensure('config.yaml.*.tmp', 'config.yaml');
  // The hook index moved to the data home (#993); older releases wrote it here.
  ensure('managed-hooks.json', 'managed-mcp.json');

  return { changed, content: filtered.join('\n') };
}

/**
 * Self-heal an older single-repo `.teamai/.gitignore` in place (see
 * migrateSelfModeGitignoreContent). Best-effort: rewrites the ACTIVE tree's file
 * and logs a one-line hint to commit it — teamai never commits it for the user
 * here (the file is on main; the user owns that commit). No-op for non-self mode,
 * a missing file, or an already-current file. Safe to call on every pull/push.
 */
export async function migrateSelfModeGitignore(localConfig: LocalConfig): Promise<void> {
  if (localConfig.repo.kind !== 'self' || !localConfig.projectRoot) return;
  const gitignorePath = path.join(localConfig.projectRoot, '.teamai', '.gitignore');
  try {
    const current = await readFileSafe(gitignorePath);
    if (current === null) return; // no gitignore to migrate
    const { changed, content } = migrateSelfModeGitignoreContent(current);
    if (!changed) return;
    // A full disk or a kill mid-write must not leave it partial: it also ignores `token` and `env.local`.
    await writeFileAtomic(gitignorePath, content);
    log.info(
      'Updated .teamai/.gitignore for current machine-local files — '
      + 'please `git add .teamai/.gitignore` and commit it.',
    );
  } catch (e) {
    log.debug(`[self-mode] gitignore migration skipped: ${(e as Error).message}`);
  }
}

/**
 * Map an interactive selection to a concrete agent-id list. Pure (no I/O) so it
 * can be unit-tested. The picker's option order is:
 *   index 0            → "Auto" (mirror the tools detected under HOME)
 *   index 1..N         → SELF_MODE_AGENT_CHOICES[index - 1] (a specific tool)
 *
 * Picking Auto expands to `detected`; picking Auto with nothing detected falls
 * back to ['claude'] so the "clone = initialized" loop is never left with zero
 * tools. Auto and specific tools can be combined; the result is deduped in the
 * choice order (detected first, then any explicitly-picked tools).
 */
export function resolveSelfModeSelection(indices: number[], detected: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };

  const pickedAuto = indices.includes(0);
  if (pickedAuto) {
    if (detected.length > 0) detected.forEach(add);
    else add('claude'); // Auto but nothing installed → keep the guarantee.
  }
  for (const i of indices) {
    if (i === 0) continue; // Auto handled above
    const id = SELF_MODE_AGENT_CHOICES[i - 1];
    if (id) add(id);
  }
  return out;
}

/**
 * Decide which AI tools single-repo init should set up (seed skills dir, inject
 * hooks, commit their settings). Priority:
 *   1. `--agent` given → use exactly that (explicit wins, no prompt).
 *   2. Non-interactive (no TTY / --silent / --force) → mirror the tools already
 *      installed under the user's HOME; if none, return [] (create nothing).
 *   3. Interactive → multi-select. Option 1 is "Auto" (the tools detected under
 *      HOME, listed inline) and is the Enter default; options 2+ are the specific
 *      tools. Empty/cancelled falls back to Auto/[claude].
 */
export async function promptForSelfModeAgents(options: {
  agent?: string | string[];
  silent?: boolean;
  force?: boolean;
  /** Project-scope init: asks which tools the member uses here, commits nothing. */
  projectScope?: boolean;
}): Promise<string[]> {
  const explicit = normalizeAgentList(options.agent);
  if (explicit.length > 0) return explicit;

  // Non-interactive when there's no TTY, or when the caller opted out of prompts
  // (--silent / --force, matching the convention in init()): mirror HOME-installed
  // tools rather than blocking on the picker.
  if (options.silent || options.force || !isInteractive()) {
    return detectHomeInstalledAgents();
  }

  const detected = await detectHomeInstalledAgents();
  const tools = SELF_MODE_AGENT_CHOICES.map((id) => {
    const meta = KNOWN_AGENTS.find((a) => a.id === id);
    return { id, label: meta?.displayName ?? id, root: TOOLS[id].home.dir };
  });

  const detectedLabels = detected
    .map((id) => tools.find((t) => t.id === id)?.label ?? id)
    .join(', ');
  const autoLabel = detected.length > 0
    ? `Auto — the AI tools already installed here: ${detectedLabels}`
    : 'Auto — none detected (will set up Claude Code)';

  console.log('');
  if (options.projectScope) {
    console.log('Which AI tools do you use in this project?');
    console.log('(creates their tool dirs here and syncs the team\'s resources into them)');
  } else {
    console.log('Which AI tools should teamai set up in this repo?');
    console.log('(creates the skills dir, injects hooks, commits settings to main)');
  }
  console.log('');
  console.log(`  1. ${autoLabel}`);
  tools.forEach((t, i) => {
    console.log(`  ${i + 2}. ${t.label}  (${t.root})`);
  });
  console.log('');

  const optionCount = tools.length + 1; // +1 for the Auto row
  // defaultAll=false: a bare Enter returns null (not "everything"). We map Enter /
  // cancel / empty to Auto (option 1). Explicit "all" still works via the parser.
  const indices = await askSelection(
    `Select [1-${optionCount}, comma/range, or "all"] (default: 1 = Auto): `,
    optionCount,
    false,
  );
  if (!indices || indices.length === 0) {
    // Enter / cancelled → Auto.
    return resolveSelfModeSelection([0], detected);
  }
  return resolveSelfModeSelection(indices, detected);
}

/**
 * Single-repo mode init (`teamai init .` / `--self`). The current git repo IS
 * the team repo. No clone: knowledge lives on main under <repo>/.teamai/, and
 * report data (members/sessions/votes/stats) goes to the `teamai-reports` orphan
 * branch via an isolated worktree so the user's active tree is never touched.
 */
export async function initSelfRepo(options: GlobalOptions & {
  repo?: string;
  repoPositional?: string;
  provider?: ProviderName;
  role?: string;
  project?: string;
  agent?: string | string[];
  force?: boolean;
  inheritUserScope?: boolean;
  scope?: string;
}): Promise<void> {
  // No preview yet, so stop before anything (#900).
  if (options.dryRun) {
    log.error(noDryRunPreview('init'));
    process.exit(1);
    return;
  }
  // Single-repo mode always installs at project scope. Ignoring an explicit
  // --scope user would hand back a config the member did not ask for, so refuse
  // before touching the repo (#1454).
  if (options.scope === 'user') {
    log.error(
      '--scope user is not supported in single-repo mode (`teamai init --self` / `teamai init .`): '
      + 'it installs at workspace scope. Run it again without --scope user. '
      + 'For a user-scope install of this repo, write ~/.teamai/config.yaml by hand with '
      + 'scope: user, username: <you>, repo.kind: self, repo.remote: <origin URL>, '
      + 'repo.localPath: <repo>/.teamai and repo.businessRepoRoot: <repo>.',
    );
    process.exit(1);
    return;
  }

  log.info('Initializing teamai (single-repo mode)...');

  const cwd = process.cwd();

  // Step 0: single-repo mode is always project scope, rooted at the business repo.
  if (!(await isInsideGitRepo(cwd))) {
    log.error('Single-repo mode requires a git repository. Run `teamai init .` inside your project repo.');
    process.exit(1);
    return;
  }
  const businessRepoRoot = cwd;
  const teamaiHome = path.join(businessRepoRoot, '.teamai');
  const localPath = teamaiHome; // knowledge (class B) lives under <repo>/.teamai (localPath convention)
  // P2 self slimming (issue #374): machine data (class A1 — config/state/env
  // backup/search index/managed-mcp/resource cache) now lands in the per-project
  // partition, NOT the repo, so `.teamai/` keeps only committed team knowledge.
  // Attaching dataHome routes every getDataHome()-based write into the partition.
  const partitionHome = await resolveProjectDataHome(businessRepoRoot);

  // Read the existing config once, before Step 3 writes the `mode: self`
  // marker, and use this snapshot for every later step. With the marker on
  // disk and no config yet (after Step 3, or in a fresh clone), loading would
  // run the clone-time self-heal, which enables every tool found in HOME and
  // injects their hooks, so `--agent` would no longer choose the tools (#993).
  let preInitConfig: LocalConfig | null;
  let inheritUserScope: boolean | undefined;
  try {
    preInitConfig = await loadLocalConfigForScope('project', businessRepoRoot, { selfHeal: false });
    inheritUserScope = resolveInheritUserScope('project', options.inheritUserScope, preInitConfig?.inheritUserScope);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const replacedFile = preInitConfig && await readConfigFile(path.join(getDataHome(preInitConfig), 'config.yaml'));

  log.info(`Scope: workspace (${businessRepoRoot})`);
  log.info(`  knowledge → ${localPath}/{skills,rules,docs,learnings} (committed to main)`);
  log.info(`  reports   → ${REPORTS_BRANCH} orphan branch (members/sessions/votes/stats)`);

  // Re-init guard. The machine config now lives in the partition (P2), so check
  // there; also check the legacy in-repo location so re-running init on a
  // pre-P2 self install is still recognized as "already initialized".
  const existingConfigPath = path.join(partitionHome, 'config.yaml');
  const legacyConfigPath = getConfigPath('project', businessRepoRoot);
  if ((await pathExists(existingConfigPath)) || (await pathExists(legacyConfigPath))) {
    log.warn(`teamai is already initialized (workspace scope) at ${existingConfigPath}`);
    if (options.force) {
      log.info('Overwriting existing config (--force)');
    } else {
      const confirmed = await askConfirmation('Overwrite existing config? [y/N] ');
      if (!confirmed) {
        log.info('Aborted. Existing config is unchanged.');
        return;
      }
    }
  }

  // Step 1: derive provider + remote from the business repo's origin.
  const remoteUrl = await getRemoteUrl(businessRepoRoot);
  if (!remoteUrl) {
    log.error('Could not read the business repo `origin` remote. Add a remote first, then re-run `teamai init .`.');
    process.exit(1);
    return;
  }
  let providerName: string;
  try {
    providerName = await selectInitProvider(remoteUrl, options.provider);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const provider = getProvider(providerName);
  if (!options.provider) log.debug(`Detected provider: ${providerName} (from ${redactGitCredentials(remoteUrl)})`);

  let repoInfo;
  try {
    repoInfo = providerName === 'git'
      ? parseGenericGitExistingRemote(remoteUrl)
      : provider.parseRepoInput(remoteUrl);
  } catch (e) {
    log.error(`Could not parse the business repo remote "${redactGitCredentials(remoteUrl)}": ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  // Step 2: authenticate (needed to push reports + open knowledge PRs).
  await provider.ensureInstalled();
  const authSpin = (await spinner('Checking authentication...')).start();
  let username: string;
  try {
    username = await provider.authenticate();
    authSpin.succeed(`Authenticated as ${username}`);
  } catch (e) {
    authSpin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  // Step 3: build the .teamai/ knowledge skeleton on the active tree (committed to main).
  // Includes hooks/ and mcp/ too: in single-repo mode those are contributed by
  // editing .teamai/{hooks/hooks.yaml,mcp/mcp.yaml} directly and committing (they
  // don't go through `teamai push`), so seeding the dirs makes that path obvious.
  await ensureDir(localPath);
  for (const dir of ['skills', 'rules', 'docs', 'learnings', 'env', 'agents', 'hooks', 'mcp']) {
    await ensureDir(path.join(localPath, dir));
    const gitkeep = path.join(localPath, dir, '.gitkeep');
    if (!await pathExists(gitkeep)) {
      await writeFile(gitkeep, '');
    }
  }

  // teamai.yaml carries `mode: self` so teammates auto-bootstrap after clone.
  const teamaiYamlPath = path.join(localPath, 'teamai.yaml');
  if (!await pathExists(teamaiYamlPath)) {
    let teamProvider: string;
    try {
      teamProvider = await newTeamConfigProvider(remoteUrl, providerName, options.provider);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
      return;
    }
    const defaultConfig = YAML.stringify({
      team: repoInfo.repo,
      mode: 'self',
      description: 'TeamAI single-repo (knowledge on main, reports on teamai-reports)',
      repo: repoInfo.httpsUrl,
      provider: teamProvider,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: './.teamai/docs' },
        env: { injectShellProfile: true },
        // A new team keeps what teamai delivers out of git (#915).
        gitExclude: { enabled: true },
      },
    });
    await writeFile(teamaiYamlPath, defaultConfig);
    log.success('Created .teamai/teamai.yaml (mode: self)');
  }
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.error('Failed to write a valid .teamai/teamai.yaml. Check filesystem permissions.');
    process.exit(1);
    return;
  }
  if (!validateGitInitAgentIds(normalizeAgentList(options.agent), teamConfig)) {
    process.exit(1);
    return;
  }

  // Step 4: assemble local config (kind: self). dataHome points at the partition
  // so config/state and every other class-A1 write lands outside the repo (P2);
  // repo.localPath stays <repo>/.teamai — that is the class-B knowledge anchor.
  const localConfig: LocalConfig = {
    ...settingsReinitKeeps(replacedFile, repoInfo.httpsUrl),
    repo: { localPath, remote: repoInfo.httpsUrl, kind: 'self', businessRepoRoot },
    username,
    ...(options.provider ? { provider: options.provider } : {}),
    scope: 'project',
    projectRoot: businessRepoRoot,
    dataHome: partitionHome,
    additionalRoles: [],
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };
  try {
    Object.assign(localConfig, await promptForRoleProfile(localConfig.repo, localConfig.username, options.role));
  } catch (error) {
    // Two cases leave the role unset on purpose: a repo with no roles manifest,
    // and a person who skipped the prompt. Anything else — a manifest that does
    // not parse, an unknown `--role` — must not be swallowed: a role-less config
    // matches every role when hooks are reconciled, so it would install exactly
    // the hooks the manifest restricts.
    const lenient = error instanceof RolesManifestNotFoundError || error instanceof NoRoleSelectedError;
    if (!lenient) throw error;
  }
  // The team's assignment, if it has one (#1186). This config is handed to the
  // hook, MCP and env reconciliation below before any load can overlay it, and
  // a role-less config matches every role-scoped entry. Runtime-only: the save
  // writes the member's own selection, which an assignment leaves empty.
  await refreshRoleAssignment(localConfig);
  Object.assign(localConfig, await resolveProjectsForInit(localPath, options.project));
  // Which AI tools to set up in this repo (create skills dir + inject hooks +
  // commit their settings.json). Resolved from --agent, else HOME detection
  // (non-interactive), else an interactive picker. Written to enabledAgents,
  // which drives seedSelfModeToolDirs and hook injection alike.
  const selectedAgents = await promptForSelfModeAgents(options);
  if (selectedAgents.length > 0) {
    const prev = preInitConfig?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...selectedAgents])];
    localConfig.disabledAgents = (preInitConfig?.disabledAgents ?? []).filter((t) => !selectedAgents.includes(t));
  }

  // Carry the member's recorded tool roots across a re-init. `init` is
  // re-runnable and CLAUDE_CONFIG_DIR / CODEX_HOME live in one shell profile, so a re-init
  // from a shell that does not export it must not quietly send every later sync
  // back to the default root. recordToolRoots then overwrites a tool's
  // entry when its variable IS set.
  if (preInitConfig?.toolRoots) localConfig.toolRoots = { ...preInitConfig.toolRoots };
  recordToolRoots(localConfig);
  for (const change of await recordToolHomes('init')) log.info(describeToolHomeChange(change));

  // Step 5: write local config (into the partition via dataHome) + single-repo
  // gitignore. ensureDir both the knowledge dir (class B, in the repo) and the
  // partition (class A1 machine data). saveLocalConfigForScope writes through
  // getDataHome, which now resolves to the partition.
  await ensureDir(teamaiHome);
  await ensureDir(partitionHome);
  await settleModeSwitch(preInitConfig, localConfig, () =>
    saveLocalConfigForScope(localConfig, 'project', businessRepoRoot));
  log.success(`Local config saved to ${partitionHome}/config.yaml`);
  // (Pre-P2 this retired any stale partition config so detection fell back to the
  // in-repo self config. P2 makes self USE the partition, so there is nothing to
  // retire — the config we just wrote there is the authoritative one.)

  const gitignorePath = path.join(teamaiHome, '.gitignore');
  await writeFile(gitignorePath, buildSelfModeGitignore());
  log.debug('Generated single-repo .teamai/.gitignore');

  // Step 5.3: seed the selected tools' skills dir so first-run hook + skill
  // injection lands. Single-repo mode must inject into the project even on a
  // brand-new clone where no <repo>/.claude exists yet (isToolInstalled would
  // otherwise skip everything).
  const filterAgents = selectedAgents.length > 0 ? selectedAgents : undefined;
  try {
    const { seedSelfModeToolDirs } = await import('./known-agents.js');
    const seeded = await seedSelfModeToolDirs(localConfig, teamConfig);
    if (seeded.length > 0) log.debug(`Seeded tool dirs for: ${seeded.join(', ')}`);
  } catch (e) {
    log.debug(`Tool-dir seeding skipped: ${(e as Error).message}`);
  }

  // Step 5.4: inject hooks BEFORE the skeleton commit, so each selected tool's
  // settings file exists on disk and can be committed to main below. This is what
  // makes a teammate's fresh clone carry the session-start hook that triggers the
  // self-heal bootstrap — the core of "clone = initialized".
  await runInitScript(localConfig, 'preInit', options.dryRun);
  await reconcileHooksForInit(teamConfig, localConfig, filterAgents);

  // Step 5.5: commit the .teamai/ knowledge skeleton + selected tools' hook
  // settings to the current branch. Single-repo mode keeps knowledge on main, and
  // knowledge PRs branch off a base commit — a freshly `git init`'d repo has none,
  // so `teamai push` would fail. Committing here (a) seeds that base commit,
  // (b) makes `mode: self` + hooks travel with `git clone` so teammates
  // auto-bootstrap, (c) is exactly what the mode intends. We commit but never
  // push — the user pushes their business repo themselves.
  if (!options.dryRun) {
    try {
      const { commitPaths, hasCommits } = await import('./utils/git.js');
      const hadCommits = await hasCommits(businessRepoRoot);
      // Only the committable, portable knowledge parts of .teamai/. Machine-local
      // items (config.yaml, token, state.json, env, worktrees, report dirs) are
      // gitignored via buildSelfModeGitignore and must NOT be listed here — adding
      // an explicitly-gitignored path makes `git add` error out.
      const skeletonPaths = [
        '.teamai/skills', '.teamai/rules', '.teamai/docs', '.teamai/learnings', '.teamai/env',
        '.teamai/agents', '.teamai/hooks', '.teamai/mcp',
        '.teamai/teamai.yaml', '.teamai/.gitignore',
      ];
      // Each selected tool's settings file (path varies: claude/codebuddy use
      // settings.json, codex/cursor use hooks.json), resolved from toolPaths so
      // teammates get the hooks on clone. Tools without a settings path are seeded
      // (skills dir) but have nothing to commit.
      for (const id of selectedAgents) {
        const settingsPath = teamConfig.toolPaths?.[id]?.settings;
        if (settingsPath) skeletonPaths.push(settingsPath);
      }
      const committed = await commitPaths(
        businessRepoRoot,
        '[teamai] Initialize single-repo mode (skills/rules/docs/learnings skeleton)',
        skeletonPaths,
      );
      if (committed) {
        log.success(
          hadCommits
            ? 'Committed .teamai/ skeleton to the current branch'
            : 'Created initial commit with the .teamai/ skeleton',
        );
      }
    } catch (e) {
      log.warn(`Could not commit the .teamai/ skeleton (do it manually before \`teamai push\`): ${(e as Error).message}`);
    }
  }

  // Step 5.6: keep the hook files init wrote out of git while sharing.gitExclude
  // is on (#915). Self mode has no resource pull, so it syncs here, after its
  // last writer. Git-mode init does the same after it writes hooks. Dry run
  // stopped at the top.
  try {
    const { createDeliveryRecorder } = await import('./git-exclude-delivered.js');
    const { syncDeliveredGitExclude } = await import('./pull.js');
    const recorder = createDeliveryRecorder();
    for (const file of await deliveredHookFiles(teamConfig, localConfig)) recorder.report('hooks', file);
    await syncDeliveredGitExclude(localConfig, recorder);
  } catch (e) {
    log.warn(`Could not update teamai's delivered git exclude block: ${(e as Error).message}. Fix the cause, then run \`teamai pull\`.`);
  }

  // Step 6: register member on the reports orphan branch (never touches main / active tree).
  if (!options.dryRun) {
    try {
      const { updateReports } = await import('./utils/reports-branch.js');
      let isNewSelfMember = false;
      let selfMemberChanged = false;
      const result = await withTimeout(
        updateReports(localConfig, async (wt) => {
          const memberDir = path.join(wt, 'members');
          await ensureDir(memberDir);
          const memberPath = path.join(memberDir, `${username}.yaml`);
          isNewSelfMember = !await pathExists(memberPath);
          const existingSelfMember = await readMemberConfig(memberReadRoots(wt, localConfig), username);
          const merged = mergeMemberConfig(existingSelfMember, {
            username,
            projects: localConfig.projects,
          });
          selfMemberChanged = merged.changed;
          if (!merged.changed) {
            return {
              files: [],
              message: `[teamai] Update member roster: ${username}`,
            };
          }
          await writeFile(memberPath, YAML.stringify(merged.config));
          return {
            files: ['members/'],
            message: isNewSelfMember
              ? `[teamai] Register member: ${username}`
              : `[teamai] Update member roster: ${username}`,
          };
        }, { initPush: true }),
        gitBlockTimeoutMs(),
        'Member registration push',
      );
      if (result.status === 'failed') {
        log.warn(`Member registration could not be pushed: ${result.reason}. You are still set up locally. Fix the cause, then re-run the same \`teamai init\` command to retry.`);
      } else if (result.status === 'busy') {
        log.warn('Member registration skipped: another write holds the teamai-reports branch. You are still set up locally. Re-run the same `teamai init` command after it finishes.');
      } else if (selfMemberChanged) {
        log.success(isNewSelfMember
          ? 'Member registered on the teamai-reports branch'
          : 'Member roster updated on the teamai-reports branch');
      }
    } catch (e) {
      log.warn(`Member registration skipped (non-blocking): ${(e as Error).message}`);
    }
  }

  // Step 6.5: invalidate pull cache so next pull does a full sync.
  try {
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // state may not exist yet
  }

  // After the skeleton commit, so a file the script creates for this member
  // is not part of that commit. Self mode has no closing pull, so MCP is
  // reconciled here when the script ran.
  await runInitScript(localConfig, 'postInit', options.dryRun, true);

  log.success('teamai initialized (single-repo mode)!');
  log.info('Next steps:');
  log.info('  1. Add team resources by dropping them into .teamai/ (or author them in your AI tool as usual):');
  log.info('       .teamai/skills/    team skills');
  log.info('       .teamai/rules/     shared rules');
  log.info('       .teamai/agents/    subagent definitions (<name>.yaml)');
  log.info('       .teamai/env/env.yaml   shared env vars — committed to main, so keep real secrets out');
  log.info('  2. Run `teamai push` for the above — it scans .teamai/{skills,rules,agents,env} plus your AI tool dirs and opens a PR against your repo, without touching your working tree.');
  log.info('  3. docs / hooks / mcp are edited directly and shipped with a normal commit — no push needed:');
  log.info('       .teamai/docs/          team docs');
  log.info('       .teamai/hooks/hooks.yaml   team hooks');
  log.info('       .teamai/mcp/mcp.yaml       shared MCP servers');
  log.info('  4. Push your business repo (e.g. `git push -u origin HEAD`) so teammates get the .teamai/ knowledge and are auto-initialized on clone.');
  closePrompt();
}

/**
 * Tell the user a resource (organization or repo) must be created on the
 * platform's website, then let the caller exit. The CLI token often can't
 * perform these writes (e.g. CNB needs `group-manage:rw` for orgs and
 * `group-resource:rw` for repos, neither granted by the login flow), so we
 * print the create page URL and stop rather than failing obscurely.
 *
 * @param kind  human-readable resource name, e.g. "organization" or "repo"
 * @param name  the resource identifier being created (org path or owner/repo)
 * @param url   the platform's web create page, or null if none is known
 */
function guideWebCreation(kind: string, name: string, url: string | null): void {
  log.info(`${kind} "${name}" can't be created from the CLI (insufficient token permission).`);
  if (url) {
    log.info(`Create it here, then re-run this command:`);
    log.info(`  ${url}`);
  } else {
    log.info(`Create the ${kind} on the platform, then re-run this command.`);
  }
}

export async function init(options: GlobalOptions & {
  repo?: string;
  repoPositional?: string;
  scope?: string;
  role?: string;
  project?: string;
  agent?: string | string[];
  force?: boolean;
  http?: string;
  token?: string;
  inheritUserScope?: boolean;
  self?: boolean;
  provider?: string;
}): Promise<void> {
  let forcedProvider: ProviderName | undefined;
  try {
    forcedProvider = resolveInitProvider(options.provider);
    if (forcedProvider && options.http) {
      throw new Error('--provider cannot be combined with --http: an HTTP team repo has no git provider.');
    }
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (options.http) {
    return initHttp(options.http, options);
  }
  // Single-repo mode: `teamai init .` or `teamai init --self`. The current git
  // repo IS the team repo; knowledge lives on main under .teamai/, reports go to
  // the teamai-reports orphan branch. No separate team repo is cloned.
  const repoArg = (options.repoPositional ?? options.repo ?? '').trim();
  if (options.self || repoArg === '.') {
    return initSelfRepo({ ...options, provider: forcedProvider });
  }
  const requestedAgents = normalizeAgentList(options.agent);
  log.info('Initializing teamai...');

  // Step 0: Resolve scope (default project; only explicit --scope user → ~/ )
  let scope: Scope;
  let projectRoot: string | undefined;
  let explicit: boolean;
  let fallbackReason: string | undefined;
  let existingLocalConfig: LocalConfig | null;
  try {
    ({ scope, projectRoot, explicit, fallbackReason, existingLocalConfig } = await resolveInitContext(options.scope));
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const teamaiHome = scope === 'project' && projectRoot
    ? (existingLocalConfig?.dataHome ?? await resolveProjectDataHome(projectRoot))
    : getTeamaiHome(scope, projectRoot);
  const existingConfigPath = path.join(teamaiHome, 'config.yaml');
  // The settings this re-init carries forward: the live config's, or, when an
  // init stopped after moving it aside, the one it set aside (#823 item 17).
  const carriedConfig = existingLocalConfig
    ?? (await pathExists(existingConfigPath) ? null : await loadConfigSetAside(existingConfigPath));
  const replacedFile = existingLocalConfig ? await readConfigFile(existingConfigPath) : carriedConfig;
  let inheritUserScope: boolean | undefined;
  try {
    inheritUserScope = resolveInheritUserScope(
      scope,
      options.inheritUserScope,
      carriedConfig?.inheritUserScope,
    );
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (fallbackReason) {
    log.warn(fallbackReason);
  }
  printScopeSummary(scope, projectRoot, explicit, path.join(teamaiHome, 'config.yaml'));

  if (scope === 'project' && !(await isInsideGitRepo(process.cwd()))) {
    log.warn(`cwd is not inside a git repository; will create ${teamaiHome}/`);
  }

  // Step 0.5: Re-init guard — warn if config already exists
  if (await holdsInstallFor(scope, existingConfigPath)) {
    log.warn(`teamai is already initialized for ${installScopeName(scope)} scope at ${existingConfigPath}`);
    if (options.force) {
      log.info('Overwriting existing config (--force)');
    } else {
      const confirmed = await askConfirmation('Overwrite existing config? [y/N] ');
      if (!confirmed) {
        log.info('Aborted. Existing config is unchanged.');
        return;
      }
    }
  }

  // Step 1: Get repo input (positional or --repo alias; prompt if neither)
  let repoInput = '';
  try {
    repoInput = resolveInitRepo(options.repoPositional, options.repo) ?? '';
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (!repoInput) {
    // Without a terminal the prompt rejects; fall through to the error below.
    repoInput = await askQuestion(
      'Team repo (e.g. yourteam/yourproject or https://github.com/org/repo): ',
    ).catch(() => '');
  }
  if (!repoInput) {
    log.error('Repo is required. Pass it as the argument (`teamai init <owner/repo | url>`) or with --repo.');
    process.exit(1);
  }

  // Step 1b: Detect and initialize provider from URL
  let providerName: string;
  try {
    providerName = await selectInitProvider(repoInput, forcedProvider);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }
  const provider = getProvider(providerName);
  if (!forcedProvider) log.debug(`Detected provider: ${providerName}`);

  let repoInfo;
  try {
    repoInfo = provider.parseRepoInput(repoInput);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  // Step 2: Ensure provider tools are installed and authenticate
  await provider.ensureInstalled();

  const isGenericGit = provider.name === 'git';
  const authSpin = (await spinner(isGenericGit ? 'Checking Git identity...' : 'Checking authentication...')).start();
  let username: string;
  try {
    if (provider.isAuthenticated()) {
      username = await provider.authenticate();
      authSpin.succeed(isGenericGit ? `Using Git identity ${username}` : `Authenticated as ${username}`);
    } else {
      authSpin.info(isGenericGit ? 'Resolving Git identity' : 'Not logged in — starting authentication');
      username = await provider.authenticate();
      log.success(isGenericGit ? `Using Git identity ${username}` : `Authenticated as ${username}`);
    }
  } catch (e) {
    authSpin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Step 3: Clone or link repo
  const defaultLocalPath = path.join(teamaiHome, 'team-repo');
  const localPath = expandHome(defaultLocalPath);
  // The clone init uses is another install's than the config beside it, whether
  // it clones it now or reuses one an earlier init left: settle that install
  // now, as the config save below would, instead of leaving its config to run
  // against this clone should init stop first.
  let replacedInstallSettled = false;
  const settleReplacedInstall = async (): Promise<void> => {
    if (replacedInstallSettled) return;
    const next: LocalConfig = {
      repo: { localPath, remote: repoInfo.httpsUrl },
      username,
      scope,
      projectRoot,
      additionalRoles: [],
      ...(scope === 'project' ? { dataHome: teamaiHome } : {}),
    };
    const replacesAnother = existingLocalConfig
      ? !sameQueueOwner(queueOwner(existingLocalConfig), queueOwner(next))
      : await holdsInstallFor(scope, existingConfigPath);
    if (replacesAnother) await settleModeSwitch(existingLocalConfig, next, () => moveConfigAside(existingConfigPath, next));
    replacedInstallSettled = true;
  };

  if (await pathExists(localPath)) {
    if (await isGitRepo(localPath)) {
      // Reuse only when the existing clone points at the SAME repo. A leftover
      // clone from a different team repo would otherwise be reused silently,
      // surfacing the wrong roles/skills (issue: re-init against a new --repo
      // kept serving the old clone's manifest). Compare ignoring credentials,
      // protocol, and .git suffix.
      const existingRemote = await getRemoteUrl(localPath);
      // `git remote get-url` expands url.*.insteadOf. Compare the literal URL as
      // well so a rewrite does not turn a same-repository re-init into a clone
      // replacement (and consequently retire its queues and worktrees).
      const configuredRemote = await getConfiguredRemoteUrl(localPath);
      const sameRepo = [existingRemote, configuredRemote]
        .some((remote) => remote !== null && remotesMatch(remote, repoInfo.httpsUrl));
      if (existingRemote && !sameRepo) {
        log.warn(
          `Existing clone at ${localPath} points at a different repo ` +
          `(${redactGitCredentials(existingRemote)}), not ${repoInfo.httpsUrl}.`,
        );
        if (options.force) {
          log.info('Replacing it with a fresh clone (--force)');
        } else {
          const confirmed = await askConfirmation(
            'Remove it and clone the requested repo? [y/N] ',
          );
          if (!confirmed) {
            log.error(
              'Aborted. The cached clone belongs to a different repo. ' +
              `Remove ${localPath} manually or re-run with --force to replace it.`,
            );
            process.exit(1);
            return;
          }
        }
        const previous: LocalConfig = {
          ...existingLocalConfig,
          repo: { localPath, remote: existingRemote },
          username: existingLocalConfig?.username ?? username,
          scope,
          projectRoot,
          additionalRoles: existingLocalConfig?.additionalRoles ?? [],
          ...(scope === 'project' ? { dataHome: teamaiHome } : {}),
        };
        const changesOwner = !sameQueueOwner(
          queueOwner(previous),
          queueOwner({ ...previous, repo: { localPath, remote: repoInfo.httpsUrl } }),
        );
        try {
          // Hold both branch locks from inspection through removal or relocation;
          // otherwise a writer can mutate a checkout while its Git dir moves.
          await reportsBranch.withLock(previous, () => learningsBranch.withLock(previous, async () => {
            const reportsOwned = await reportsBranch.ownsCheckout(previous);
            const learningsOwned = await learningsBranch.ownsCheckout(previous);
            const ownedCheckoutIsDirty =
              (reportsOwned && await reportsBranch.isDirty(previous)) ||
              (learningsOwned && await learningsBranch.isDirty(previous));
            if (changesOwner && ownedCheckoutIsDirty) {
              await settleReplacedInstall();
              let aside = `${localPath}.previous`;
              for (let n = 1; await pathExists(aside); n++) aside = `${localPath}.previous.${n}`;
              await fs.promises.rename(localPath, aside);
              log.warn(`Kept the old clone and its uncommitted side checkout(s) at ${aside}.`);
              try {
                await createGitWithBlockTimeout(aside).raw(['worktree', 'repair']);
              } catch (e) {
                throw new Error(
                  `The old clone was kept at ${aside}, but Git could not repair its worktree links. ` +
                    `Run \`git -C ${aside} worktree repair\` to recover them before retrying init. ` +
                    `Git reported: ${(e as Error).message}`,
                  { cause: e },
                );
              }
            } else {
              // A checkout not registered to this clone belongs to an older or
              // different install. Leave it for the existing foreign-checkout
              // handling instead of blocking replacement of the current clone.
              if (reportsOwned) await reportsBranch.retireWhileLocked(previous);
              if (learningsOwned) await learningsBranch.retireWhileLocked(previous);
              await settleReplacedInstall();
              await remove(localPath);
            }
          }));
        } catch (e) {
          log.error((e as Error).message);
          process.exit(1);
          return;
        }
      } else {
        log.info(`Repo already exists at ${localPath}, using existing clone`);
        await settleReplacedInstall();
        // Refresh before resolveActiveProjects so selectors like `--project all`
        // expand against the current remote manifest, not a stale local snapshot
        // (re-running init after a new project is added would otherwise keep the
        // old project list — see PR #518 review).
        try {
          // Non-destructive refresh only: never reset --hard from init (would
          // discard local commits / tracked edits on an ordinary re-init).
          const pullResult = await pullRepoFastForward(localPath);
          if (pullResult !== 'already up to date') {
            log.info(`Refreshed existing clone (${pullResult})`);
          }
        } catch (e) {
          if (e instanceof DetachedTeamRepoError) {
            log.error(e.message);
            process.exit(1);
          }
          log.error(
            `Failed to refresh existing clone at ${localPath}: ${(e as Error).message}. ` +
            'The local clone was left unchanged. Fix network/auth or resolve ' +
            `divergence (commit/stash local edits), or remove ${localPath} manually to start fresh.`,
          );
          process.exit(1);
        }
      }
    } else {
      // The path exists but isn't a git repo — typically a leftover from a
      // previous non-git source (e.g. an HTTP repo). Reusing it would make the
      // subsequent git commands fail ("not a git repository"). Remove it so we
      // fall through to a fresh clone below.
      log.warn(`Existing ${localPath} is not a git repository, re-cloning`);
      await remove(localPath);
    }
  } else {
    log.info(`Clone path: ${localPath}`);
  }

  if (!await pathExists(localPath)) {
    await settleReplacedInstall();

    const cloneSpin = (await spinner('Cloning team repo...')).start();
    const cloneTarget = provider.name === 'git'
      ? repoInfo.httpsUrl
      : `${repoInfo.owner}/${repoInfo.repo}`;
    try {
      provider.cloneRepo(cloneTarget, localPath);
      cloneSpin.succeed('Team repo cloned');
    } catch (e) {
      if (e instanceof RepoNotFoundError) {
        cloneSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} does not exist`);
        // Before offering to create the repo, check the owning organization
        // exists. Creating a repo under a missing org fails anyway, and the CLI
        // token cannot create an org, so detect it up front and guide the user
        // to the web UI instead of a confusing create-repo failure.
        if (typeof provider.organizationExists === 'function') {
          let orgMissing = false;
          try {
            orgMissing = !provider.organizationExists(repoInfo.owner);
          } catch (checkErr) {
            // Existence couldn't be determined (network/auth) — fall through to
            // the normal create flow rather than blocking on an unknown.
            log.debug(`Organization check failed: ${(checkErr as Error).message}`);
          }
          if (orgMissing) {
            cloneSpin.info(`Organization "${repoInfo.owner}" does not exist`);
            guideWebCreation(
              'organization',
              repoInfo.owner,
              provider.getOrganizationCreateUrl?.() ?? null,
            );
            process.exit(1);
          }
        }
        const confirmed = await askConfirmation(
          `Create repo ${repoInfo.owner}/${repoInfo.repo}? [Y/n] `,
          true,
        );
        if (!confirmed) {
          log.error('Aborted. Please provide an existing repo or confirm creation.');
          process.exit(1);
        }
        const createSpin = (await spinner(`Creating repo ${repoInfo.owner}/${repoInfo.repo}...`)).start();
        try {
          await provider.createRepo(repoInfo.owner, repoInfo.repo);
          createSpin.succeed(`Repo ${repoInfo.owner}/${repoInfo.repo} created`);
        } catch (ce) {
          if (ce instanceof OrganizationNotFoundError) {
            // Reached when org existence couldn't be pre-checked (provider has no
            // check, or the check errored). Guide to the web UI and stop.
            createSpin.fail(`Organization "${ce.org}" does not exist`);
            guideWebCreation('organization', ce.org, ce.createUrl ?? null);
            process.exit(1);
          }
          if (ce instanceof RepoCreatePermissionError) {
            // The token cannot create the repo (e.g. CNB group-resource:rw).
            // Guide the user to create it in the browser instead.
            createSpin.fail(`No permission to create repo "${ce.repo}" from the CLI`);
            guideWebCreation('repo', ce.repo, ce.createUrl ?? null);
            process.exit(1);
          }
          const msg = (ce as Error).message;
          if (/already been taken|already exists/i.test(msg)) {
            // Repo already exists — not fatal; fall through to retry the clone.
            createSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} already exists, retrying clone`);
          } else {
            createSpin.fail(`Failed to create repo: ${msg}`);
            process.exit(1);
          }
        }
        // Retry clone after creation
        const retryCloneSpin = (await spinner('Cloning newly created repo...')).start();
        try {
          provider.cloneRepo(cloneTarget, localPath);
          retryCloneSpin.succeed('Team repo cloned');
        } catch (ce) {
          retryCloneSpin.fail(`Clone failed: ${(ce as Error).message}`);
          process.exit(1);
        }
      } else {
        cloneSpin.fail(`Clone failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Cloning an empty remote repo may succeed without creating the local directory.
    // Fall back to git init + add remote so subsequent steps can proceed.
    if (!await pathExists(localPath)) {
      const initSpin = (await spinner('Initializing empty repo...')).start();
      try {
        await initRepo(repoInfo.httpsUrl, localPath);
        initSpin.succeed('Empty repo initialized');
      } catch (e) {
        initSpin.fail(`Init failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  // Step 3.5: Configure git user for the team repo
  const emailDomain = provider.getDefaultEmailDomain() ?? undefined;
  await configureGitUser(localPath, username, username, undefined, emailDomain);

  // Step 4: Load team config
  // Remote teamai.yaml.scope (if present) is ignored — local install location
  // is decided only by --scope / default (issue #250).
  const teamConfig = await loadTeamConfig(localPath);
  if (!validateGitInitAgentIds(requestedAgents, teamConfig)) {
    process.exit(1);
    return;
  }
  const createdSkeleton = !teamConfig;
  if (!teamConfig) {
    log.warn('teamai.yaml not found in repo. Creating default config...');
    let teamProvider: string;
    try {
      teamProvider = await newTeamConfigProvider(repoInput, providerName, forcedProvider);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
      return;
    }
    const defaultConfig = YAML.stringify({
      team: 'my-team',
      description: 'TeamAI shared resources',
      repo: repoInfo.httpsUrl,
      provider: teamProvider,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: scope === 'project' ? './.teamai/docs' : '~/.teamai/docs' },
        env: { injectShellProfile: true },
        // A new team keeps what teamai delivers out of git (#915).
        gitExclude: { enabled: true },
      },
    });
    await writeFile(path.join(localPath, 'teamai.yaml'), defaultConfig);

    // Knowledge-tree skeleton on the default branch so an empty remote has a
    // committable HEAD. Member YAML files go to teamai-reports, not here.
    for (const dir of ['members', 'skills', 'rules', 'docs', 'env']) {
      await ensureDir(path.join(localPath, dir));
      const gitkeep = path.join(localPath, dir, '.gitkeep');
      if (!await pathExists(gitkeep)) {
        await writeFile(gitkeep, '');
      }
    }
  }

  // Resolve projects before member registration so the reports branch records
  // the same selection as the local config. Only prompt for a role early when a
  // project picker will follow it; otherwise keep the existing prompt order.
  let roleProfile: Awaited<ReturnType<typeof promptForRoleProfile>> | undefined;
  let rolePromptedEarly = false;
  let projectsManifest: ProjectsManifest | null | undefined;
  if (options.project === undefined) {
    try {
      projectsManifest = await loadProjectsManifest(localPath);
    } catch (error) {
      log.error((error as Error).message);
      process.exit(1);
    }
  }
  if (projectsManifest?.projects.length) {
    rolePromptedEarly = true;
    try {
      roleProfile = await promptForRoleProfile({ localPath }, username, options.role);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('Roles manifest not found')) {
        log.debug('No roles manifest found — skipping role selection');
      } else {
        log.error(msg);
        process.exit(1);
      }
    }
  }

  let resolvedProjects: string[] = [];
  try {
    resolvedProjects = (await resolveProjectsForInit(localPath, options.project, projectsManifest)).projects ?? [];
  } catch (error) {
    // A bad --project is a user error on the main init path: fail loudly.
    log.error((error as Error).message);
    process.exit(1);
  }

  const reportsConfig: LocalConfig = {
    repo: { localPath, remote: repoInfo.httpsUrl },
    username,
    scope,
    projectRoot,
    additionalRoles: [],
  };

  // Empty-repo exception: a one-time skeleton push of teamai.yaml + gitkeeps may
  // still land on the default branch so the knowledge tree exists. Member files
  // after that go to teamai-reports.
  if (createdSkeleton && !options.dryRun) {
    try {
      await withTimeout(
        pushRepoDirectly(localPath, '[teamai] Initialize team repo skeleton', [
          'teamai.yaml',
          'skills/.gitkeep',
          'rules/.gitkeep',
          'docs/.gitkeep',
          'env/.gitkeep',
          'members/.gitkeep',
        ], { initPush: true }),
        gitBlockTimeoutMs(),
        'Skeleton push',
      );
    } catch (e) {
      log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
    }
  }

  // Step 5: member roster on the teamai-reports orphan branch (never the
  // default branch). The clone's leftover members/ is a read-only inherited
  // root: the merge below absorbs the member's pre-switch file.
  let isNewMember = true;
  if (!options.dryRun) {
    try {
      const { updateReports } = await import('./utils/reports-branch.js');
      let memberChanged = false;
      let memberProjects: string[] | undefined;
      const result = await withTimeout(
        updateReports(reportsConfig, async (wt) => {
          const memberDir = path.join(wt, 'members');
          await ensureDir(memberDir);
          const memberPath = path.join(memberDir, `${username}.yaml`);
          isNewMember = !await pathExists(memberPath);
          const existingMember = await readMemberConfig(memberReadRoots(wt, reportsConfig), username);
          const merged = mergeMemberConfig(existingMember, {
            username,
            projects: resolvedProjects,
          });
          memberChanged = merged.changed;
          memberProjects = merged.config.projects;
          if (!merged.changed) {
            return {
              files: [],
              message: `[teamai] Update member roster: ${username}`,
            };
          }
          await writeFile(memberPath, YAML.stringify(merged.config));
          return {
            files: ['members/'],
            message: isNewMember
              ? `[teamai] Register member: ${username}`
              : `[teamai] Update member roster: ${username}`,
          };
        }, { initPush: true }),
        gitBlockTimeoutMs(),
        'Member registration push',
      );
      if (result.status === 'failed') {
        log.warn(`Member registration could not be pushed: ${result.reason}. You are still set up locally. Fix the cause, then re-run the same \`teamai init\` command to retry.`);
      } else if (result.status === 'busy') {
        log.warn('Member registration skipped: another write holds the teamai-reports branch. You are still set up locally. Re-run the same `teamai init` command after it finishes.');
      } else if (memberChanged) {
        log.success(isNewMember
          ? `Registered as team member: ${username}`
          : `Updated member roster: ${username}${memberProjects ? ` (projects: ${memberProjects.join(', ')})` : ''}`);
        log.success(isNewMember
          ? 'Member registered on the teamai-reports branch'
          : 'Member roster updated on the teamai-reports branch');
      } else if (!isNewMember) {
        log.info(`Member ${username} already registered`);
      }
    } catch (e) {
      log.warn(`Member registration skipped (non-blocking): ${(e as Error).message}`);
    }
  } else {
    log.info(`[dry-run] Would register member ${username} on the teamai-reports branch`);
  }

  // Step 5.5: Configure default MR reviewers (only for fresh setup with no reviewers yet).
  // --force implies non-interactive: skip reviewer prompts entirely (can be configured later).
  const currentConfig = await loadTeamConfig(localPath);
  const hasReviewers = currentConfig?.reviewers && currentConfig.reviewers.length > 0;
  if (isNewMember && !hasReviewers && !options.force) {
    const wantReviewers = await askConfirmation(
      '\nWould you like to configure default MR reviewers? [y/N] ',
    );
    if (wantReviewers) {
      const reviewerInput = await askQuestion('Reviewers (comma-separated usernames): ', '');
      const reviewers = reviewerInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (reviewers.length > 0) {
        const configPath = path.join(localPath, 'teamai.yaml');
        const configContent = await readFileSafe(configPath);
        if (configContent) {
          const configData = YAML.parse(configContent) as Record<string, unknown>;
          configData.reviewers = reviewers;
          await writeFile(configPath, YAML.stringify(configData));
          log.success(`Configured ${reviewers.length} reviewer(s): ${reviewers.join(', ')}`);

          if (!options.dryRun) {
            try {
              // Reviewer config goes via MR: a protected default branch rejects
              // a direct push (the original bug), and an MR lands it on a
              // feature branch for a maintainer to merge. The push itself uses
              // createGitWithBlockTimeout (spawn-level timeout); the provider's
              // pr-create spawnSync also carries the init-push timeout so a
              // stalled gh/gf process cannot block the event loop past it.
              const mrTeamConfig = await loadTeamConfig(localPath);
              const mrLocalConfig = {
                repo: { remote: repoInfo.httpsUrl, localPath },
                username,
                ...(forcedProvider ? { provider: forcedProvider } : {}),
              };
              if (mrTeamConfig) {
                const prUrl = await withTimeout(
                  autoPushViaMR(
                    localPath,
                    `[teamai] Configure reviewers: ${reviewers.join(', ')}`,
                    ['teamai.yaml'],
                    mrTeamConfig,
                    mrLocalConfig,
                    { initPush: true },
                  ),
                  gitBlockTimeoutMs(),
                  'Reviewer config push',
                );
                if (prUrl) {
                  log.success(`Reviewer config pushed via MR: ${prUrl}`);
                } else {
                  log.warn('Reviewer config MR could not be created (you can push manually later)');
                }
              }
            } catch (e) {
              log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
            }
          }
        }
      }
    }
  }

  // Step 6: Save local config
  const localConfig: LocalConfig = {
    ...settingsReinitKeeps(replacedFile, repoInfo.httpsUrl),
    repo: { localPath, remote: repoInfo.httpsUrl },
    username,
    ...(forcedProvider ? { provider: forcedProvider } : {}),
    scope,
    projectRoot,
    additionalRoles: [],
    ...(scope === 'project' ? { dataHome: teamaiHome } : {}),
    ...(inheritUserScope !== undefined ? { inheritUserScope } : {}),
  };

  if (!rolePromptedEarly) {
    try {
      roleProfile = await promptForRoleProfile({ localPath }, username, options.role);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('Roles manifest not found')) {
        log.debug('No roles manifest found — skipping role selection');
      } else {
        log.error(msg);
        process.exit(1);
      }
    }
  }
  if (roleProfile) Object.assign(localConfig, roleProfile);
  // As above: the assignment reaches hook, MCP and env reconciliation through
  // this config, and is never written to disk.
  await refreshRoleAssignment(localConfig);

  // Projects were resolved before member registration so both records agree.
  localConfig.projects = resolvedProjects;

  // Persist --agent into enabledAgents (additive across runs)
  // Interactive project init without --agent asks which tools the member uses.
  // Non-interactive runs skip the picker. Calling it would copy tools found in
  // HOME, and this init enables nothing unless --agent names a tool.
  if (scope === 'project' && requestedAgents.length === 0
    && !options.silent && !options.force && isInteractive()) {
    requestedAgents.push(...await promptForSelfModeAgents({ projectScope: true }));
  }
  if (requestedAgents.length > 0) {
    // As loaded before the clone: that config may have been moved aside since.
    const prev = carriedConfig?.enabledAgents ?? [];
    localConfig.enabledAgents = [...new Set([...prev, ...requestedAgents])];
    localConfig.disabledAgents = (carriedConfig?.disabledAgents ?? []).filter((t) => !requestedAgents.includes(t));
  } else {
    // No --agent: the lists stand as they were, `uninstall --agent`'s exclusion included.
    if (carriedConfig?.enabledAgents) localConfig.enabledAgents = [...carriedConfig.enabledAgents];
    if (carriedConfig?.disabledAgents) localConfig.disabledAgents = [...carriedConfig.disabledAgents];
  }

  // Carry the member's recorded tool roots across a re-init. `init` is
  // re-runnable and CLAUDE_CONFIG_DIR / CODEX_HOME live in one shell profile, so a re-init
  // from a shell that does not export it must not quietly send every later sync
  // back to the default root. recordToolRoots then overwrites a tool's
  // entry when its variable IS set.
  // A project-scope config with no record of its own starts from the user-scope
  // one: the root is a fact about this machine, and project hooks land in HOME.
  const carriedToolRoots = carriedConfig?.toolRoots
    ?? (scope === 'project' ? (await loadLocalConfigForScope('user'))?.toolRoots : undefined);
  if (carriedToolRoots) localConfig.toolRoots = { ...carriedToolRoots };
  recordToolRoots(localConfig);
  for (const change of await recordToolHomes('init')) log.info(describeToolHomeChange(change));
  await releasePreviousToolRoots(currentConfig, carriedConfig, localConfig);

  await ensureDir(teamaiHome);
  if (scope !== 'project') await ensureDir(getTeamaiHomeDir());
  await settleModeSwitch(existingLocalConfig, localConfig, () =>
    scope === 'project' ? saveLocalConfigForScope(localConfig, scope, projectRoot) : saveLocalConfig(localConfig));

  if (scope === 'project') {
    log.success(`Local config saved to ${teamaiHome}/config.yaml`);

    // Generate .gitignore for project scope to prevent local config from being committed
    const gitignorePath = path.join(teamaiHome, '.gitignore');
    if (!await pathExists(gitignorePath)) {
      await writeFile(gitignorePath, buildProjectScopeGitignore());
      log.debug('Generated .teamai/.gitignore for workspace scope');
    }
  } else {
    log.success(`Local config saved to ${getTeamaiHomeDir()}/config.yaml`);
  }

  // Step 6.5: Invalidate pull cache so next pull does full sync with cleanup
  // This handles re-init scenarios where the user changes their role
  try {
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // Non-critical: state file may not exist yet on first init
  }

  // Step 6.6: project scope creates the roots of the tools the member chose
  // (`--agent` or the interactive picker), so the stub below has somewhere to
  // write. Runs after the config is saved: createProjectToolRoots filters by
  // the saved enabledAgents, which now includes this run's choice. Without a
  // chosen tool no root is invented; the directory appears when that agent
  // starts a session.
  if (scope === 'project' && requestedAgents.length > 0) {
    const { createProjectToolRoots } = await import('./project-agent-root.js');
    await createProjectToolRoots({ cwd: projectRoot, tools: requestedAgents });
  }

  // Step 7: Inject built-in + team hooks into AI tools
  const reloadedTeamConfig = await loadTeamConfig(localPath);
  // Only a stub that actually landed is announced as ready in the IDE.
  let stubDeployed = 0;
  if (reloadedTeamConfig) {
    const filterAgents = requestedAgents.length > 0 ? requestedAgents : undefined;

    // Step 6.7: seed a custom agent's configured root before hook injection,
    // same as self-mode's Step 5.3 above — a custom `--agent` target does not
    // have to already exist on disk the way a built-in tool does. Without
    // this, a custom agent configured only in teamai.yaml's toolPaths (its
    // root never created by anything else) was silently skipped by every
    // pull forever, since isToolInstalled treats a missing root as "not
    // installed" (#867). Built-in tools are left untouched here: their root
    // already existing is exactly what doctor's "is installed" check verifies
    // (#598), so seeding them outside self mode would silently manufacture a
    // directory for software that was never actually installed. Only the
    // project roots of tools named with `--agent` are created (Step 6.6).
    try {
      const { seedSelfModeToolDirs } = await import('./known-agents.js');
      const seeded = await seedSelfModeToolDirs(localConfig, reloadedTeamConfig);
      if (seeded.length > 0) log.debug(`Seeded tool dirs for: ${seeded.join(', ')}`);
    } catch (e) {
      log.debug(`Tool-dir seeding skipped: ${(e as Error).message}`);
    }

    await runInitScript(localConfig, 'preInit', options.dryRun);
    await reconcileHooksForInit(reloadedTeamConfig, localConfig, filterAgents);

    // Step 7.5: Deploy the built-in discovery stub immediately so the teamai
    // skill is available in the IDE right after init, without waiting for the
    // first pull. Its workflows are served by `teamai skill get`.
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      stubDeployed = await deployBuiltinSkills(reloadedTeamConfig, localConfig);
      if (stubDeployed > 0) {
        log.debug(`Deployed ${stubDeployed} built-in skill(s)`);
      }
    } catch (e) {
      log.warn(`The built-in teamai skill was not deployed: ${(e as Error).message}`);
    }

    // After hooks. There is no closing pull; sync MCP here so a value the
    // script collected is in the tool config. Skipped when teamai.yaml did not
    // load: there is no script, and a second read would report the same error.
    await runInitScript(localConfig, 'postInit', options.dryRun, true);
  }

  // Init does not copy team resources (#1065). The next session start creates
  // the current agent's project directory when it is missing and pulls.
  // `teamai pull` pulls into directories that already exist. A tool that reads
  // rules and MCP once, before that hook, sees them from the following session.
  //
  // Hook files written above stay out of git while sharing.gitExclude is on.
  // The pull that used to record them no longer runs here.
  if (reloadedTeamConfig) {
    try {
      const { createDeliveryRecorder } = await import('./git-exclude-delivered.js');
      const { syncDeliveredGitExclude } = await import('./pull.js');
      const recorder = createDeliveryRecorder();
      for (const file of await deliveredHookFiles(reloadedTeamConfig, localConfig)) recorder.report('hooks', file);
      await syncDeliveredGitExclude(localConfig, recorder);
    } catch (e) {
      log.warn(`Could not update teamai's delivered git exclude block: ${(e as Error).message}. Fix the cause, then run \`teamai pull\`.`);
    }
  }

  log.success('teamai initialized successfully!');
  if (stubDeployed > 0) {
    log.info('The built-in teamai skill is ready in your IDE; it loads its workflows with `teamai skill get`.');
  } else {
    log.warn('The built-in teamai skill was not deployed to any AI tool, so agents cannot find TeamAI yet. The reason is printed above or recorded in ~/.teamai/debug.log; the usual one is that none of the selected tools is installed. Run `teamai pull` once it is fixed.');
  }
  log.info('Team skills, rules, env and docs are not copied during init. They sync on the next session start, or when you run `teamai pull`.');
  log.info('Run `teamai status` to check current config.');

  // Close the readline singleton so the process can exit cleanly.
  closePrompt();
}
