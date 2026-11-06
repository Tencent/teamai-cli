/**
 * Which level set each member setting (#1459): the environment or a flag, this scope's config, ~/.teamai/config.yaml,
 * the team's teamai.yaml, or the default. `teamai doctor` prints it as `Member settings`, and the dashboard shows it
 * for the selected workspace.
 */
import path from 'node:path';
import { parseYaml } from './utils/yaml.js';
import { z } from 'zod';
import { hasUserScopeInstall, loadLocalConfig, loadMemberSettings, loadTeamConfig } from './config.js';
import { RUN_MODES, type RunMode } from './launch-context.js';
import { SessionPolicy } from './session-flow/session-policy.js';
import { memberTools } from './tool-launch/member-tools.js';
import { resolveDefaultDriver } from './default-driver.js';
import { DEFAULT_RETENTION, resolveRetention } from './workflow/retention.js';
import {
  getDataHome,
  getTeamaiHomeDir,
  isContributeHintEnabled,
  isMrHintEnabled,
  isRecallEnabled,
  isUsageReportEnabled,
  MemberSettingsSchema,
  resolveAutoCompactTokens,
  resolveCoAuthor,
  type JsonValue,
  type LocalConfig,
  type TeamaiConfig,
  JsonObjectSchema,
} from './types.js';
import { readFileSafe } from './utils/fs.js';
import { parseJson } from './utils/json.js';

/** `http-team`: an HTTP team repo, which keeps no session archive, so it turns session publishing off whatever a level sets. */
export type MemberSettingLevel = 'environment' | 'scope' | 'machine' | 'team' | 'http-team' | 'default';

export interface MemberSettingSource {
  level: MemberSettingLevel;
  value?: JsonValue;
  file?: string;
  variable?: string;
  /** False when this value is visible for context but is not the runtime winner. */
  used?: boolean;
}

export interface MemberSettingsReport {
  key: string;
  effective?: JsonValue;
  source?: MemberSettingSource;
  levels: MemberSettingSource[];
}

/** Where a value came from, and its short name among the levels below. */
interface MemberSettingLevelText {
  from: string;
  short: string;
}

/** A level as doctor's text names it: where a value came from, and its short name among the levels below. */
function describeMemberSettingLevel({ level, file, variable }: MemberSettingSource, scope: LocalConfig['scope']): MemberSettingLevelText {
  switch (level) {
    case 'environment': return { from: variable ?? 'the environment', short: variable ?? 'environment' };
    // This machine's config is the user scope's: this scope's own in user scope, and in a workspace the one that holds
    // a setting the user scope decides for the whole machine.
    case 'scope': return file === path.join(getTeamaiHomeDir(), 'config.yaml')
      ? { from: `the user config ${file}${scope === 'user' ? ", also this machine's" : ''}`, short: 'user config' }
      : { from: `the workspace config ${file}`, short: 'workspace' };
    case 'machine': return { from: `the machine config ${file}`, short: 'machine' };
    case 'team': return { from: "the team's teamai.yaml", short: 'team' };
    case 'http-team': return { from: 'the HTTP team repo, which keeps no session archive', short: 'HTTP team repo' };
    case 'default': return { from: 'the default', short: 'default' };
    default: {
      const unhandled: never = level;

      return unhandled;
    }
  }
}

/** A member setting some level sets: its value in effect, the level that won, the levels below it, and the values set but not used. */
export interface MemberSettingRow {
  key: string;
  value: JsonValue | undefined;
  source: MemberSettingSource;
  below: MemberSettingSource[];
  /** Values set but not read, such as a workspace's own updatePolicy while the user scope decides it. */
  unused: MemberSettingSource[];
}

/** The settings of `reports` that some level sets, as doctor and the dashboard show them. */
export function memberSettingRows(reports: MemberSettingsReport[]): MemberSettingRow[] {
  return reports.flatMap(({ key, effective, source, levels }) => {
    if (!source || (source.level === 'default' && levels.every(({ used }) => used !== false))) return [];
    const below = levels.slice(levels.indexOf(source) + 1).filter(({ level, used }) => level !== 'default' && used !== false);

    return [{ key, value: effective, source, below, unused: levels.filter(({ used }) => used === false) }];
  });
}

/** Doctor's `Member settings` lines: each setting some level sets, its value in effect, the level that won, and the values below it. */
export function memberSettingLines(reports: MemberSettingsReport[], scope: LocalConfig['scope']): string[] {
  // A string is shown as written, any other value as JSON.
  const shown = (value: JsonValue | undefined): string => {
    const text = z.string().safeParse(value);

    return text.success ? text.data : JSON.stringify(value);
  };

  return memberSettingRows(reports).map(({ key, value, source, below, unused }) => {
    const notes = [
      ...below.map((lower, index) => `the ${describeMemberSettingLevel(lower, scope).short}${index === 0 ? ' says' : ''} ${shown(lower.value)}`),
      ...unused.map((ignored) => `the ${describeMemberSettingLevel(ignored, scope).short}'s ${shown(ignored.value)} is not used`),
    ];

    return `  ${key}: ${shown(value)}, from ${describeMemberSettingLevel(source, scope).from}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
  });
}

const MEMBER_SETTING_REPORT_KEYS = [
  'ai.tool',
  'workflows.tools.default',
  'workflows.max_parallel',
  'workflows.auto_approve',
  'workflows.sandbox',
  'workflows.allow.network',
  'workflows.retention',
  'workflows.driver',
  'recallEnabled',
  'contributeHintEnabled',
  'mrHintEnabled',
  'coAuthorEnabled',
  'usageReportEnabled',
  'codexTrustEnabled',
  'sessions.publish.attended',
  'sessions.publish.unattended',
  'updatePolicy',
  'autoCompactTokens',
] as const;

/** The run mode a `sessions.publish.<mode>` report key names. */
function publishMode(key: string): RunMode | undefined {
  return RUN_MODES.find((mode) => key === `sessions.publish.${mode}`);
}

const MACHINE_WIDE_MEMBER_SETTINGS = new Set(['updatePolicy', 'autoCompactTokens']);

/** A JSON object of a config tree, such as a config file or one of its sections. */
const ConfigObjectSchema = JsonObjectSchema;

type ConfigObject = z.infer<typeof ConfigObjectSchema>;

/** A config tree's `workflows` section, as far as its report keys go; a part that is not an object reads as absent. */
const WorkflowsSectionSchema = z.object({
  tools: ConfigObjectSchema.optional().catch(undefined),
  allow: ConfigObjectSchema.optional().catch(undefined),
});

/** The object `value` holds, or undefined for any other JSON value. */
function configObject(value: JsonValue | undefined): ConfigObject | undefined {
  return value instanceof Object && !Array.isArray(value) ? value : undefined;
}

function addWorkflowReportKeys(target: Set<string>, tree: JsonValue | undefined): void {
  const workflows = WorkflowsSectionSchema.safeParse(configObject(readPath(tree, ['workflows'])));

  if (!workflows.success) return;
  const { tools, allow } = workflows.data;

  if (tools) {
    for (const name of Object.keys(tools)) target.add(`workflows.tools.${name}`);
  }

  if (allow && Object.prototype.hasOwnProperty.call(allow, 'env')) target.add('workflows.allow.env');
}

/** Map settings need one provenance row per key: one merged object cannot name two winners. */
function addModelAliasReportKeys(target: Set<string>, tree: JsonValue | undefined): void {
  const aliases = configObject(readPath(tree, ['modelAliases']));

  if (!aliases) return;

  for (const name of Object.keys(aliases)) target.add(`modelAliases.${name}`);
}

/** The `ai.tool` a level sets: a non-empty string. */
const AiToolSettingSchema = z.string().min(1).optional().catch(undefined);

/** Report keys use dots as separators except for literal map-entry names. */
function reportPathParts(key: string): string[] {
  if (key.startsWith('workflows.tools.')) return ['workflows', 'tools', key.slice('workflows.tools.'.length)];

  if (key.startsWith('modelAliases.')) return ['modelAliases', key.slice('modelAliases.'.length)];

  return key.split('.');
}

function readPath(tree: JsonValue | undefined, parts: string[]): JsonValue | undefined {
  let current = tree;

  for (const part of parts) {
    const node = configObject(current);

    if (!node || !(part in node)) return undefined;
    current = node[part];
  }

  return current;
}

/**
 * A config as the report reads its values: as JSON, the form doctor prints them in and the dashboard sends them
 * in. A value JSON has no form for, such as an undefined field, reads as absent, as it is in both.
 */
function asJsonTree<TConfig>(config: TConfig): JsonValue | undefined {
  const text = JSON.stringify(config);

  return text === undefined ? undefined : parseJson(text);
}

async function readYamlObject(file: string): Promise<ConfigObject> {
  try {
    return configObject(asJsonTree(parseYaml(await readFileSafe(file) ?? ''))) ?? {};
  } catch {
    return {};
  }
}

function settingSource(level: MemberSettingLevel, value: JsonValue | undefined, file?: string, variable?: string, used = true): MemberSettingSource {
  const source: MemberSettingSource = { level, value };

  if (file) source.file = file;

  if (variable) source.variable = variable;

  if (!used) source.used = false;

  return source;
}

export async function memberSettingsReport(ctx: { localConfig: LocalConfig; teamConfig: TeamaiConfig | null }): Promise<MemberSettingsReport[]> {
  const machineFile = path.join(getTeamaiHomeDir(), 'config.yaml');
  const rawMachine = await readYamlObject(machineFile);
  const machine = await loadMemberSettings(machineFile);
  const machineTree = asJsonTree(machine);
  const scopeFile = getDataHome(ctx.localConfig) + path.sep + 'config.yaml';
  const rawScope = ctx.localConfig.scope === 'user' ? rawMachine : await readYamlObject(scopeFile);
  const userConfig = ctx.localConfig.scope === 'user' ? ctx.localConfig : await loadLocalConfig({ dryRun: true });
  const userSettings = asJsonTree(userConfig?.scope === 'user' ? userConfig : {});

  // updatePolicy and autoCompactTokens are machine-wide: when a user install
  // exists, it decides these values even while doctor is inspecting a project.
  // Load the same team file that pull/update use for that deciding install.
  const decidingTeam = userConfig?.scope === 'user'
    ? await loadTeamConfig(userConfig.repo.localPath)
    : ctx.teamConfig;

  const reportKeys = new Set<string>(MEMBER_SETTING_REPORT_KEYS);
  addWorkflowReportKeys(reportKeys, rawMachine);
  addWorkflowReportKeys(reportKeys, rawScope);
  addModelAliasReportKeys(reportKeys, machineTree);
  addModelAliasReportKeys(reportKeys, rawScope);

  const teamValue = (key: string): JsonValue | undefined => {
    const selectedTeam = MACHINE_WIDE_MEMBER_SETTINGS.has(key) ? decidingTeam : ctx.teamConfig;
    const selectedSharing = selectedTeam?.sharing;

    if (key === 'recallEnabled') return selectedSharing?.recall?.enabled;

    if (key === 'contributeHintEnabled') return selectedSharing?.contributeHint?.enabled;

    if (key === 'mrHintEnabled') return selectedSharing?.mrHint?.enabled;

    if (key === 'coAuthorEnabled') return selectedSharing?.coAuthor?.enabled;

    if (key === 'autoCompactTokens') return selectedSharing?.autoCompact?.tokens;

    if (key === 'usageReportEnabled') return selectedTeam?.usageReport;

    if (key === 'workflows.retention') return asJsonTree(selectedTeam?.workflows?.retention);

    if (key === 'workflows.driver') return asJsonTree(selectedTeam?.workflows?.driver);

    if (key === 'updatePolicy') return selectedTeam?.autoUpdate === false ? 'skip' : selectedTeam?.autoUpdate === true ? 'auto' : undefined;
    const mode = publishMode(key);

    if (mode) return SessionPolicy.readPublish('teamai.yaml', ctx.teamConfig?.sessions).set[mode]?.policy;

    return undefined;
  };

  const defaultValue = (key: string): JsonValue | undefined => {
    if (key === 'workflows.max_parallel') return 1;

    if (key === 'workflows.auto_approve') return false;

    if (key === 'workflows.allow.network') return true;

    if (key === 'workflows.retention') return DEFAULT_RETENTION;

    if (key === 'workflows.driver') return 'local';

    if (key === 'recallEnabled') return false;

    if (key === 'contributeHintEnabled' || key === 'mrHintEnabled' || key === 'usageReportEnabled') return true;

    if (key === 'coAuthorEnabled' || key === 'codexTrustEnabled') return true;

    if (key === 'updatePolicy') return 'auto';
    const mode = publishMode(key);

    if (mode) return SessionPolicy.publishDefaults[mode];

    return undefined;
  };

  const publishing = SessionPolicy.publish(ctx.localConfig, ctx.teamConfig).policies;
  const retention = await resolveRetention(ctx.localConfig, ctx.teamConfig);
  const defaultDriver = await resolveDefaultDriver(ctx.localConfig, ctx.teamConfig);

  const levelsFor = (key: string): MemberSettingSource[] => {
    const parts = reportPathParts(key);
    let scopeValue = readPath(rawScope, parts);
    let scopeSourceFile = ctx.localConfig.scope === 'user' ? machineFile : scopeFile;
    const machineWideUser = MACHINE_WIDE_MEMBER_SETTINGS.has(key) && userConfig?.scope === 'user';

    if (machineWideUser) {
      scopeValue = readPath(userSettings, parts);
      scopeSourceFile = machineFile;
    }

    let machineValue = readPath(machineTree, parts);

    if (key === 'ai.tool') {
      scopeValue = AiToolSettingSchema.parse(scopeValue);
      machineValue = AiToolSettingSchema.parse(machineValue);
    }

    const mode = publishMode(key);

    if (mode) {
      scopeValue = SessionPolicy.readPublish('config.yaml', readPath(rawScope, ['sessions'])).set[mode]?.policy;
      machineValue = SessionPolicy.readPublish('config.yaml', machine.sessions).set[mode]?.policy;
    }

    // A workspace's own sessions replaces the machine's whole, whatever run modes it sets.
    const machineShadowed = mode !== undefined && ctx.localConfig.scope !== 'user' && readPath(rawScope, ['sessions']) !== undefined;
    const levels: MemberSettingSource[] = [];

    if (key === 'ai.tool' && process.env.TEAMAI_AI_TOOL) levels.push(settingSource('environment', process.env.TEAMAI_AI_TOOL, undefined, 'TEAMAI_AI_TOOL'));

    if (key === 'recallEnabled' && process.env.TEAMAI_RECALL_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_RECALL_DISABLED'));

    if (key === 'contributeHintEnabled' && process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_CONTRIBUTE_HINT_DISABLED'));

    if (key === 'mrHintEnabled' && process.env.TEAMAI_MR_HINT_DISABLED === '1') levels.push(settingSource('environment', false, undefined, 'TEAMAI_MR_HINT_DISABLED'));

    if (!machineWideUser && scopeValue !== undefined) levels.push(settingSource('scope', scopeValue, scopeSourceFile));

    if (machineValue !== undefined && ctx.localConfig.scope !== 'user' && !machineWideUser && !machineShadowed) {
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

    if (machineShadowed && machineValue !== undefined) levels.push(settingSource('machine', machineValue, machineFile, undefined, false));

    // resolveRetention and resolveDefaultDriver skip a wrong value, and the next level decides: every level above the one
    // they took is unused.
    const resolved = key === 'workflows.retention' ? retention : key === 'workflows.driver' ? defaultDriver : undefined;

    if (resolved) {
      const decided = levels.findIndex((level) => (level.level === 'default' ? resolved.file === undefined : level.file === resolved.file));

      return levels.map((level, at) => (at < decided ? { ...level, used: false } : level));
    }

    if (mode && publishing[mode].source.kind === 'http-team') {
      return [settingSource('http-team', 'off'), ...levels.map((level) => level.level === 'default' ? level : { ...level, used: false })];
    }

    return levels;
  };

  const decidingConfig = userConfig?.scope === 'user' ? userConfig : ctx.localConfig;
  const aiTool = async (): Promise<string | undefined> => (await memberTools(ctx.localConfig))[0]?.tool;

  const effectiveValue = async (key: string, levels: MemberSettingSource[]): Promise<JsonValue | undefined> => {
    if (key === 'ai.tool') return await aiTool();

    if (key === 'recallEnabled') return isRecallEnabled(ctx.localConfig, ctx.teamConfig ?? {});

    if (key === 'contributeHintEnabled') return isContributeHintEnabled(ctx.localConfig, ctx.teamConfig ?? {});

    if (key === 'mrHintEnabled') return isMrHintEnabled(ctx.localConfig, ctx.teamConfig ?? {});

    if (key === 'usageReportEnabled') return isUsageReportEnabled(ctx.localConfig, ctx.teamConfig ?? {});

    if (key === 'workflows.retention') return retention.text;

    if (key === 'workflows.driver') return defaultDriver.text;

    if (key === 'coAuthorEnabled') return resolveCoAuthor(ctx.localConfig, ctx.teamConfig ?? {}) ?? true;
    const mode = publishMode(key);

    if (mode) return publishing[mode].policy;

    // A 0 opts out, which resolves to nothing set: show the 0 the member wrote.
    if (key === 'autoCompactTokens') return resolveAutoCompactTokens(decidingConfig, decidingTeam ?? {}) ?? decidingConfig.autoCompactTokens;

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

/** The keys of a ~/.teamai/config.yaml with no install that no command reads: only its member settings apply. */
export async function machineUnreadKeys(): Promise<string[]> {
  if (await hasUserScopeInstall()) return [];

  return Object.keys(await readYamlObject(path.join(getTeamaiHomeDir(), 'config.yaml'))).filter((key) => !(key in MemberSettingsSchema.shape));
}
