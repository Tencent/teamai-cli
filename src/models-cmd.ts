import path from 'node:path';
import { autoDetectInit } from './config.js';
import { describeEntryFailure, describeOrigin, reportEntryResolution, resolveEntriesFor } from './namespaced-entries.js';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { askConfirmation, askQuestion, askSecret, isInteractive, readStdin } from './utils/prompt.js';
import type { LocalConfig } from './types.js';
import {
  API_KEY_PLACEHOLDER,
  ModelAgentSchema,
  ModelProfileSchema,
  ModelProtocolSchema,
  findTeamValuesPath,
  getLocalValuesPath,
  gatewaySuffix,
  getTeamIdentity,
  getTeamValuesPath,
  bindLegacyTeamKeys,
  hasApiKeyForAnotherGateway,
  inactiveNamespaceDefines,
  isApiKeyConfigured,
  loadLocalProfiles,
  loadModelInputs,
  mergeModelInputs,
  profileAgents,
  profileModels,
  profileOrigin,
  profileRefName,
  resolveProfile,
  resolveProfileRef,
  modelsEntryReader,
  saveLocalProfiles,
  saveModelInputs,
  sameTeamIdentity,
  setStoredApiKey,
  storedApiKey,
  teamProfilesFrom,
  unadoptedLegacyFiles,
  withTeamValuesLock,
  type ModelAgent,
  type ModelGroup,
  type ModelProtocol,
  type ModelProfilesFile,
  type ProfileRef,
  type TeamModelProfiles,
  type StoredModelInput,
  type StoredModelInputs,
} from './models/profile.js';
import {
  ALL_MODEL_AGENTS,
  activeModelProfiles,
  refusedLegacyValueKeys,
  refuseLegacyValue,
  switchedGatewayOrigins,
  restoreModelProfiles,
  switchModelProfile,
  type ActiveModelProfile,
  type ModelSwitchResult,
} from './models/switch.js';

interface TeamModelsContext {
  team: TeamModelProfiles;
  localConfig?: LocalConfig;
}

/**
 * The team profiles this directory receives, or null when they do not resolve
 * (a broken file, one id in two active namespaces): that is reported here as
 * the command's error, and the command stops.
 */
async function teamContext(options: { dryRun?: boolean } = {}): Promise<TeamModelsContext | null> {
  let initialized: Awaited<ReturnType<typeof autoDetectInit>>;
  try {
    initialized = await autoDetectInit(undefined, options);
  } catch {
    return { team: { version: 1, profiles: [] } };
  }
  const resolution = await resolveEntriesFor(modelsEntryReader, initialized.localConfig);
  if (resolution.kind === 'failed') {
    log.error(describeEntryFailure(resolution.failure));
    process.exitCode = 1;
    return null;
  }
  return { team: teamProfilesFrom(resolution.entries), localConfig: initialized.localConfig };
}

/**
 * This team's stored keys, read from the hash-only file or, while it does not
 * exist yet, the newest legacy `<slug>-<digest>.json` an older version wrote —
 * read where it lies, never renamed. Any key a 0.26.0 beta stored is bound to
 * its gateway first (`bindLegacyTeamKeys`) and saved — to the hash-only file —
 * unless `dryRun`. A legacy file under a provider-ambiguous digest (a
 * path-shaped claim, a bare alias, a path-only path) is never read silently:
 * the old name never encoded the provider, so neither the slug nor any
 * machine-global artifact can attribute the file to this checkout across
 * providers. An interactive run asks the user once per candidate identity;
 * on "yes" the file is read and immediately migrated — saved to the
 * provider-qualified hash-only name of THAT config, which then shadows it (no
 * re-ask, no ambiguity left). The adoption is keyed
 * `<target>::<slug>-<digest>`, so it is scoped to this scope's provider
 * identity: a user-scope confirmation never authorizes a project scope, even
 * under the same slug and claim on a different provider. A declined candidate
 * is read nothing and writes nothing — the empty hash-only file is never
 * created, so the next run still offers it. Non-interactive and dry runs
 * never adopt: they note the file and read nothing it owns.
 */
const adoptedLegacyValues = new Set<string>();

/**
 * A values write to a team's hash-only target would permanently shadow any
 * unadopted provider-ambiguous legacy file (the target's existence silences
 * every future adoption prompt), so — unlike a pull, whose read-time save is
 * migration — a command that writes the team target is refused while one
 * remains. Adoption is intentional and is only possible interactively, so
 * the refusal names that path.
 */
async function assertNoShadowingLegacyWrite(localConfig: LocalConfig): Promise<void> {
  const declined = await refusedLegacyValueKeys();
  const pending = await unadoptedLegacyFiles(localConfig, { adopted: adoptedLegacyValues, declined });
  if (pending.length === 0) return;
  throw new Error(
    `Unadopted legacy team values file(s) still exist for this team (${pending.map((file) => file.entry).join(', ')}); ` +
      `writing ${getTeamValuesPath(localConfig)} would shadow and permanently orphan their keys. ` +
      `Re-run interactively to adopt and migrate them first.`,
  );
}

async function loadTeamValues(
  localConfig: LocalConfig,
  team: TeamModelProfiles,
  options: { dryRun?: boolean } = {},
): Promise<StoredModelInputs> {
  const target = getTeamValuesPath(localConfig);
  const declined = new Set(await refusedLegacyValueKeys());
  const pending = await unadoptedLegacyFiles(localConfig, { adopted: adoptedLegacyValues, declined });
  if (pending.length > 0) {
    if (!options.dryRun && isInteractive()) {
      for (const file of pending) {
        const key = `${target}::${file.identity}`;
        const adopt = await askConfirmation(
          `Legacy team values file '${file.entry}' names this team under a provider-ambiguous identity (${file.identity}). Adopt it as this team's keys (migrated to the provider-qualified name once read)? [y/N] `,
        );
        if (adopt) adoptedLegacyValues.add(key);
        else {
          // The decline is a durable, visible decision — recorded per target so
          // the file is neither re-offered on every run nor silently shadowed
          // and orphans when the migration proceeds. Its keys stay on disk; a
          // foreign team's same-digest file no longer blocks this team's migration.
          declined.add(key);
          await refuseLegacyValue(key);
        }
      }
    } else {
      log.warn(
        `Legacy team values file(s) not adopted: ${pending.map((file) => file.entry).join(', ')}. ` +
          `They are never read without an explicit opt-in; re-run interactively to adopt, or write the keys to ${target}.`,
      );
    }
  }
  // A declined or unprompted file must stay reachable: once the hash-only
  // target exists, its candidates are silenced, so those keys would be orphaned
  // permanently with no later prompt ever possible. The migration save below
  // therefore happens only when every matching ambiguous file for this team is
  // either adopted (merged into the values), durably declined, or gone —
  // never while one is still left to decide on.
  const remaining = await unadoptedLegacyFiles(localConfig, { adopted: adoptedLegacyValues, declined });
  const canMigrate = remaining.length === 0;
  const readFrom = await findTeamValuesPath(localConfig, { adopted: adoptedLegacyValues, declined });
  const valuesDir = path.dirname(target);
  let values = await loadModelInputs(readFrom);
  // Adoption merges EVERY adopted identity's keys, not only the newest file a
  // single read selects: several files can share this checkout's digest, and
  // their unique keys must all reach the migrated target.
  for (const file of pending) {
    if (!adoptedLegacyValues.has(`${target}::${file.identity}`)) continue;
    values = mergeModelInputs(await loadModelInputs(path.join(valuesDir, file.entry)), values);
  }
  const sentTo = await switchedGatewayOrigins(localConfig);
  if (canMigrate && (bindLegacyTeamKeys(values, team, (id) => sentTo.get(`team:${id}`) ?? []) || readFrom !== target) && !options.dryRun) {
    if (readFrom !== target) {
      // Save to the current name, which then shadows the legacy file. The
      // migration creates the hash-only target, so another process may be
      // writing it in the same window (writeJsonAtomic prevents torn files,
      // not lost updates). Hold the target's lock and re-read it inside the
      // critical section: the concurrent content wins collisions, no key it
      // added is silently discarded, and the read-merge-write cannot be
      // interleaved with another writer's. When we are merely re-saving the
      // file we already read (readFrom === target), the target holds the same
      // content this bind just consumed — merging would re-inject raw entries
      // the bind renamed, and there is no creation race to guard.
      await withTeamValuesLock(target, async () => {
        values = mergeModelInputs(values, await loadModelInputs(target));
        await saveModelInputs(target, values);
      });
    } else {
      await saveModelInputs(target, values);
    }
  }
  return values;
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
  const value = await readStdin();
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

async function findProfile(reference: string, options: { dryRun?: boolean } = {}): Promise<{
  ref: ProfileRef;
  local: ModelProfilesFile;
  context: TeamModelsContext;
} | null> {
  const [context, local] = await Promise.all([teamContext(options), loadLocalProfiles()]);
  if (!context) return null;
  const ref = resolveProfileRef(reference, context.team, local);
  if (ref.source === 'team' && context.localConfig) ref.team = getTeamIdentity(context.localConfig);
  return { ref, local, context };
}

function valuesPathFor(ref: ProfileRef, context: TeamModelsContext): string {
  if (ref.source === 'local') return getLocalValuesPath();
  if (!context.localConfig) throw new Error('Team model profiles require an initialized TeamAI repository');
  return getTeamValuesPath(context.localConfig);
}

/** The stored keys `ref` reads its key from; `loadTeamValues` for a team profile. */
async function loadValuesFor(ref: ProfileRef, context: TeamModelsContext, options: { dryRun?: boolean } = {}): Promise<StoredModelInputs> {
  if (ref.source === 'team' && context.localConfig) return loadTeamValues(context.localConfig, context.team, options);
  return loadModelInputs(valuesPathFor(ref, context));
}

async function activeAgentsFor(
  ref: ProfileRef,
  active: Partial<Record<ModelAgent, ActiveModelProfile>>,
  localConfig?: LocalConfig,
): Promise<ModelAgent[]> {
  const name = profileRefName(ref);
  const agents: ModelAgent[] = [];
  for (const [agent, state] of Object.entries(active) as Array<[ModelAgent, ActiveModelProfile]>) {
    if (state.profile !== name) continue;
    if (ref.source !== 'local' && state.team
      && !(localConfig ? sameTeamIdentity(state.team, localConfig) : state.team === ref.team)) continue;
    agents.push(agent);
  }
  return agents;
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

/**
 * Model catalogs are small, so one command lists every profile in full;
 * pass a profile to see just that one. API keys are never printed.
 */
export async function modelsList(reference?: string): Promise<void> {
  // Read-only: the load never persists a migration (#893).
  const [context, local, active] = await Promise.all([
    teamContext({ dryRun: true }), loadLocalProfiles(), activeModelProfiles(),
  ]);
  if (!context) return;
  const team = context.localConfig ? getTeamIdentity(context.localConfig) : undefined;
  let refs: ProfileRef[];
  if (reference) {
    const ref = resolveProfileRef(reference, context.team, local);
    if (ref.source === 'team') ref.team = team;
    refs = [ref];
  } else {
    refs = [
      ...context.team.profiles.map((profile) => ({ ...resolveProfileRef(`team:${profile.id}`, context.team, local), team })),
      ...local.profiles.map((profile) => ({ source: 'local' as const, profile })),
    ];
  }
  if (refs.length === 0) {
    log.info('No model profiles found.');
    return;
  }
  const values: Record<ProfileRef['source'], StoredModelInputs> = {
    team: context.localConfig && refs.some((ref) => ref.source === 'team') ? await loadTeamValues(context.localConfig, context.team, { dryRun: true }) : {},
    local: refs.some((ref) => ref.source === 'local') ? await loadModelInputs(getLocalValuesPath()) : {},
  };
  for (const [index, ref] of refs.entries()) {
    if (index > 0) console.log('');
    const secret = storedApiKey(ref, values[ref.source]);
    const activeAgents = await activeAgentsFor(ref, active, context.localConfig);
    console.log(`${profileRefName(ref)} — ${ref.profile.name}`);
    if (ref.from) console.log(`  From: ${ref.from.source} (${describeOrigin(ref.from)})`);
    const missing = hasApiKeyForAnotherGateway(ref, values[ref.source])
      ? `not configured for ${profileOrigin(ref.profile)} (one is stored for another gateway)`
      : 'not configured';
    console.log(`  API key: ${secret?.env ? `environment ${secret.env}` : secret?.value ? 'configured locally' : missing}`);
    console.log(`  Gateway: ${ref.profile.base_url}`);
    console.log('  Models:');
    for (const group of ref.profile.model_groups) {
      console.log(`    ${group.protocols.join(', ')}: ${group.models.join(', ')}`);
    }
    console.log(`  Agents: ${profileAgents(ref.profile).join(', ')}`);
    console.log(`  Active: ${activeAgents.length ? activeAgents.join(', ') : 'none'}`);
  }
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
  if (!context) return;
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
  const found = await findProfile(reference);
  if (!found) return;
  const { ref, local, context } = found;
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
  const values = await loadValuesFor(ref, context);
  const configured = storedApiKey(ref, values);
  let secret = await apiKeyFromOptions(options);
  if (!edited && !secret) {
    const answer = await askSecret(`API key for ${key}${gatewaySuffix(ref, 'at')}${configured ? ' (leave empty to keep)' : ''}: `);
    if (answer) secret = { value: answer };
  }
  if (!secret && !configured) {
    throw new Error(`Profile ${key} has no API key. Pass --from-env <ENV> or --api-key-stdin.`);
  }

  if (secret) {
    if (ref.source === 'team' && context.localConfig) await assertNoShadowingLegacyWrite(context.localConfig);
    if (ref.source === 'team') {
      // Hold the target's lock and re-read inside it, so this write cannot
      // clobber a migration or another configure this window holds.
      await withTeamValuesLock(file, async () => {
        const current = await loadModelInputs(file);
        setStoredApiKey(ref, current, secret);
        await saveModelInputs(file, current);
      });
    } else {
      setStoredApiKey(ref, values, secret);
      await saveModelInputs(file, values);
    }
  }
  if (edited) {
    local.profiles[local.profiles.findIndex((profile) => profile.id === edited!.id)] = edited;
    await saveLocalProfiles(local);
  }
  const activeAgents = await activeAgentsFor(ref, await activeModelProfiles(), context.localConfig);
  log.success(activeAgents.length
    ? `Configured ${key}${gatewaySuffix(ref, 'at')}. Run \`teamai models switch ${key}\` to apply it to ${activeAgents.join(', ')}.`
    : `Configured ${key}${gatewaySuffix(ref, 'at')}. Agent settings were not changed.`);
}

interface SwitchOptions {
  agent?: string[];
  model?: string;
  dryRun?: boolean;
}

export async function modelsSwitch(reference: string, options: SwitchOptions): Promise<void> {
  const found = await findProfile(reference, { dryRun: options.dryRun });
  if (!found) return;
  const { ref, context } = found;
  const key = profileRefName(ref);
  const file = valuesPathFor(ref, context);
  const values = await loadValuesFor(ref, context, options);
  const stored = storedApiKey(ref, values);
  // First use of a profile, or of its current gateway: ask for the key here
  // instead of requiring a separate `configure` step.
  if (!stored && !options.dryRun && isInteractive()) {
    const answer = await askSecret(`API key for ${key}${gatewaySuffix(ref, 'at')}: `);
    if (!answer) throw new Error(`Profile ${key} needs an API key`);
    if (ref.source === 'team' && context.localConfig) await assertNoShadowingLegacyWrite(context.localConfig);
    // Put the key in the copy the rest of this command resolves against first,
    // so every save below already carries it (the lock re-read full the team
    // snapshot from disk).
    setStoredApiKey(ref, values, { value: answer });
    if (ref.source === 'team') {
      // Hold the target's lock and re-read inside it, like `configure`.
      await withTeamValuesLock(file, async () => {
        const current = await loadModelInputs(file);
        setStoredApiKey(ref, current, { value: answer });
        await saveModelInputs(file, current);
      });
    } else {
      await saveModelInputs(file, values);
    }
  } else if (!isApiKeyConfigured(stored) && !stored?.env) {
    throw new Error(`Profile ${key} has no API key${gatewaySuffix(ref, 'for')}. Run \`teamai models configure ${key}\`.`);
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
 * A line that tells the member to act. Also written to debug.log: most pulls
 * run silent from the SessionStart hook, and nothing else on disk would say
 * why an agent stayed on its old settings.
 */
function warnAndPersist(message: string): void {
  log.warn(message);
  log.persist(message);
}

/**
 * Re-apply this team's profiles to the agents a user already switched to
 * them, so catalog updates arrive with `teamai pull`. Agents the user never
 * switched are left alone. Returns a hint when the team offers profiles that
 * no agent uses yet.
 *
 * The profiles are the root file plus the active namespace files (#707). When
 * they do not resolve, no agent is touched this run. An agent whose profile
 * moved to a gateway its key was not configured for is left alone too.
 */
export async function syncTeamModelProfiles(localConfig: LocalConfig, options: { dryRun?: boolean } = {}): Promise<string | undefined> {
  const identity = getTeamIdentity(localConfig);
  const groups = new Map<string, { profile: string; model?: string; agents: ModelAgent[] }>();
  for (const [agent, state] of Object.entries(await activeModelProfiles()) as Array<[ModelAgent, ActiveModelProfile]>) {
    if (!state.profile.startsWith('team:') || !sameTeamIdentity(state.team, localConfig)) continue;
    const groupKey = `${state.profile}\0${state.model ?? ''}`;
    const group = groups.get(groupKey) ?? { profile: state.profile, model: state.model, agents: [] };
    group.agents.push(agent);
    groups.set(groupKey, group);
  }
  // Nothing to update or offer: skip reading the manifests.
  if (groups.size === 0 && !await pathExists(path.join(localConfig.repo.localPath, 'models'))) return undefined;

  const resolution = await resolveEntriesFor(modelsEntryReader, localConfig);
  if (resolution.kind === 'failed') {
    reportEntryResolution(resolution);
    return undefined;
  }
  const team = teamProfilesFrom(resolution.entries);
  // Before anything reads a key: a key a beta stored is bound at the first pull.
  const values = await loadTeamValues(localConfig, team, options);
  if (groups.size === 0) {
    return team.profiles.length > 0
      ? `${team.profiles.length} team model profile(s) available; run \`teamai models list\` to see them.`
      : undefined;
  }

  for (const { profile: name, model, agents } of groups.values()) {
    const id = name.slice('team:'.length);
    const profile = team.profiles.find((candidate) => candidate.id === id);
    const keep = `${agents.join(', ')} keep${agents.length === 1 ? 's' : ''} ${agents.length === 1 ? 'its' : 'their'} settings`;
    if (!profile) {
      // Legacy mode reads no namespace, so there a profile only ever goes away.
      const why = resolution.active !== null && await inactiveNamespaceDefines(localConfig.repo.localPath, resolution.active, id)
        ? 'is no longer active in your namespaces'
        : 'was removed';
      warnAndPersist(`Team model profile ${name} ${why}; ${keep}. Run \`teamai models restore\` to undo them.`);
      continue;
    }
    const ref = resolveProfileRef(name, team, { version: 1, profiles: [] });
    ref.team = identity;
    if (hasApiKeyForAnotherGateway(ref, values)) {
      warnAndPersist(`Team model profile ${name} now uses ${profileOrigin(profile)}${ref.from ? ` (${ref.from.source})` : ''}, `
        + `not the gateway your API key is configured for; ${keep}. Run \`teamai models switch ${name}\` to set a key for it.`);
      continue;
    }
    let resolved;
    try {
      resolved = resolveProfile(ref, values, model && profileModels(profile).includes(model) ? model : undefined);
    } catch (error) {
      log.warn(`Cannot update agents using ${name}: ${(error as Error).message}`);
      continue;
    }
    const onlyIfActive = { profile: name, team: identity, ...(model ? { model } : {}) };
    for (const result of await switchModelProfile(resolved, agents, { ...options, onlyIfActive, localConfig })) {
      if (result.status === 'switched') {
        log.success(options.dryRun ? `Would update ${result.agent} to the latest ${name}` : `Updated ${result.agent} to the latest ${name}`);
      } else if (result.status !== 'unchanged' && result.status !== 'not-installed') {
        log.warn(result.message);
      }
    }
  }
  return undefined;
}
