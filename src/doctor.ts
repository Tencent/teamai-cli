import YAML from 'yaml';
import { hookToolPathsForConfig } from './types.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { detectProjectConfig, loadLocalConfig, loadMemberSettings, loadTeamConfig } from './config.js';
import { memberTools } from './tool-launch/call.js';
import { AgentSession } from './session-flow/agent-session.js';
import { SessionPolicy, type SessionPolicy as Policy } from './session-flow/session-policy.js';
import { explainRunMode, RUN_MODES, type ExplainedRunMode } from './launch-context.js';
import { scoringUnavailable } from './scorers/home.js';
import { scopeScoring } from './scorers/settings.js';
import { readWorkspaceChildren } from './workspace-children.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { log, setStderrOnly } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import {
  COPILOT_TOOL_ID,
  RELOCATABLE_TOOLS,
  applyToolRoots,
  detectToolRoot,
  resolveToolRootDir,
  toolRootRejection,
  resolveHookScope,
  legacyManagedHooksPath,
  resolveBaseDir,
  isAgentExcluded,
  scopedToolPaths,
  toolGateRoot,
  getDataHome,
  getTeamaiHomeDir,
  isContributeHintEnabled,
  isMrHintEnabled,
  isRecallEnabled,
  isUsageReportEnabled,
  resolveAutoCompactTokens,
  resolveCoAuthor,
  type LocalConfig,
  type TeamaiConfig,
  installScopeName,
} from './types.js';
import { hookSettingsFile, installOf, isInstalledFor, locate, ownOf, writable, type Gate, type Install } from './locate.js';
import { samePlace } from './resources/places.js';
import { describeInvalidToolHomes, envToolHome, realHost, reloadToolHomes, toolHomesPath } from './tool-home.js';
import { isToolId } from './tools.js';
import { isCodexTool } from './utils/tool-names.js';
import { TEAMAI_HOOK_SUBCOMMANDS, isCodexTrustGatedTool, codexTrustReminder, keptTeamHookEntries, readCodexHookTrustForScope } from './hooks.js';
import { codexBuildSkewMessage } from './codex-trust.js';
import {
  buildDeliveryChecks,
  nameList,
  toolPathsDroppedKeyNotes,
  buildSkillDirChecks,
  skillReadNotes,
  buildRecordedPlaceChecks,
  recordedPlaceNotes,
  buildRulesDeliveryChecks,
  buildAgentsDeliveryChecks,
  buildAgentPlaceChecks,
  buildInstructionDeliveryChecks,
  buildNamespaceNotes,
  buildMcpDeliveryChecks,
  mcpTransportNotes,
  buildMcpReadFileChecks,
  buildLocalAgentMcpLocationChecks,
  buildCodexProjectTrustCheck,
  buildMcpGitExcludeCheck,
  buildEnvDeliveryCheck,
  envLoaderNotes,
  buildEntryResolutionChecks,
  buildSecretValuesCheck,
  buildEntryScopeKeyCheck,
  entryNamespaceNotes,
  buildDocsCheck,
  keptDocNotes,
} from './doctor-delivery.js';
import { agentModelNotes, aliasNamespaceNotes, buildAgentModelChecks } from './doctor-agent-models.js';
import {
  buildDeliveredGitExcludeChecks, buildLocalAgentGitExcludeChecks, deliveredGitExcludeNotes, localAgentGitExcludeNotes,
} from './doctor-git-exclude.js';

/**
 * Where a check gets its answer. `provider` checks shell out to a provider CLI
 * or the network; `local` checks only read this machine. Callers that run the
 * registry outside `teamai doctor` filter on it — see the post-pull pass in
 * `pull()`, which has just used the provider successfully and must not pay for
 * an auth probe on every sync.
 */
export type CheckSource = 'local' | 'provider';
import { hasPiHooks } from './pi-hooks.js';
import { describeEnvAdvisory, envAdvisories } from './env-advisories.js';
import { resolvesTeamEnv, resolveTeamEnv, type TeamEnv } from './env-resolution.js';
import type { GitContext } from './git-exclude.js';

export interface Check {
  name: string;
  source: CheckSource;
  /**
   * Names something `teamai pull` says in its own words, better than a static
   * `fix` can: the queue warning carries the push error, which `doctor` cannot
   * learn without attempting a push of its own, and a read-only diagnostic must
   * not. The post-pull pass drops a check whose topic that run actually
   * reported. Not every run does: a scope whose team repo fails to refresh
   * returns before the publish step, and a publish that throws is swallowed
   * into a debug line. On those paths nobody has spoken, so the check is the
   * only voice left and must be heard.
   */
  reportedByPull?: string;
  /**
   * True for a check whose failure is a cleanup opportunity, not a sign that
   * anything a user asked for is actually broken. `doctor` still reports it
   * like any other check; `pull`'s post-pull summary excludes it from the
   * "N check(s) failed" count so a healthy delivery is not announced as
   * broken because of unrelated leftover state (#693 review round 6).
   */
  informational?: boolean;
  check: () => Promise<boolean>;
  fix?: string;
}

/**
 * Everything the check registry needs to describe this machine. Resolved once
 * by `resolveDoctorContext`, then passed to `buildChecks` — so any caller
 * (doctor, and later a post-pull run) builds the same checks the same way.
 */
export interface DoctorContext {
  localConfig: LocalConfig;
  teamConfig: TeamaiConfig | null;
  /** Tool paths already narrowed to the enabled, non-excluded agents. */
  toolPaths: TeamaiConfig['toolPaths'];
  /**
   * The same tool paths resolved at the scope hooks are injected into, which is
   * not the config's scope: a non-self project scope injects into HOME (#264).
   * Hook checks must use these, or a tool whose user-scope prefix differs from
   * its project-scope one is looked for under the wrong prefix and always
   * reported missing.
   */
  hookToolPaths: TeamaiConfig['toolPaths'];
  /** Where hooks are actually injected — see `resolveHookScope` (#264). */
  baseDir: string;
  /** This scope's env, resolved once for every check that reads it (env-resolution.ts); none in HTTP mode. */
  teamEnv?: TeamEnv;
  /** What git said of directories earlier in the same run (a pull's git exclude sync); the checks ask it first. */
  gitContext?: GitContext;
}

export interface DoctorOptions extends GlobalOptions {
  /** Emit the report as JSON on stdout instead of the human rendering. */
  json?: boolean;
  /** Remove the lock files left behind by dead processes (#1027). */
  fix?: boolean;
}

/** One check after it ran. */
export interface CheckResult {
  name: string;
  ok: boolean;
  fix?: string;
}

/** What `doctor --json` prints. One object, one place that builds it. */
export interface DoctorReport {
  ok: boolean;
  /** null before initialization, when there is no config to scope. */
  scope: string | null;
  /** The run mode this process resolves, and its source. */
  runMode: ExplainedRunMode;
  checks: CheckResult[];
  /** Present only when the team repo declares packages. Human text, not checks. */
  packages?: { ok: boolean; lines: string[] };
  /**
   * Advisories that are not checks: namespace overrides, a team secret with no
   * value (#875), the Codex trust reminder when Codex cannot be asked.
   */
  notes?: string[];
  /** The member setting provenance report, ordered by precedence. */
  memberSettings?: MemberSettingsReport[];
}

export type MemberSettingLevel = 'environment' | 'scope' | 'machine' | 'team' | 'default';

export interface MemberSettingSource {
  level: MemberSettingLevel;
  value?: unknown;
  file?: string;
  variable?: string;
  /** False when this value is visible for context but is not the runtime winner. */
  used?: boolean;
}

export interface MemberSettingsReport {
  key: string;
  effective?: unknown;
  source?: MemberSettingSource;
  levels: MemberSettingSource[];
}

const MEMBER_SETTING_REPORT_KEYS = [
  'ai.tool',
  'workflows.tools.default',
  'workflows.max_parallel',
  'workflows.auto_approve',
  'workflows.sandbox',
  'workflows.allow.network',
  'recallEnabled',
  'contributeHintEnabled',
  'mrHintEnabled',
  'coAuthorEnabled',
  'usageReportEnabled',
  'codexTrustEnabled',
  'updatePolicy',
  'autoCompactTokens',
] as const;

const MACHINE_WIDE_MEMBER_SETTINGS = new Set(['updatePolicy', 'autoCompactTokens']);

function addWorkflowReportKeys(target: Set<string>, value: unknown): void {
  const workflows = readPath(value, ['workflows']);
  if (typeof workflows !== 'object' || workflows === null || Array.isArray(workflows)) return;
  const tools = (workflows as Record<string, unknown>).tools;
  if (typeof tools === 'object' && tools !== null && !Array.isArray(tools)) {
    for (const name of Object.keys(tools as Record<string, unknown>)) target.add(`workflows.tools.${name}`);
  }
  const allow = (workflows as Record<string, unknown>).allow;
  if (typeof allow === 'object' && allow !== null && !Array.isArray(allow)
    && Object.prototype.hasOwnProperty.call(allow, 'env')) target.add('workflows.allow.env');
}

/** Map settings need one provenance row per key: one merged object cannot name two winners. */
function addModelAliasReportKeys(target: Set<string>, value: unknown): void {
  const aliases = readPath(value, ['modelAliases']);
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) return;
  for (const name of Object.keys(aliases as Record<string, unknown>)) target.add(`modelAliases.${name}`);
}

function nonEmptyAiTool(value: unknown): unknown {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Report keys use dots as separators except for literal map-entry names. */
function reportPathParts(key: string): string[] {
  if (key.startsWith('workflows.tools.')) return ['workflows', 'tools', key.slice('workflows.tools.'.length)];
  if (key.startsWith('modelAliases.')) return ['modelAliases', key.slice('modelAliases.'.length)];
  return key.split('.');
}

function readPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function readYamlObject(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = YAML.parse(await readFileSafe(file) ?? '');
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function settingSource(level: MemberSettingLevel, value: unknown, file?: string, variable?: string, used = true): MemberSettingSource {
  return { level, value, ...(file ? { file } : {}), ...(variable ? { variable } : {}), ...(used ? {} : { used: false }) };
}

async function memberSettingsReport(ctx: DoctorContext): Promise<MemberSettingsReport[]> {
  const machineFile = path.join(getTeamaiHomeDir(), 'config.yaml');
  const rawMachine = await readYamlObject(machineFile);
  const machine = await loadMemberSettings(machineFile);
  const scopeFile = getDataHome(ctx.localConfig) + path.sep + 'config.yaml';
  const rawScope = ctx.localConfig.scope === 'user' ? rawMachine : await readYamlObject(scopeFile);
  const userConfig = ctx.localConfig.scope === 'user' ? ctx.localConfig : await loadLocalConfig();
  const userSettings = userConfig?.scope === 'user' ? userConfig : {};
  // updatePolicy and autoCompactTokens are machine-wide: when a user install
  // exists, it decides these values even while doctor is inspecting a project.
  // Load the same team file that pull/update use for that deciding install.
  const decidingTeam = userConfig?.scope === 'user'
    ? await loadTeamConfig(userConfig.repo.localPath)
    : ctx.teamConfig;
  const reportKeys = new Set<string>(MEMBER_SETTING_REPORT_KEYS);
  addWorkflowReportKeys(reportKeys, rawMachine);
  addWorkflowReportKeys(reportKeys, rawScope);
  addModelAliasReportKeys(reportKeys, machine);
  addModelAliasReportKeys(reportKeys, rawScope);

  const teamValue = (key: string): unknown => {
    const selectedTeam = (MACHINE_WIDE_MEMBER_SETTINGS.has(key) ? decidingTeam : ctx.teamConfig) as unknown as Record<string, unknown> | null;
    const selectedSharing = selectedTeam?.sharing as Record<string, unknown> | undefined;
    if (key === 'recallEnabled') return readPath(selectedSharing, ['recall', 'enabled']);
    if (key === 'contributeHintEnabled') return readPath(selectedSharing, ['contributeHint', 'enabled']);
    if (key === 'mrHintEnabled') return readPath(selectedSharing, ['mrHint', 'enabled']);
    if (key === 'coAuthorEnabled') return readPath(selectedSharing, ['coAuthor', 'enabled']);
    if (key === 'autoCompactTokens') return readPath(selectedSharing, ['autoCompact', 'tokens']);
    if (key === 'usageReportEnabled') return selectedTeam?.usageReport;
    if (key === 'updatePolicy') return selectedTeam?.autoUpdate === false ? 'skip' : selectedTeam?.autoUpdate === true ? 'auto' : undefined;
    return undefined;
  };
  const defaultValue = (key: string): unknown => {
    if (key === 'workflows.max_parallel') return 1;
    if (key === 'workflows.auto_approve') return false;
    if (key === 'workflows.allow.network') return true;
    if (key === 'recallEnabled') return false;
    if (key === 'contributeHintEnabled' || key === 'mrHintEnabled' || key === 'usageReportEnabled') return true;
    if (key === 'coAuthorEnabled' || key === 'codexTrustEnabled') return true;
    if (key === 'updatePolicy') return 'auto';
    return undefined;
  };

  const levelsFor = (key: string): MemberSettingSource[] => {
    const parts = reportPathParts(key);
    let scopeValue = readPath(rawScope, parts);
    let scopeSourceFile = ctx.localConfig.scope === 'user' ? machineFile : scopeFile;
    const machineWideUser = MACHINE_WIDE_MEMBER_SETTINGS.has(key) && userConfig?.scope === 'user';
    if (machineWideUser) {
      scopeValue = readPath(userSettings, parts);
      scopeSourceFile = machineFile;
    }
    let machineValue = readPath(machine, parts);
    if (key === 'ai.tool') {
      scopeValue = nonEmptyAiTool(scopeValue);
      machineValue = nonEmptyAiTool(machineValue);
    }
    const levels: MemberSettingSource[] = [];
    if (key === 'ai.tool' && process.env.TEAMAI_AI_TOOL) levels.push(settingSource('environment', process.env.TEAMAI_AI_TOOL, undefined, 'TEAMAI_AI_TOOL'));
    if (key === 'recallEnabled' && process.env.TEAMAI_RECALL_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_RECALL_DISABLED'));
    if (key === 'contributeHintEnabled' && process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_CONTRIBUTE_HINT_DISABLED'));
    if (key === 'mrHintEnabled' && process.env.TEAMAI_MR_HINT_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_MR_HINT_DISABLED'));

    if (!machineWideUser && scopeValue !== undefined) levels.push(settingSource('scope', scopeValue, scopeSourceFile));
    if (machineValue !== undefined && ctx.localConfig.scope !== 'user' && !machineWideUser) {
      levels.push(settingSource('machine', machineValue, machineFile));
    }
    if (machineWideUser && scopeValue !== undefined) levels.push(settingSource('scope', scopeValue, scopeSourceFile));
    const teamValueForKey = teamValue(key);
    if (teamValueForKey !== undefined) {
      const teamFile = MACHINE_WIDE_MEMBER_SETTINGS.has(key) && userConfig?.scope === 'user'
        ? path.join(userConfig.repo.localPath, 'teamai.yaml')
        : ctx.localConfig.repo.localPath
          ? path.join(ctx.localConfig.repo.localPath, 'teamai.yaml')
          : undefined;
      levels.push(settingSource('team', teamValueForKey, teamFile));
    }
    const fallback = defaultValue(key);
    if (fallback !== undefined) levels.push(settingSource('default', fallback));
    // Keep a workspace value visible for machine-wide settings, but mark it
    // unused: pull/update resolve these two keys from the user install.
    if (machineWideUser && ctx.localConfig.scope !== 'user') {
      const workspaceValue = readPath(rawScope, parts);
      if (workspaceValue !== undefined) levels.push(settingSource('scope', workspaceValue, scopeFile, undefined, false));
    }
    return levels;
  };

  const decidingConfig = userConfig?.scope === 'user' ? userConfig : ctx.localConfig;
  const aiTool = async (): Promise<string | undefined> => (await memberTools(ctx.localConfig))[0]?.tool;
  const effectiveValue = async (key: string, levels: MemberSettingSource[]): Promise<unknown> => {
    if (key === 'ai.tool') return await aiTool();
    if (key === 'recallEnabled') return isRecallEnabled(ctx.localConfig, ctx.teamConfig ?? {});
    if (key === 'contributeHintEnabled') return isContributeHintEnabled(ctx.localConfig, ctx.teamConfig ?? {});
    if (key === 'mrHintEnabled') return isMrHintEnabled(ctx.localConfig, ctx.teamConfig ?? {});
    if (key === 'usageReportEnabled') return isUsageReportEnabled(ctx.localConfig, ctx.teamConfig ?? {});
    if (key === 'coAuthorEnabled') return resolveCoAuthor(ctx.localConfig, ctx.teamConfig ?? {}) ?? true;
    if (key === 'autoCompactTokens') return resolveAutoCompactTokens(decidingConfig, decidingTeam ?? {});
    if (key === 'updatePolicy') {
      const { resolveEffectiveUpdatePolicy } = await import('./update-policy.js');
      return resolveEffectiveUpdatePolicy(decidingConfig, decidingTeam);
    }
    return levels[0]?.value;
  };

  const reports: MemberSettingsReport[] = [];
  for (const key of reportKeys) {
    const levels = levelsFor(key);
    const effective = await effectiveValue(key, levels);
    if (effective === undefined && levels.length === 0) continue;
    reports.push({ key, effective, source: levels.find((level) => level.used !== false), levels });
  }
  return reports;
}

/**
 * Check that every tool the team declares and the user enabled is actually here.
 * Scope note: the loop is over `ctx.toolPaths`, already narrowed to the enabled,
 * non-excluded agents, so a name in `enabledAgents` that `teamai.yaml` declares
 * no paths for is out of scope — nothing would be written to it either way.
 *
 * That list is the user's own claim that they use the tool, and every writer —
 * skills, rules, agents, hooks — silently skips a tool whose root is missing.
 * Answering the claim with silence reproduces inside `doctor` the skip #574
 * reports in `pull`: "Synced N" while the tool receives nothing. Without
 * `enabledAgents` the team's tool list is aspirational, so an absent tool stays
 * silent, as it always has.
 *
 * The probe is the install gate `locate` gives the resource the tool takes
 * first, the gate a pull checks before it writes there.
 */
async function buildEnabledToolChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, toolPaths } = ctx;
  if (!localConfig.enabledAgents) return [];

  const install = installOf(ctx.teamConfig ?? { toolPaths }, localConfig);
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    // Copilot counts itself installed as soon as enabledAgents names it
    // (`locate`'s install gate), so this check could never fail for it. Its
    // delivery check still reports what did not arrive.
    if (tool === COPILOT_TOOL_ID) continue;

    const probe = await installProbeOf(tool, paths, install);
    if (probe === null) continue;
    const unmet = probe.gates.find((gate) => gate.kind === 'installed' && !gate.met);

    // Pushed whether or not it passes. Every other check in the registry
    // reports both ways, and `doctor --json` is consumed by hooks and CI, where
    // a missing entry cannot be told apart from one that passed.
    checks.push({
      name: `${tool} is installed`,
      source: 'local',
      check: async () => probe.isInstalled,
      fix: `enabledAgents lists ${tool}, but ${unmet?.kind === 'installed' ? `${unmet.probe} does not exist` : `it has no directory under ${resolveBaseDir(localConfig)}`}, `
        + 'so a pull delivers nothing to it. '
        + `Install ${tool} (in workspace scope, opening a session there creates its root), `
        + `or run \`teamai uninstall --agent ${tool}\` to stop syncing to it.`,
    });
  }

  return checks;
}

/**
 * A tool that receives skills is asked the way the skills write path asks:
 * OpenClaw lives at its workspace directory, not at the tool root, so the
 * generic probe passes for a `~/.openclaw` with no workspace while delivery
 * silently skips it — the same "reported success, received nothing" this
 * check exists to catch.
 */
async function installProbeOf(
  tool: string,
  paths: TeamaiConfig['toolPaths'][string],
  install: Install,
): Promise<{ readonly isInstalled: boolean; readonly gates: readonly Gate[] } | null> {
  if (paths.skills) {
    const skills = await locate(tool, 'skills', install);
    return { isInstalled: writable(skills) !== null, gates: skills.gates };
  }
  const resource = paths.rules ? 'rules' : paths.agents ? 'agents' : paths.settings ?? paths.hooks ? 'hooks' : null;
  if (resource === null) return null;
  const location = await locate(tool, resource, install);
  return { isInstalled: isInstalledFor(location), gates: location.gates };
}

/** The surfaces `locate` gates per tool, as a fix names them. */
const GATED_SURFACES = [['rules', 'rules'], ['blocks', 'team instructions'], ['agents', 'agents'], ['mcp', 'MCP servers']] as const;

/**
 * A tool can take its skills while its other surfaces wait for a root that is
 * not there: on WorkBuddy 5.7+, skills land under `.workbuddy-ai/`, while
 * everything else still needs `.workbuddy/` (#1273). Pull writes none of those,
 * and the delivery checks skip a tool whose gate is unmet, so with
 * `<tool> is installed` passing on the skills root doctor would stay green.
 * Hooks count when the hook writer finds none of its install roots and one of
 * them is a root the other surfaces wait for.
 */
async function buildHeldSurfaceChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, toolPaths, hookToolPaths, baseDir } = ctx;
  const install = installOf(ctx.teamConfig ?? { toolPaths }, localConfig);
  const checks: Check[] = [];
  for (const tool of Object.keys(toolPaths)) {
    const skills = writable(await locate(tool, 'skills', install));
    if (skills === null) continue;
    // Keyed by every missing root, whether or not the team maps a surface to it.
    const held = new Map<string, string[]>();
    for (const [resource, surface] of GATED_SURFACES) {
      const location = await locate(tool, resource, install);
      const unmet = location.gates.find((gate) => gate.kind === 'installed' && !gate.met);
      if (unmet?.kind !== 'installed') continue;
      const surfaces = held.get(unmet.probe) ?? [];
      if (location.channel === 'files' && location.own !== null) surfaces.push(surface);
      held.set(unmet.probe, surfaces);
    }
    const settings = hookToolPaths[tool]?.settings;
    if (settings) {
      // reconcileHooksToAllTools injects while either root exists.
      const gateRoot = toolGateRoot(tool, settings, localConfig.toolRoots);
      const hookRoots = [hookSettingsFile(tool, baseDir, gateRoot)];
      if (localConfig.scope === 'project') hookRoots.push(path.join(localConfig.projectRoot ?? baseDir, gateRoot));
      const root = hookRoots.find((candidate) => held.has(candidate));
      if (root !== undefined && !(await Promise.all(hookRoots.map((dir) => pathExists(dir)))).includes(true)) held.get(root)?.push('hooks');
    }
    for (const [root, surfaces] of held) {
      if (surfaces.length === 0) continue;
      checks.push({
        name: `${tool} receives ${nameList(surfaces)}`,
        source: 'local',
        check: async () => false,
        fix: `teamai delivers ${tool}'s skills to ${skills.path}, but writes its ${nameList(surfaces)} only once `
          + `${root} exists, and it does not, so a pull holds them back from ${tool}. teamai does not write them `
          + 'where this install reads its skills yet, so there is nothing to fix on this machine.',
      });
    }
  }
  return checks;
}

/**
 * Check that each relocated tool root is the one teamai writes to.
 *
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move everything their tool reads —
 * settings, hooks, skills, rules, agents — and teamai learns about them only
 * when `init` records them in `toolRoots`. Without the check, a member who sets
 * the variable after initializing (or changes it) keeps getting a green report
 * while every synced resource lands in a directory their tool never opens.
 *
 * Skipped when the variable is unset — then there is nothing to relocate and a
 * member who never used it should not be told about a setting they do not have.
 */
function buildToolRootChecks(localConfig: LocalConfig, teamConfig: TeamaiConfig | null): Check[] {
  const checks: Check[] = [];
  for (const [tool, { label, envVar }] of Object.entries(RELOCATABLE_TOOLS)) {
    // Nothing to compare for a config that never writes to this tool.
    const declared = teamConfig?.toolPaths[tool];
    if (!declared || isAgentExcluded(localConfig, tool)) continue;
    const detected = detectToolRoot(tool);
    if (!detected) continue;
    // The effective root, not the recorded string: `~/.claude-work` written by
    // hand is the same directory as the expanded one, while a root the sync
    // refuses (outside HOME, or nested too deep) resolves back to the default —
    // so the check fails exactly when the sync would write somewhere else.
    const recorded = localConfig.toolRoots?.[tool];
    const effective = resolveToolRootDir(tool, RELOCATABLE_TOOLS[tool].defaultRoot, localConfig.toolRoots);
    // A value init refuses cannot be fixed by re-running init: say why instead.
    const rejection = toolRootRejection(detected);
    checks.push({
      name: `${label} root matches ${envVar}`,
      source: 'local',
      // Compared path by path, so a root equal to the default passes only when
      // recording it would change nothing: an unrecorded CLAUDE_CONFIG_DIR=~/.claude
      // leaves the MCP config at ~/.claude.json, while a Claude Code told to use
      // that directory reads .claude.json from inside it.
      check: async () => rejection === null && isDeepStrictEqual(
        applyToolRoots({ [tool]: declared }, { [tool]: detected })[tool],
        applyToolRoots({ [tool]: declared }, localConfig.toolRoots)[tool],
      ),
      fix: rejection
        ? `${envVar} is ${detected}, which teamai cannot sync to (${rejection}); `
          + `this config syncs ${label} to ${effective}. Point ${envVar} at a directory `
          + 'in your home, or anywhere under a `~/.config/<name>`, and re-run `teamai init`.'
        : `${envVar} is ${detected}; this config syncs ${label} to ${effective}`
          + `${recorded === undefined ? ' (no root recorded)' : ''}. `
          + 'Re-run `teamai init` to record it.',
    });
  }
  return checks;
}

function buildToolHomeChecks(localConfig: LocalConfig): Check[] {
  const file = toolHomesPath();
  const read = reloadToolHomes();
  switch (read.kind) {
    case 'missing':
      return [];
    case 'invalid':
      return [{
        name: 'tool homes record is readable',
        source: 'local',
        check: async () => false,
        fix: describeInvalidToolHomes(read.error),
      }];
    case 'ok':
      break;
    default: {
      const unhandled: never = read;
      return unhandled;
    }
  }
  const host = realHost();
  const checks: Check[] = [];
  for (const [tool, recorded] of Object.entries(read.homes)) {
    if (!isToolId(tool) || isAgentExcluded(localConfig, tool)) continue;
    checks.push({
      name: `${tool} home exists`,
      source: 'local',
      check: async () => pathExists(recorded),
      fix: `The ${tool} home recorded on this machine, ${recorded}, does not exist, so teamai skips ${tool}. `
        + `Re-run \`teamai init\` from a shell that sets the home ${tool} uses, or remove "${tool}" from ${file}.`,
    });
    const live = envToolHome(tool, host);
    if (live === null) continue;
    checks.push({
      name: `${tool} home matches ${live.variable}`,
      source: 'local',
      check: async () => samePlace(live.dir, recorded),
      fix: `${live.variable} puts the ${tool} home at ${live.dir}; this machine syncs ${tool} to ${recorded}. `
        + 'Re-run `teamai init` to record it.',
    });
  }
  return checks;
}

/**
 * Build hook checks for tools whose settings parent directory already exists
 * (i.e. the tool is installed). Tools that are not installed are skipped.
 */
async function buildHookChecks(
  toolPaths: TeamaiConfig['toolPaths'],
  hookToolPaths: TeamaiConfig['toolPaths'],
  baseDir: string,
  install: Install,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const tool of Object.keys(toolPaths)) {
    if (tool === 'kiro') {
      if (!await pathExists(path.join(getUserHome(), '.kiro'))) continue;
      const { hasKiroHooks } = await import('./kiro-hooks.js');
      checks.push({ name: 'teamai hooks in Kiro standalone hook file (requires Kiro CLI V3)', source: 'local', check: hasKiroHooks, fix: 'Run `teamai hooks inject`; standalone hooks require Kiro CLI V3.' });
      continue;
    }
    if (tool === 'pi') {
      if (!isInstalledFor(await locate(tool, 'hooks', install))) continue;
      checks.push({
        name: 'teamai hooks in pi extension',
        source: 'local',
        check: async () => hasPiHooks(),
        fix: 'Run `teamai hooks inject` to inject/update hooks',
      });
      continue;
    }
    if (tool === 'openclaw') {
      // OpenClaw has no settings file: its hook is a workspace hook directory,
      // which OpenClaw loads only once openclaw.json enables its entry.
      const { isOpenclawHookEnabled, OPENCLAW_HOOK_DIR, OPENCLAW_HOOK_KEY } = await import('./openclaw-hooks.js');
      const hooksDir = ownOf(await locate(tool, 'hooks', install))?.path;
      if (!hooksDir || !await pathExists(path.join(hooksDir, OPENCLAW_HOOK_DIR))) continue;
      checks.push({
        name: 'OpenClaw hook enabled',
        source: 'local',
        check: isOpenclawHookEnabled,
        fix: `OpenClaw loads teamai's hook only when openclaw.json sets hooks.internal.entries.${OPENCLAW_HOOK_KEY}.enabled `
          + `(and internal hooks are not switched off), so OpenClaw sends no status report or sync. `
          + `Run \`openclaw hooks enable ${OPENCLAW_HOOK_KEY}\`. If it is enabled already, openclaw.json is not plain JSON `
          + `(comments, JSON5), which teamai cannot read: \`openclaw hooks info ${OPENCLAW_HOOK_KEY}\` shows what OpenClaw sees.`,
      });
      continue;
    }
    const settings = hookToolPaths[tool]?.settings;
    const hookPath = hookToolPaths[tool]?.hooks
      ? ownOf(await locate(tool, 'hooks', install))?.path
      : settings
        ? hookSettingsFile(tool, baseDir, settings)
        : undefined;
    if (!hookPath) continue;
    const settingsPath = hookPath;
    const parentDir = path.dirname(settingsPath);
    const installed = tool === COPILOT_TOOL_ID
      ? isInstalledFor(await locate(tool, 'hooks', install))
      : await pathExists(parentDir);
    // An uninstalled tool has no hooks to check. Whether it should be installed
    // at all is a different question — see buildEnabledToolChecks.
    if (!installed) continue;
    checks.push({
      name: `teamai hooks in ${tool} settings`,
      source: 'local',
      check: async () => {
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        if (!content) return false;

        // Windows CodeBuddy's executable script is quoted in the JSON file.
        const missing = TEAMAI_HOOK_SUBCOMMANDS.filter(
          (sub) => !content.includes(`teamai ${sub}`)
            && !(tool === 'codebuddy' && content.includes(`teamai-codebuddy-hook\\" ${sub}`)),
        );
        return missing.length === 0;
      },
      fix: 'Run `teamai hooks inject` to inject/update hooks',
    });
    // ZCode and DeepSeek Harness get the rules from their session-start hook
    // too, checked with the rules (`buildProjectRulesHookChecks`); only Codex
    // has the SubagentStart entry and the context limit this check is about.
    if (isCodexTool(tool)) checks.push(sessionHookRulesCheck(tool, settingsPath));
  }
  return checks;
}

/**
 * In a project the Codex family gets the team rules and instruction blocks
 * from its session hooks (#938, #945): SessionStart, and SubagentStart for a
 * fresh subagent, which fires no SessionStart. Past 2,500 tokens Codex keeps
 * only the start and end of a hook's context unless the entry sets
 * `additionalContextLimit: 0`. Both start entries must be present: the generic
 * hooks check only proves some hook-dispatch command is installed.
 */
function sessionHookRulesCheck(tool: string, settingsPath: string): Check {
  return {
    name: `Project rules and instructions reach ${tool} whole through its session hooks`,
    source: 'local',
    check: async () => {
      const sessionStart = await teamaiHookEntries(settingsPath, 'SessionStart', 'session-start');
      const subagentStart = await teamaiHookEntries(settingsPath, 'SubagentStart', 'subagent-start');
      return [sessionStart, subagentStart].every((entries) => entries.some((entry) => entry.additionalContextLimit === 0));
    },
    fix: `The teamai SessionStart and SubagentStart entries in ${settingsPath} must both exist and set `
      + `\`additionalContextLimit: 0\`. Without them ${tool} keeps only the start and end of a large set of `
      + 'team rules and instructions, and a fresh subagent gets none. Run `teamai pull` to rewrite them'
      + (isCodexTrustGatedTool(tool)
        ? ' (teamai trusts them in Codex; with `codexTrustEnabled: false`, approve them in Codex /hooks).'
        : '.'),
  };
}

/** The teamai handlers for one event in a Codex hooks.json; none when it does not parse. */
async function teamaiHookEntries(
  settingsPath: string,
  event: 'SessionStart' | 'SubagentStart',
  subcommand: string,
): Promise<Array<{ additionalContextLimit?: unknown }>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileSafe(settingsPath) ?? '');
  } catch {
    return [];
  }
  const groups = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .filter((entry): entry is { command: string; additionalContextLimit?: unknown } =>
      typeof entry?.command === 'string' && entry.command.includes(`teamai hook-dispatch ${subcommand}`));
}


/**
 * Whether `teamai pull` reports this scope's usage stats to the team repo, and
 * what decides it: the member's `usageReportEnabled`, the team's `usageReport`,
 * or the default. An HTTP team repo is never reported to.
 */
function usageReportNote({ localConfig, teamConfig }: DoctorContext): string {
  if (localConfig.repo.kind === 'http') return 'Usage reporting: off, from HTTP mode (no team repo to report to).';
  const member = localConfig.usageReportEnabled;
  const team = teamConfig?.usageReport;
  const source = member !== undefined ? `usageReportEnabled: ${member} in ${path.join(getDataHome(localConfig), 'config.yaml')}`
    : team !== undefined ? `usageReport: ${team} in the team's teamai.yaml`
    : 'the default';
  return `Usage reporting: ${isUsageReportEnabled(localConfig, teamConfig ?? {}) ? 'on' : 'off'}, from ${source}.`;
}

/**
 * The enabled tools teamai reads no sessions from, in one note per run mode whose sessions it publishes or scores
 * (#1385): such a tool's sessions are never captured, so they are neither published nor judged.
 */
async function unreadSessionToolNotes({ localConfig, teamConfig, toolPaths }: DoctorContext): Promise<string[]> {
  const tools = AgentSession.toolsWithoutSessions(Object.keys(toolPaths));
  if (tools.length === 0) return [];
  const publish = SessionPolicy.publish(localConfig, teamConfig).policies;
  const scoring = scoringUnavailable(localConfig) ? undefined : await scopeScoring(localConfig);
  const scored = scoring?.ok ? scoring.sessions.policies : undefined;
  // `ask` acts as `off` for now (#1388): nothing is offered.
  const described = (policy: Policy | undefined, word: string) => (policy === 'auto' ? word : undefined);
  return RUN_MODES.flatMap((mode) => {
    const published = described(publish[mode].policy, 'published');
    const judged = described(scored?.[mode].policy, 'scored');
    if (published === undefined && judged === undefined) return [];
    const lead = [published, judged].filter((part) => part !== undefined).join(' and ');
    const outcome = published && judged ? 'neither published nor judged' : published ? 'not published' : 'not judged';
    return [`Sessions are ${lead} in ${mode} mode, but teamai reads no sessions from ${tools.join(', ')}: they are ${outcome}.`];
  });
}

/**
 * Whether the public Codex will run the hooks teamai wrote in this scope (#955),
 * asked read-only through `codex app-server` `hooks/list`. A check when Codex
 * answers; the trust reminder as a note when it cannot (no `codex` on PATH, the
 * app-server failed). Nothing when teamai wrote no Codex hook here. A failing
 * build check when the Codex builds teamai found disagree on version (#1244).
 */
async function codexHookTrust(ctx: DoctorContext): Promise<{ checks: Check[]; notes: string[] }> {
  const report = ctx.teamConfig ? await readCodexHookTrustForScope(ctx.teamConfig, ctx.localConfig) : null;
  if (!report) return { checks: [], notes: [] };
  const skew = report.skew;
  const builds: Check[] = skew
    ? [{ name: 'Codex builds agree', source: 'local', check: async () => false, fix: codexBuildSkewMessage(skew) }]
    : [];
  if (report.kind !== 'listed') {
    const reason = report.kind === 'failed' ? ` (could not ask Codex: ${report.reason})` : '';
    return { checks: builds, notes: [`${codexTrustReminder()}${reason}`] };
  }
  const notLoaded = report.notTrusted.some((h) => h.status === 'not loaded');
  const notTrusted = report.notTrusted.map((h) => `${h.command} in ${h.file} (${h.status})`);
  return {
    checks: [...builds, {
      name: 'Codex trusts the teamai hooks',
      source: 'local',
      check: async () => notTrusted.length === 0,
      fix: (notLoaded ? 'For hooks not loaded in a linked worktree, create `.codex/` or start Codex there, then open a new session. ' : '')
        + `Codex will not run: ${notTrusted.join('; ')}. Run \`teamai pull\` to trust them, `
        + 'or trust them in Codex /hooks. If `codexTrustEnabled: false` is set in config.yaml, '
        + 'teamai leaves trusting them to you.',
    }],
    notes: [],
  };
}

/**
 * Resolve the local/team configuration the checks run against. Returns null
 * when TeamAI is not initialized here — the caller decides how to report that.
 */
export async function resolveDoctorContext(options: { gitContext?: GitContext } = {}): Promise<DoctorContext | null> {
  // Read-only: the load never persists a migration (#893).
  const projectConfig = await detectProjectConfig(undefined, undefined, { dryRun: true });
  // A workspace is checked with what it delivers: its own selection and its children's (#913).
  const localConfig = projectConfig ? await readWorkspaceChildren(projectConfig) : await loadLocalConfig({ dryRun: true });
  if (!localConfig) return null;

  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  const toolPaths: TeamaiConfig['toolPaths'] = teamConfig
    ? Object.fromEntries(
      Object.entries(scopedToolPaths(teamConfig, localConfig))
        .filter(([tool]) => !isAgentExcluded(localConfig, tool)),
    )
    : {};
  // Hook checks must look where hooks are actually injected. resolveHookScope
  // maps a non-self project scope to HOME (#264), matching the injection path in
  // init/pull/hooks-cmd — otherwise doctor checks <projectRoot>/.claude while the
  // hooks live in ~/.claude and always reports them missing. The paths have to
  // follow the same scope, or a tool whose user-scope prefix differs from its
  // project-scope one (`qoder-cn`, OpenCode) is probed under the wrong prefix.
  const hookScope = resolveHookScope(localConfig);
  const hookToolPaths: TeamaiConfig['toolPaths'] = teamConfig
    ? Object.fromEntries(
      Object.entries(hookToolPathsForConfig(teamConfig, localConfig))
        .filter(([tool]) => !isAgentExcluded(localConfig, tool)),
    )
    : {};
  const baseDir = hookScope.baseDir;
  const teamEnv = resolvesTeamEnv(localConfig) ? await resolveTeamEnv(localConfig) : undefined;

  return { localConfig, teamConfig, toolPaths, hookToolPaths, baseDir, teamEnv, gitContext: options.gitContext };
}

/**
 * Which caller the registry is being built for.
 *
 * `pull` runs the registry again at the end of an interactive sync, under a
 * budget that covers building it as well as running it. Skills and docs cost a
 * stat per item; rules cost a read per rule per tool and agents parse every
 * spec. Spending the budget on those loses the cheap checks that catch the bug
 * this whole line of work exists for, so they are `doctor`-only.
 *
 * The stage is a property of the caller, not of a check, which is why it is an
 * argument here rather than a third optional flag on `Check` beside `source`
 * and `reportedByPull`.
 */
export type CheckStage = 'pull' | 'doctor';

/**
 * Directories whose lock files the zombie-lock check walks (#1027): the teamai
 * home (the shared locks, every partition's worktree locks, votes/queue/…),
 * plus the business repo's `.teamai` (the bootstrap lock), when there is one.
 */
function zombieLockRoots(localConfig: LocalConfig): string[] {
  const roots = [getTeamaiHomeDir()];
  if (localConfig.repo.businessRepoRoot) roots.push(path.join(localConfig.repo.businessRepoRoot, '.teamai'));
  return roots;
}

/**
 * The check registry. Exported so callers other than `teamai doctor` can run
 * the same diagnostics and act on the result.
 */
export async function buildChecks(ctx: DoctorContext, stage: CheckStage = 'doctor'): Promise<Check[]> {
  const { localConfig, teamConfig, toolPaths, hookToolPaths, baseDir } = ctx;
  // A member's `init --provider` choice outranks the team's provider (#789).
  const providerName = localConfig.provider ?? teamConfig?.provider;
  const checks: Check[] = [];

  // Provider-specific checks: gf CLI only needed for TGit, gh CLI for GitHub
  if (providerName === 'tgit') {
    // Dynamic import to avoid loading gf-cli code when not needed
    const { isGfInstalled, gfIsAuthenticated } = await import('./providers/tgit/index.js');
    checks.push(
      {
        name: 'gf CLI is installed',
        source: 'provider',
        check: async () => isGfInstalled(),
        fix: 'Run `teamai init` to install gf CLI automatically',
      },
      {
        name: 'gf CLI is authenticated',
        source: 'provider',
        check: async () => gfIsAuthenticated(),
        fix: 'Run `teamai init` to authenticate via gf auth login',
      },
    );
  } else if (providerName === 'github') {
    // Dynamic import to avoid loading gh-cli code when not needed
    const { isGhInstalled, ghIsAuthenticated } = await import('./providers/github/index.js');
    checks.push(
      {
        name: 'gh CLI is installed',
        source: 'provider',
        check: async () => isGhInstalled(),
        fix: 'Install from https://cli.github.com/ or run `brew install gh`',
      },
      {
        name: 'gh CLI is authenticated',
        source: 'provider',
        check: async () => ghIsAuthenticated(),
        fix: 'Run `gh auth login` to authenticate',
      },
    );
  } else if (providerName === 'gitlab') {
    // GitLab needs no CLI — only a Personal Access Token.
    const { gitlabIsAuthenticated } = await import('./providers/gitlab/index.js');
    checks.push({
      name: 'GitLab token is configured',
      source: 'provider',
      check: async () => gitlabIsAuthenticated(),
      fix: 'Export GITLAB_TOKEN (a Personal Access Token with `api` scope). '
        + 'GITLAB_PRIVATE_TOKEN and GITLAB_PAT are accepted as aliases.',
    });
  } else if (providerName === 'gitcode') {
    // GitCode needs no CLI — only a Personal Access Token (env or ~/.netrc).
    const { gitcodeIsAuthenticated } = await import('./providers/gitcode/index.js');
    checks.push({
      name: 'GitCode token is configured',
      source: 'provider',
      check: async () => gitcodeIsAuthenticated(),
      fix: 'Export GITCODE_TOKEN (a GitCode Personal Access Token), or run `teamai init` '
        + 'to paste one interactively. GC_TOKEN is accepted as an alias.',
    });
  }

  checks.push(
    {
      name: 'Team repo exists locally',
      source: 'local',
      check: async () => pathExists(localConfig.repo.localPath),
      fix: 'Run `teamai init` to clone the team repo',
    },
    {
      name: 'Team config (teamai.yaml) is valid',
      source: 'local',
      check: async () => {
        const config = await loadTeamConfig(localConfig.repo.localPath);
        return config !== null;
      },
      fix: 'Check teamai.yaml in team repo for syntax errors',
    },
    {
      // A contribution is kept locally when it cannot be published. Without
      // this check a member whose pushes are rejected queues notes forever and
      // is told each time that the next pull will retry.
      name: 'Contributed learnings are published',
      source: 'local',
      // pullForScope warns about the queue on its own, with the push error
      // attached; this check is the standing version of it for `teamai doctor`.
      reportedByPull: 'pending-learnings',
      check: async () => {
        const { listPendingLearnings } = await import('./utils/pending-learnings.js');
        return (await listPendingLearnings(localConfig)).length === 0;
      },
      fix: 'Run `teamai pull` to publish them. If they stay queued, check that you '
        + 'can push to the team repo (run with --verbose to see the push error).',
    },
    {
      // A score label waits on this machine until a push or a pull publishes it.
      name: 'Score labels are published',
      source: 'local',
      check: async () => {
        const { LabelStore } = await import('./scorers/label-store.js');
        return await LabelStore.unpublished(localConfig) === 0;
      },
      fix: 'Run `teamai score --push` to publish them; it says why when it cannot.',
    },
    {
      // A dead process's lock cannot block anything — the next writer of that
      // same lock reclaims it — but a leftover file is exactly the noise #1027
      // reports, and the only way a SIGKILLed run ever gets cleaned up.
      name: 'No lock files are left behind by dead processes',
      source: 'local',
      informational: true,
      check: async () => {
        const { listZombieLocks } = await import('./update.js');
        return (await listZombieLocks(zombieLockRoots(localConfig))).length === 0;
      },
      fix: 'Run `teamai doctor --fix` to remove them. They are reclaimed anyway the '
        + 'next time the same lock is taken; removing them only clears the noise.',
    },
    ...buildWorkspaceChildrenChecks(localConfig),
    ...await buildGitHookChecks(localConfig, stage),
    ...await buildTrackedHookIndexCheck(localConfig),
    ...buildToolRootChecks(localConfig, teamConfig),
    ...buildToolHomeChecks(localConfig),
    ...await buildEnabledToolChecks(ctx),
    ...await buildHeldSurfaceChecks(ctx),
    ...await buildHookChecks(toolPaths, hookToolPaths, baseDir, installOf(teamConfig ?? { toolPaths }, localConfig)),
    ...await buildDeliveryChecks(ctx),
    ...await buildSkillDirChecks(ctx),
    ...await buildRecordedPlaceChecks(ctx, 'rules'),
    ...await buildRecordedPlaceChecks(ctx, 'blocks'),
    ...await buildAgentPlaceChecks(ctx),
    // Built only for `doctor`: the work is in building these, not in running
    // them, so skipping them post-pull is what keeps the budget for the rest.
    ...(stage === 'doctor' ? await buildRulesDeliveryChecks(ctx) : []),
    ...(stage === 'doctor' ? await buildAgentsDeliveryChecks(ctx) : []),
    ...(stage === 'doctor' ? await buildInstructionDeliveryChecks(ctx) : []),
    ...await buildAgentModelChecks(ctx, stage),
    ...await buildMcpDeliveryChecks(ctx),
    ...await buildMcpReadFileChecks(ctx),
    ...await buildLocalAgentMcpLocationChecks(ctx),
    ...await buildCodexProjectTrustCheck(ctx),
    ...await buildMcpGitExcludeCheck(ctx),
    ...await buildDeliveredGitExcludeChecks(ctx),
    ...await buildLocalAgentGitExcludeChecks(),
    ...await buildDocsCheck(ctx),
    ...await buildEnvDeliveryCheck(ctx),
    ...await buildEntryResolutionChecks(ctx),
    ...buildSecretValuesCheck(ctx),
    ...await buildEntryScopeKeyCheck(ctx),
  );

  return checks;
}

/**
 * A workspace with children (#913): every folder set up under it is read, or
 * the ones left out are named with what to do. None for a scope without
 * children.
 */
function buildWorkspaceChildrenChecks(localConfig: LocalConfig): Check[] {
  const found = localConfig.children;
  if (!found) return [];
  return [{
    name: 'The workspace reads every child set up under it',
    source: 'local',
    reportedByPull: 'workspace-children',
    check: async () => found.leftOut.length === 0,
    fix: `${found.leftOut.map((child) => `${child.path} is left out: ${child.reason}`).join('; ')}. `
      + 'Set each one up with this workspace\'s team repo (`teamai init <team repo>` there) to include it.',
  }];
}

/**
 * Project scope: whether teamai's git hook is installed (`doctor` only: pull
 * installs it, and a member on an old git would hear it after every pull), and
 * the failure its last silent run recorded (git-hook.ts), which `pull`
 * mentions itself. A project root outside git has no hook to report.
 */
async function buildGitHookChecks(localConfig: LocalConfig, stage: CheckStage): Promise<Check[]> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return [];
  const { gitHookStatus, describeMissingGitHook, readGitHookFailure, describeGitHookFailure } = await import('./git-hook.js');
  // A project root that no longer exists cannot be asked (git refuses the cwd).
  const status = stage === 'doctor' ? await gitHookStatus(localConfig.projectRoot).catch(() => null) : null;
  const failure = await readGitHookFailure(localConfig);
  const report = failure ? describeGitHookFailure(failure) : null;
  const installed: Check[] = !status || (!status.installed && status.reason === 'not-a-repository') ? [] : [{
    name: 'Git hook syncs new worktrees and git pull',
    source: 'local',
    check: async () => status.installed,
    ...(status.installed ? {} : { fix: describeMissingGitHook(status) }),
  }];
  return [
    ...installed,
    report
      ? {
        name: `Last git hook run failed: ${report.message}`,
        source: 'local',
        reportedByPull: 'git-hook-failure',
        check: async () => false,
        fix: report.fix,
      }
      : { name: 'No git hook failure recorded', source: 'local', check: async () => true },
  ];
}

/**
 * Project scope: the hook index and the package lock a release before #993
 * kept in the working tree, when git tracks them. Pull moves the index's
 * records to the data home, and the lock is copied there, but a tracked file
 * is left for the member to untrack (`migrateLegacyManagedHooks`,
 * `packageLockDir`).
 */
async function buildTrackedHookIndexCheck(localConfig: LocalConfig): Promise<Check[]> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return [];
  const root = localConfig.projectRoot;
  const { gitTracks } = await import('./git-exclude.js');
  const legacyFiles = [
    { file: legacyManagedHooksPath(root), what: 'hook index', after: 'teamai pull deletes it once nothing in it is needed' },
    { file: path.join(root, '.teamai', 'teamai.lock'), what: 'package lock', after: 'the next `teamai packages install` or session start deletes it' },
  ];
  const checks: Check[] = [];
  for (const { file, what, after } of legacyFiles) {
    if (!await pathExists(file) || (await gitTracks(file)).kind !== 'tracked') continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    checks.push({
      name: `${file} is tracked by git`,
      source: 'local',
      informational: true,
      check: async () => false,
      fix: `teamai keeps its ${what} in its data home now; this copy is left over from an older release. `
        + `Run \`git rm --cached ${rel}\` in ${root} and commit, so it leaves the repository; ${after}.`,
    });
  }
  return checks;
}

/**
 * Run every check once, in registry order. `onResult` reports each one as it
 * lands, so the human rendering keeps streaming while a slow check (a provider
 * CLI auth probe) is still running.
 */
export async function runChecks(
  checks: Check[],
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, check, fix } of checks) {
    const ok = await check();
    const result: CheckResult = ok ? { name, ok } : { name, ok, fix };
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** The only writer of the JSON channel. */
function emitReport(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/**
 * The human rendering of one finished check, as lines. Exported because `pull`
 * prints the same shape through the logger rather than stdout — one definition
 * of the glyphs and the indent, two sinks.
 */
export function formatCheckResult({ name, ok, fix }: CheckResult): string[] {
  if (ok) return [`  ✔ ${name}`];
  return fix ? [`  ✖ ${name}`, `    → ${fix}`] : [`  ✖ ${name}`];
}

/** The run mode row: the mode and its source, with a warning when TEAMAI_MODE held a value it ignored. */
function formatRunMode(runMode: ExplainedRunMode): string {
  const { mode, source } = runMode;
  return 'ignored' in runMode && runMode.ignored !== undefined
    ? `  ⚠ Run mode: ${mode} (${source}). TEAMAI_MODE="${runMode.ignored}" is not attended or unattended, so it is ignored.`
    : `  ✔ Run mode: ${mode} (${source})`;
}

function renderResult(result: CheckResult): void {
  for (const line of formatCheckResult(result)) console.log(line);
}

export async function doctor(options: DoctorOptions): Promise<boolean> {
  const jsonMode = options.json === true;
  // In JSON mode stdout is a data channel: route every log line to stderr so a
  // consumer can parse stdout whole (same trick as hook-dispatch commands).
  if (jsonMode) setStderrOnly(true);

  log.info('Running diagnostics...\n');
  // Information, not a check: an unknown TEAMAI_MODE fails nothing.
  const runMode = explainRunMode(process.env);
  const ctx = await resolveDoctorContext();
  if (!ctx) {
    const notInitialized: CheckResult = {
      name: 'TeamAI is not initialized',
      ok: false,
      fix: 'Run `teamai init <repo-url>` in a project, or add `--scope user` for all projects',
    };
    if (jsonMode) {
      emitReport({ ok: false, scope: null, runMode, checks: [notInitialized] });
    } else {
      console.log('  Scope: not initialized\n');
      console.log(formatRunMode(runMode));
      renderResult(notInitialized);
      console.log('');
    }
    log.warn('Initialization is required before diagnostics can run.');
    return false;
  }

  const { localConfig } = ctx;
  const scope = localConfig.scope ?? 'user';
  if (!jsonMode) {
    const scopeLabel = `${installScopeName(scope)}${scope === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`;
    console.log(`  Scope: ${scopeLabel}\n`);
    console.log(formatRunMode(runMode));
  }

  // --fix runs before the checks, so the report reflects the post-cleanup state.
  if (options.fix) {
    const { removeZombieLocks } = await import('./update.js');
    const removed = await removeZombieLocks(zombieLockRoots(localConfig));
    if (removed.length > 0) {
      log.info(`Removed ${removed.length} lock file(s) left behind by dead processes:`);
      for (const p of removed) log.info(`  ${p}`);
      log.info('');
    }
  }

  // Doctor only: it spawns `codex app-server`, which the post-pull pass skips.
  const codexTrust = await codexHookTrust(ctx);
  const results = await runChecks([...await buildChecks(ctx), ...codexTrust.checks], jsonMode ? undefined : renderResult);
  let allPassed = results.every((r) => r.ok);

  const { pkgDoctorReport } = await import('./pkg/commands.js');
  const packageReport = await pkgDoctorReport(localConfig, process.cwd());
  if (packageReport && !packageReport.allPassed) allPassed = false;

  // Info, not checks: which namespace item or entry replaces which root one
  // (#707), a model alias an agent uses from a namespace not active here, and
  // how each alias agent's model resolved in each tool (#830).
  const { ruleChannelNotes } = await import('./resources/rules.js');
  const { dshSandboxNote } = await import('./dsh-hooks.js');
  const { scorerNotes } = await import('./doctor-scorers.js');
  const { shadowedWorkflowSkills } = await import('./workflow/discovery/workflow-skills.js');
  const notes = [
    ...await buildNamespaceNotes(ctx),
    ...await entryNamespaceNotes(ctx),
    // Hook entries a pull keeps as the member's (#993): the team's own entries are written beside them.
    ...ctx.teamConfig ? await keptTeamHookEntries(ctx.teamConfig, localConfig) : [],
    ...await aliasNamespaceNotes(ctx),
    ...await agentModelNotes(ctx),
    // Invalid scorer files and scorers a workflow step lists without one, which a silent hook pull never shows.
    ...await scorerNotes(localConfig),
    // A team or member skill named workflow-<name> stands in for the skill pull generates (#1086).
    ...ctx.teamConfig ? await shadowedWorkflowSkills({ teamConfig: ctx.teamConfig, localConfig }) : [],
    ...(await envAdvisories(localConfig, ctx.teamConfig, ctx.teamEnv)).map(describeEnvAdvisory),
    // A team MCP server a tool cannot use over its transport.
    ...await mcpTransportNotes(ctx),
    ...await envLoaderNotes(ctx),
    ...await ruleChannelNotes(localConfig),
    ...[await dshSandboxNote(localConfig)].filter((note): note is string => note !== null),
    ...codexTrust.notes,
    ...toolPathsDroppedKeyNotes(ctx),
    usageReportNote(ctx),
    ...SessionPolicy.publish(localConfig, ctx.teamConfig).problems.map((problem) => `${problem}.`),
    ...await unreadSessionToolNotes(ctx),
    // What git sees of the delivered team resources, and what no pull changes (#915).
    ...await deliveredGitExcludeNotes(ctx),
    ...await localAgentGitExcludeNotes(),
    ...await keptDocNotes(ctx),
    ...await skillReadNotes(ctx),
    ...await recordedPlaceNotes(ctx, 'rules'),
    ...await recordedPlaceNotes(ctx, 'blocks'),
  ];

  if (jsonMode) {
    emitReport({
      ok: allPassed,
      scope,
      runMode,
      checks: results,
      memberSettings: await memberSettingsReport(ctx),
      // pkgDoctorReport renders its own lines; they are human text, not checks.
      ...(packageReport ? { packages: { ok: packageReport.allPassed, lines: packageReport.lines } } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
    return allPassed;
  }

  if (packageReport) {
    for (const line of packageReport.lines) console.log(line);
  }

  if (notes.length > 0) {
    console.log('');
    for (const note of notes) log.info(note);
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
  return allPassed;
}
