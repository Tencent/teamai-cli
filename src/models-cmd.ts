import { autoDetectInit } from './config.js';
import { log } from './utils/logger.js';
import { askQuestion, askSecret, isInteractive } from './utils/prompt.js';
import type { LocalConfig } from './types.js';
import {
  API_KEY_PLACEHOLDER,
  ModelAgentSchema,
  ModelProfileSchema,
  ModelProtocolSchema,
  getLocalValuesPath,
  getTeamIdentity,
  getTeamValuesPath,
  isApiKeyConfigured,
  loadLocalProfiles,
  loadModelInputs,
  loadTeamProfiles,
  profileAgents,
  profileModels,
  profileRefName,
  resolveProfile,
  resolveProfileRef,
  saveLocalProfiles,
  saveModelInputs,
  type ModelAgent,
  type ModelGroup,
  type ModelProtocol,
  type ModelProfilesFile,
  type ProfileRef,
  type StoredModelInput,
} from './models/profile.js';
import {
  ALL_MODEL_AGENTS,
  activeModelProfiles,
  restoreModelProfiles,
  switchModelProfile,
  type ActiveModelProfile,
  type ModelSwitchResult,
} from './models/switch.js';

interface TeamModelsContext {
  team: ModelProfilesFile;
  localConfig?: LocalConfig;
}

async function teamContext(): Promise<TeamModelsContext> {
  let initialized: Awaited<ReturnType<typeof autoDetectInit>>;
  try {
    initialized = await autoDetectInit();
  } catch {
    return { team: { version: 1, profiles: [] } };
  }
  return {
    team: await loadTeamProfiles(initialized.localConfig.repo.localPath),
    localConfig: initialized.localConfig,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function collectAgents(values: string[]): ModelAgent[] {
  return [...new Set(values.flatMap(splitList).map((value) => ModelAgentSchema.parse(value)))];
}

function parseProtocols(value: string | undefined): ModelProtocol[] {
  return splitList(value).map((item) => {
    const parsed = ModelProtocolSchema.safeParse(item);
    if (!parsed.success) throw new Error(`Unknown protocol ${item}. Use ${ModelProtocolSchema.options.join(', ')}.`);
    return parsed.data;
  });
}

async function readSecretStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('--api-key-stdin expects piped stdin');
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  value = value.replace(/[\r\n]+$/, '');
  if (!value) throw new Error('No API key was provided on stdin');
  return value;
}

interface ApiKeyOptions {
  fromEnv?: string;
  apiKeyStdin?: boolean;
}

async function apiKeyFromOptions(options: ApiKeyOptions): Promise<StoredModelInput | undefined> {
  if (options.fromEnv) return { env: options.fromEnv };
  if (options.apiKeyStdin) return { value: await readSecretStdin() };
  return undefined;
}

async function findProfile(reference: string): Promise<{
  ref: ProfileRef;
  local: ModelProfilesFile;
  context: TeamModelsContext;
}> {
  const [context, local] = await Promise.all([teamContext(), loadLocalProfiles()]);
  const ref = resolveProfileRef(reference, context.team, local);
  if (ref.source === 'team' && context.localConfig) ref.team = getTeamIdentity(context.localConfig);
  return { ref, local, context };
}

function valuesPathFor(ref: ProfileRef, context: TeamModelsContext): string {
  if (ref.source === 'local') return getLocalValuesPath();
  if (!context.localConfig) throw new Error('Team model profiles require an initialized TeamAI repository');
  return getTeamValuesPath(context.localConfig);
}

function activeAgentsFor(
  ref: ProfileRef,
  active: Partial<Record<ModelAgent, ActiveModelProfile>>,
): ModelAgent[] {
  const name = profileRefName(ref);
  return (Object.entries(active) as Array<[ModelAgent, ActiveModelProfile]>)
    .filter(([, state]) => state.profile === name && (ref.source === 'local' || !state.team || state.team === ref.team))
    .map(([agent]) => agent);
}

function printResults(results: ModelSwitchResult[], explicitAgents: boolean): void {
  for (const result of results) {
    console.log(`${result.status.padEnd(13)} ${result.message}`);
    if (result.warning) log.warn(result.warning);
  }
  const failing = explicitAgents
    ? ['failed', 'skipped', 'not-installed', 'unsupported']
    : ['failed', 'skipped'];
  if (results.some((result) => failing.includes(result.status))) process.exitCode = 1;
}

export async function modelsList(): Promise<void> {
  const [context, local, active] = await Promise.all([teamContext(), loadLocalProfiles(), activeModelProfiles()]);
  const team = context.localConfig ? getTeamIdentity(context.localConfig) : undefined;
  const refs: ProfileRef[] = [
    ...context.team.profiles.map((profile) => ({ source: 'team' as const, profile, team })),
    ...local.profiles.map((profile) => ({ source: 'local' as const, profile })),
  ];
  if (refs.length === 0) {
    log.info('No model profiles found.');
    return;
  }
  for (const ref of refs) {
    const activeAgents = activeAgentsFor(ref, active);
    console.log(`${profileRefName(ref)}  ${ref.profile.name}  [${profileAgents(ref.profile).join(', ')}]${activeAgents.length ? `  active: ${activeAgents.join(', ')}` : ''}`);
  }
}

export async function modelsShow(reference: string): Promise<void> {
  const { ref, context } = await findProfile(reference);
  const values = await loadModelInputs(valuesPathFor(ref, context));
  const secret = values[profileRefName(ref)]?.API_KEY;
  const activeAgents = activeAgentsFor(ref, await activeModelProfiles());
  console.log(`${profileRefName(ref)} — ${ref.profile.name}`);
  console.log(`API key: ${secret?.env ? `environment ${secret.env}` : secret?.value ? 'configured locally' : 'not configured'}`);
  console.log(`Gateway: ${ref.profile.base_url}`);
  console.log('Models:');
  for (const group of ref.profile.model_groups) {
    console.log(`  ${group.protocols.join(', ')}: ${group.models.join(', ')}`);
  }
  console.log(`Agents: ${profileAgents(ref.profile).join(', ')}`);
  if (activeAgents.length) console.log(`Active: ${activeAgents.join(', ')}`);
}

interface AddOptions extends ApiKeyOptions {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
}

function parseProfile(data: unknown): ProfileRef['profile'] {
  const result = ModelProfileSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid model profile: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'profile'}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}

function sameProtocols(left: ModelProtocol[], right: ModelProtocol[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

/**
 * Serve `models` over one more protocol. A model keeps a single group, so a
 * model gaining a protocol moves to the group for its new protocol set. A new
 * group is placed next to the old one so the catalog's first model (the
 * default) stays first.
 */
function addModelProtocol(groups: ModelGroup[], models: string[], protocol: ModelProtocol): ModelGroup[] {
  const updated = groups.map((group) => ({ protocols: [...group.protocols], models: [...group.models] }));
  for (const model of models) {
    const sourceIndex = updated.findIndex((group) => group.models.includes(model));
    const source = updated[sourceIndex];
    if (source?.protocols.includes(protocol)) continue;
    const protocols = ModelProtocolSchema.options.filter((item) => item === protocol || source?.protocols.includes(item));
    // Before its old group only if it led that group; otherwise after it.
    const position = !source ? updated.length : source.models[0] === model ? sourceIndex : sourceIndex + 1;
    if (source) source.models = source.models.filter((item) => item !== model);
    let target = updated.find((group) => sameProtocols(group.protocols, protocols));
    if (!target) {
      target = { protocols, models: [] };
      updated.splice(position, 0, target);
    }
    target.models.push(model);
  }
  return updated.filter((group) => group.models.length > 0);
}

export async function modelsAdd(id: string, options: AddOptions): Promise<void> {
  const [local, context] = await Promise.all([loadLocalProfiles(), teamContext()]);
  if (local.profiles.some((profile) => profile.id === id)) {
    throw new Error(`Local model profile already exists: ${id}`);
  }
  if (context.team.profiles.some((profile) => profile.id === id)) {
    throw new Error(`The team already has a model profile named ${id}; choose another ID`);
  }
  const name = options.name ?? await askQuestion('Profile name: ');
  const protocols = parseProtocols(options.protocol
    ?? await askQuestion(`Protocols (comma-separated: ${ModelProtocolSchema.options.join(', ')}): `));
  const baseUrl = options.baseUrl ?? await askQuestion('Gateway root URL: ');
  const models = splitList(options.model ?? await askQuestion('Model IDs (comma-separated): '));
  const profile = parseProfile({
    id, name, base_url: baseUrl, api_key: API_KEY_PLACEHOLDER,
    model_groups: [{ protocols, models }],
  });
  const secret = await apiKeyFromOptions(options) ?? { value: await askSecret('API key: ') };

  const values = await loadModelInputs(getLocalValuesPath());
  values[`local:${id}`] = { API_KEY: secret };
  await saveModelInputs(getLocalValuesPath(), values);
  local.profiles.push(profile);
  await saveLocalProfiles(local);
  log.success(`Added local model profile local:${id}. Run \`teamai models switch local:${id}\` to use it.`);
}

interface ConfigureOptions extends ApiKeyOptions {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
}

export async function modelsConfigure(reference: string, options: ConfigureOptions): Promise<void> {
  const { ref, local, context } = await findProfile(reference);
  const key = profileRefName(ref);
  let edited: ProfileRef['profile'] | undefined;
  if (options.name || options.protocol || options.baseUrl || options.model) {
    if (ref.source !== 'local') {
      throw new Error('Team model profiles are read-only; only their API key can be configured locally.');
    }
    const protocols = parseProtocols(options.protocol);
    const models = splitList(options.model);
    let groups = ref.profile.model_groups;
    // New models join the first group's protocols; new protocols apply to
    // every model unless --model narrows them.
    for (const protocol of protocols.length ? protocols : ref.profile.model_groups[0].protocols) {
      groups = addModelProtocol(groups, models.length ? models : profileModels(ref.profile), protocol);
    }
    edited = parseProfile({
      ...ref.profile,
      ...(options.name ? { name: options.name } : {}),
      ...(options.baseUrl ? { base_url: options.baseUrl } : {}),
      model_groups: groups,
    });
  }

  const file = valuesPathFor(ref, context);
  const values = await loadModelInputs(file);
  const configured = values[key]?.API_KEY;
  let secret = await apiKeyFromOptions(options);
  if (!edited && !secret) {
    const answer = await askSecret(`API key for ${key}${configured ? ' (leave empty to keep)' : ''}: `);
    if (answer) secret = { value: answer };
  }
  if (!secret && !configured) {
    throw new Error(`Profile ${key} has no API key. Pass --from-env <ENV> or --api-key-stdin.`);
  }

  if (secret) {
    values[key] = { API_KEY: secret };
    await saveModelInputs(file, values);
  }
  if (edited) {
    local.profiles[local.profiles.findIndex((profile) => profile.id === edited!.id)] = edited;
    await saveLocalProfiles(local);
  }
  const activeAgents = activeAgentsFor(ref, await activeModelProfiles());
  log.success(activeAgents.length
    ? `Configured ${key}. Run \`teamai models switch ${key}\` to apply it to ${activeAgents.join(', ')}.`
    : `Configured ${key}. Agent settings were not changed.`);
}

interface SwitchOptions {
  agent?: string[];
  model?: string;
  dryRun?: boolean;
}

export async function modelsSwitch(reference: string, options: SwitchOptions): Promise<void> {
  const { ref, context } = await findProfile(reference);
  const key = profileRefName(ref);
  const file = valuesPathFor(ref, context);
  const values = await loadModelInputs(file);
  const stored = values[key]?.API_KEY;
  // First use of a profile: ask for the key here instead of requiring a
  // separate `configure` step.
  if (!stored && !options.dryRun && isInteractive()) {
    const answer = await askSecret(`API key for ${key}: `);
    if (!answer) throw new Error(`Profile ${key} needs an API key`);
    values[key] = { API_KEY: { value: answer } };
    await saveModelInputs(file, values);
  } else if (!isApiKeyConfigured(stored) && !stored?.env) {
    throw new Error(`Profile ${key} has no API key. Run \`teamai models configure ${key}\`.`);
  }
  const resolved = resolveProfile(ref, values, options.model);
  const explicit = collectAgents(options.agent ?? []);
  const agents = explicit.length > 0 ? explicit : profileAgents(ref.profile);
  printResults(await switchModelProfile(resolved, agents, { dryRun: options.dryRun }), explicit.length > 0);
}

export async function modelsRestore(options: SwitchOptions): Promise<void> {
  const explicit = collectAgents(options.agent ?? []);
  const results = await restoreModelProfiles(explicit.length > 0 ? explicit : ALL_MODEL_AGENTS, { dryRun: options.dryRun });
  const shown = explicit.length > 0 ? results : results.filter((result) => result.status !== 'unchanged');
  if (shown.length === 0) {
    log.info('No TeamAI-managed model settings to restore.');
    return;
  }
  printResults(shown, explicit.length > 0);
}

export async function modelsRemove(reference: string): Promise<void> {
  if (reference.startsWith('team:')) throw new Error('Team model profiles are read-only. Remove them in models/models.yaml.');
  const local = await loadLocalProfiles();
  const id = reference.replace(/^local:/, '');
  const index = local.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error(`Unknown local model profile: ${id}`);
  local.profiles.splice(index, 1);
  const values = await loadModelInputs(getLocalValuesPath());
  delete values[`local:${id}`];
  await saveLocalProfiles(local);
  await saveModelInputs(getLocalValuesPath(), values);
  log.success(`Removed local model profile local:${id}. Existing agent settings were not changed.`);
}

/**
 * Re-apply this team's profiles to the agents a user already switched to
 * them, so catalog updates arrive with `teamai pull`. Agents the user never
 * switched are left alone. Returns a hint when the team offers profiles that
 * no agent uses yet.
 */
export async function syncTeamModelProfiles(localConfig: LocalConfig, options: { dryRun?: boolean } = {}): Promise<string | undefined> {
  const team = await loadTeamProfiles(localConfig.repo.localPath);
  const identity = getTeamIdentity(localConfig);
  const groups = new Map<string, { profile: string; model?: string; agents: ModelAgent[] }>();
  for (const [agent, state] of Object.entries(await activeModelProfiles()) as Array<[ModelAgent, ActiveModelProfile]>) {
    if (!state.profile.startsWith('team:') || state.team !== identity) continue;
    const groupKey = `${state.profile}\0${state.model ?? ''}`;
    const group = groups.get(groupKey) ?? { profile: state.profile, model: state.model, agents: [] };
    group.agents.push(agent);
    groups.set(groupKey, group);
  }
  if (groups.size === 0) {
    return team.profiles.length > 0
      ? `${team.profiles.length} team model profile(s) available; run \`teamai models list\` to see them.`
      : undefined;
  }

  const values = await loadModelInputs(getTeamValuesPath(localConfig));
  for (const { profile: name, model, agents } of groups.values()) {
    const profile = team.profiles.find((candidate) => `team:${candidate.id}` === name);
    if (!profile) {
      log.warn(`Team model profile ${name} was removed; ${agents.join(', ')} keep their settings. Run \`teamai models restore\` to undo them.`);
      continue;
    }
    let resolved;
    try {
      resolved = resolveProfile(
        { source: 'team', profile, team: identity },
        values,
        model && profileModels(profile).includes(model) ? model : undefined,
      );
    } catch (error) {
      log.warn(`Cannot update agents using ${name}: ${(error as Error).message}`);
      continue;
    }
    const onlyIfActive = { profile: name, team: identity, ...(model ? { model } : {}) };
    for (const result of await switchModelProfile(resolved, agents, { ...options, onlyIfActive })) {
      if (result.status === 'switched') {
        log.success(options.dryRun ? `Would update ${result.agent} to the latest ${name}` : `Updated ${result.agent} to the latest ${name}`);
      } else if (result.status !== 'unchanged' && result.status !== 'not-installed') {
        log.warn(result.message);
      }
    }
  }
  return undefined;
}
