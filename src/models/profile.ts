import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { getTeamaiHomeDir } from '../types.js';
import { writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { caseFoldKey } from '../manifest-schema.js';
import {
  listEntryFiles,
  readEntryFileText,
  type EntryFileRead,
  type EntryReader,
  type ResolvedEntry,
} from '../namespaced-entries.js';

export const ModelProtocolSchema = z.enum([
  'anthropic',
  'openai-responses',
  'openai-chat-completions',
]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;

export const ModelAgentSchema = z.enum([
  'claude',
  'codex',
  'opencode',
  'codebuddy',
  'workbuddy',
]);
export type ModelAgent = z.infer<typeof ModelAgentSchema>;

export const ALL_MODEL_AGENTS: ModelAgent[] = ModelAgentSchema.options;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** The only accepted `api_key` value: a placeholder for the locally configured secret. */
export const API_KEY_PLACEHOLDER = '${API_KEY}';

function isPlainHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

const ModelGroupSchema = z.object({
  protocols: z.array(ModelProtocolSchema).min(1).refine((items) => new Set(items).size === items.length, 'protocols must be unique'),
  models: z.array(z.string().min(1)).min(1),
}).strict();
export type ModelGroup = z.infer<typeof ModelGroupSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().regex(ID_RE, 'must contain only letters, numbers, dot, underscore, or hyphen'),
  name: z.string().min(1),
  base_url: z.string().min(1)
    .refine(isPlainHttpUrl, 'must be an http or https URL without embedded credentials, query, or fragment')
    .refine((value) => !value.replace(/\/+$/, '').endsWith('/v1'), 'must be the gateway root without /v1'),
  api_key: z.string().refine((value) => value === API_KEY_PLACEHOLDER, `must be ${API_KEY_PLACEHOLDER}; configure the secret locally`),
  model_groups: z.array(ModelGroupSchema).min(1),
}).strict().superRefine((profile, ctx) => {
  const modelIds = new Set<string>();
  profile.model_groups.forEach((group, groupIndex) => group.models.forEach((model, modelIndex) => {
    if (modelIds.has(model)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model_groups', groupIndex, 'models', modelIndex], message: `duplicate model id ${model}` });
    }
    modelIds.add(model);
  }));
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export function profileRoutes(profile: ModelProfile): Partial<Record<ModelProtocol, string[]>> {
  const routes: Partial<Record<ModelProtocol, string[]>> = {};
  for (const group of profile.model_groups) {
    for (const protocol of group.protocols) {
      (routes[protocol] ??= []).push(...group.models);
    }
  }
  return routes;
}

export function profileModels(profile: ModelProfile): string[] {
  return profile.model_groups.flatMap((group) => group.models);
}

export function profileAgents(profile: ModelProfile): ModelAgent[] {
  const routes = profileRoutes(profile);
  return ALL_MODEL_AGENTS.filter((agent) => {
    if (agent === 'claude') return !!routes.anthropic;
    if (agent === 'codex') return !!routes['openai-responses'];
    if (agent === 'opencode') return true;
    return !!routes['openai-chat-completions'];
  });
}

export const ModelProfilesFileSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(ModelProfileSchema).default([]),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.profiles.forEach((profile, index) => {
    if (seen.has(profile.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profiles', index, 'id'],
        message: `duplicate profile id ${profile.id}`,
      });
    }
    seen.add(profile.id);
  });
});
export type ModelProfilesFile = z.infer<typeof ModelProfilesFileSchema>;

export type ModelProfileSource = 'team' | 'local';
export interface ProfileRef {
  source: ModelProfileSource;
  profile: ModelProfile;
  /** Identity of the team repository a `team:` profile came from. */
  team?: string;
  /** The file a `team:` profile comes from and the root profile it replaces. */
  from?: ResolvedEntry<ModelProfile>;
}

/** The team profiles a member receives, with where each one comes from. */
export interface TeamModelProfiles extends ModelProfilesFile {
  readonly origins?: ReadonlyMap<string, ResolvedEntry<ModelProfile>>;
}

/** A locally stored API key: either the value itself or the environment variable holding it. */
export interface StoredModelInput {
  value?: string;
  env?: string;
}
export type StoredModelInputs = Record<string, { API_KEY?: StoredModelInput }>;

const StoredModelInputSchema = z.object({
  value: z.string().optional(),
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict();
const StoredModelInputsSchema = z.record(z.object({ API_KEY: StoredModelInputSchema.optional() }).strict());

export interface ResolvedModelRoute {
  base_url: string;
  models: string[];
}

export interface ResolvedModelProfile extends ProfileRef {
  ref: string;
  routes: Partial<Record<ModelProtocol, ResolvedModelRoute>>;
  /** Model the user chose as the default with `--model`; routes list it first. */
  model?: string;
  api_key_value?: string;
  api_key_env?: string;
}

export function getLocalProfilesPath(): string {
  return path.join(getTeamaiHomeDir(), 'models', 'models.yaml');
}

export function getLocalValuesPath(): string {
  return path.join(getTeamaiHomeDir(), 'models', 'values.json');
}

export function getTeamValuesPath(localConfig: LocalConfig): string {
  // Team inputs may contain credentials. Keep them under the user home even
  // when project scope places dataHome inside a Git workspace.
  const remote = localConfig.repo.remote;
  let identity = remote && remote !== 'origin' && remote !== 'upstream'
    ? remote
    : localConfig.repo.url || localConfig.repo.localPath;
  let teamName = '';
  try {
    const raw = YAML.parse(fs.readFileSync(path.join(localConfig.repo.localPath, 'teamai.yaml'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const candidate = (raw as { team?: unknown; repo?: unknown }).team;
      if (typeof candidate === 'string') teamName = candidate;
      const repo = (raw as { repo?: unknown }).repo;
      if (typeof repo === 'string' && repo.trim()) identity = repo.trim();
    }
  } catch {
    // Older team repositories may not have teamai.yaml. Use the repository name.
  }
  const fallback = path.basename(localConfig.repo.localPath) || 'team';
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  const slug = (teamName || fallback).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'team';
  return path.join(getTeamaiHomeDir(), 'models', 'teams', `${slug}-${digest.slice(0, 10)}.json`);
}

/** Stable identity of the team repository, recorded with `team:` switches. */
export function getTeamIdentity(localConfig: LocalConfig): string {
  return path.basename(getTeamValuesPath(localConfig), '.json');
}

/** One profiles file, or why it cannot be used; null when it does not exist. `label` names it in the reason. */
async function readProfilesFile(filePath: string, label: string): Promise<EntryFileRead<ModelProfile> | null> {
  const file = await readEntryFileText(filePath, label);
  if (!file.ok) return file;
  const raw = file.text;
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    return { ok: false, reason: `Invalid model profile YAML at ${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = ModelProfilesFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `Invalid model profile file at ${label}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }
  return { ok: true, entries: result.data.profiles };
}

async function loadProfilesFile(filePath: string): Promise<ModelProfilesFile> {
  const read = await readProfilesFile(filePath, filePath);
  if (read === null) return { version: 1, profiles: [] };
  if (!read.ok) throw new Error(read.reason);
  return { version: 1, profiles: [...read.entries] };
}

/** Team profiles: `models/models.yaml` and `models/<ns>/models.yaml`, one entry per profile id. */
export const modelsEntryReader: EntryReader<ModelProfile> = {
  type: 'models',
  read: readProfilesFile,
  nameOf: (profile) => profile.id,
  // Profiles are strict: a per-entry `roles:` or `projects:` fails the file.
  scopeOf: () => ({}),
};

export function teamProfilesFrom(entries: readonly ResolvedEntry<ModelProfile>[]): TeamModelProfiles {
  return {
    version: 1,
    profiles: entries.map((entry) => entry.entry),
    origins: new Map(entries.map((entry) => [entry.name, entry])),
  };
}

/** Whether a namespace outside `active` defines profile `id`; a file that does not parse defines nothing. */
export async function inactiveNamespaceDefines(repoPath: string, active: readonly string[], id: string): Promise<boolean> {
  for (const { namespace, relativePath, absolutePath } of await listEntryFiles(repoPath, 'models')) {
    // Compared case-folded, as the resolver matches a namespace to its directory.
    if (namespace === null || active.some((ns) => caseFoldKey(ns) === caseFoldKey(namespace))) continue;
    const read = await readProfilesFile(absolutePath, relativePath);
    if (read?.ok && read.entries.some((profile) => profile.id === id)) return true;
  }
  return false;
}

/** Why each team profiles file in the checkout, root or namespace, cannot be used. */
export async function brokenTeamProfileFiles(repoPath: string): Promise<string[]> {
  const reasons: string[] = [];
  for (const { relativePath, absolutePath } of await listEntryFiles(repoPath, 'models')) {
    const read = await readProfilesFile(absolutePath, relativePath);
    if (read && !read.ok) reasons.push(read.reason);
  }
  return reasons;
}

export async function loadLocalProfiles(): Promise<ModelProfilesFile> {
  return loadProfilesFile(getLocalProfilesPath());
}

export async function saveLocalProfiles(file: ModelProfilesFile): Promise<void> {
  const { profiles } = ModelProfilesFileSchema.parse(file);
  await writeFileAtomic(getLocalProfilesPath(), YAML.stringify({ profiles }));
}

export async function loadModelInputs(filePath: string): Promise<StoredModelInputs> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read local model inputs at ${filePath}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse local model inputs at ${filePath}: ${(error as Error).message}`);
  }
  const parsed = StoredModelInputsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid local model inputs at ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}

export async function saveModelInputs(filePath: string, values: StoredModelInputs): Promise<void> {
  await writeJsonAtomic(filePath, StoredModelInputsSchema.parse(values), { mode: 0o600 });
}

export function resolveProfileRef(
  reference: string,
  team: TeamModelProfiles,
  local: ModelProfilesFile,
): ProfileRef {
  const qualified = reference.match(/^(team|local):(.+)$/);
  const teamRef = (profile: ModelProfile): ProfileRef => {
    const from = team.origins?.get(profile.id);
    return { source: 'team', profile, ...(from ? { from } : {}) };
  };
  if (qualified) {
    const source = qualified[1] as ModelProfileSource;
    const id = qualified[2];
    const file = source === 'team' ? team : local;
    const profile = file.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown ${source} model profile: ${id}`);
    return source === 'team' ? teamRef(profile) : { source, profile };
  }

  const matches: ProfileRef[] = [];
  const teamProfile = team.profiles.find((profile) => profile.id === reference);
  const localProfile = local.profiles.find((profile) => profile.id === reference);
  if (teamProfile) matches.push(teamRef(teamProfile));
  if (localProfile) matches.push({ source: 'local', profile: localProfile });
  if (matches.length === 0) throw new Error(`Unknown model profile: ${reference}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous model profile "${reference}". Use team:${reference} or local:${reference}.`);
  }
  return matches[0];
}

export function profileRefName(ref: ProfileRef): string {
  return `${ref.source}:${ref.profile.id}`;
}

/** Where requests to a profile's gateway go: scheme, host and port of `base_url`. */
export function profileOrigin(profile: ModelProfile): string {
  return new URL(profile.base_url).origin;
}

/** For a team profile, the gateway its key is bound to, as ` at <origin>` or ` for <origin>`; empty for a local one. */
export function gatewaySuffix(ref: ProfileRef, preposition: 'at' | 'for'): string {
  return ref.source === 'team' ? ` ${preposition} ${profileOrigin(ref.profile)}` : '';
}

/**
 * The name a profile's API key is stored under. A team key is bound to the
 * profile id and the gateway origin (#707): a namespace can replace a team
 * profile with one on another host, and the key a member configured for the
 * first host must never be written into an agent pointed at the second.
 */
function apiKeyName(ref: ProfileRef): string {
  return ref.source === 'team' ? `${profileRefName(ref)}@${profileOrigin(ref.profile)}` : profileRefName(ref);
}

/** The API key stored for this profile and its gateway. */
export function storedApiKey(ref: ProfileRef, values: StoredModelInputs): StoredModelInput | undefined {
  return values[apiKeyName(ref)]?.API_KEY;
}

/** Store the API key for this profile and its gateway. */
export function setStoredApiKey(ref: ProfileRef, values: StoredModelInputs, input: StoredModelInput): void {
  values[apiKeyName(ref)] = { API_KEY: input };
}

/**
 * Bind each team key stored before #707 to one gateway, once. Those keys are
 * named by profile id alone (`team:<id>`), and only root profiles existed
 * then. Such a key is bound to the gateway it was sent to, which `sentTo`
 * reads from the agents switched to that profile: the root profile's current
 * gateway when it is among them, else one of those. A key no agent used is
 * bound to the root profile's current gateway. Either way it never follows
 * the profile to a later host. A key whose profile has no root version now is
 * left as it is: it belongs to no gateway, and nothing reads it.
 *
 * Returns whether `values` changed.
 */
export function bindLegacyTeamKeys(
  values: StoredModelInputs,
  team: TeamModelProfiles,
  sentTo: (id: string) => readonly string[],
): boolean {
  let changed = false;
  for (const [name, input] of Object.entries(values)) {
    const id = /^team:([^@]+)$/.exec(name)?.[1];
    const entry = id === undefined ? undefined : team.origins?.get(id);
    const root = entry ? entry.replacedEntry ?? (entry.namespace === null ? entry.entry : null) : null;
    if (id === undefined || !root) continue;
    const rootOrigin = profileOrigin(root);
    const used = sentTo(id);
    const origin = used.length === 0 || used.includes(rootOrigin) ? rootOrigin : [...used].sort()[0] ?? rootOrigin;
    const bound = `${name}@${origin}`;
    // A key configured on this version wins over the one a beta left.
    values[bound] ??= input;
    delete values[name];
    changed = true;
  }
  return changed;
}

/** True when a key is stored for this team profile id, but for another gateway. */
export function hasApiKeyForAnotherGateway(ref: ProfileRef, values: StoredModelInputs): boolean {
  if (ref.source !== 'team' || storedApiKey(ref, values)) return false;
  const name = profileRefName(ref);
  return Object.keys(values).some((key) => key === name || key.startsWith(`${name}@`));
}

/** True when the API key is stored locally or its environment variable is set. */
export function isApiKeyConfigured(stored: StoredModelInput | undefined): boolean {
  return !!(stored?.value || (stored?.env && process.env[stored.env]));
}

export function resolveProfile(
  ref: ProfileRef,
  values: StoredModelInputs,
  model?: string,
): ResolvedModelProfile {
  const reference = profileRefName(ref);
  const secret = storedApiKey(ref, values);
  if (!isApiKeyConfigured(secret)) {
    const detail = secret?.env ? ` (environment variable ${secret.env} is not set)` : '';
    throw new Error(`Profile ${reference} has no API key${gatewaySuffix(ref, 'for')}${detail}. Run \`teamai models configure ${reference}\`.`);
  }
  if (model !== undefined && !profileModels(ref.profile).includes(model)) {
    throw new Error(`Profile ${reference} has no model ${model}`);
  }

  const root = ref.profile.base_url.replace(/\/+$/, '');
  const routes = Object.fromEntries(Object.entries(profileRoutes(ref.profile)).map(([protocol, models]) => [
    protocol,
    {
      base_url: protocol === 'anthropic' ? root : `${root}/v1`,
      // The chosen default leads every route that serves it; other routes keep
      // the catalog order and default to their own first model.
      models: model && models.includes(model) ? [model, ...models.filter((item) => item !== model)] : models,
    },
  ])) as ResolvedModelProfile['routes'];
  return {
    ...ref,
    ref: reference,
    routes,
    ...(model ? { model } : {}),
    api_key_value: secret?.env ? process.env[secret.env] : secret?.value,
    api_key_env: secret?.env,
  };
}
