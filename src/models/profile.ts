import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { getTeamaiHomeDir } from '../types.js';
import { writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';

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

async function readOptionalProfile(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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

async function loadProfilesFile(filePath: string): Promise<ModelProfilesFile> {
  const raw = await readOptionalProfile(filePath);
  if (raw === null) return { version: 1, profiles: [] };
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`Invalid model profile YAML at ${filePath}: ${(error as Error).message}`);
  }
  const result = ModelProfilesFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid model profile file at ${filePath}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}

export async function loadTeamProfiles(repoPath: string): Promise<ModelProfilesFile> {
  return loadProfilesFile(path.join(repoPath, 'models', 'models.yaml'));
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
  team: ModelProfilesFile,
  local: ModelProfilesFile,
): ProfileRef {
  const qualified = reference.match(/^(team|local):(.+)$/);
  if (qualified) {
    const source = qualified[1] as ModelProfileSource;
    const id = qualified[2];
    const file = source === 'team' ? team : local;
    const profile = file.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown ${source} model profile: ${id}`);
    return { source, profile };
  }

  const matches: ProfileRef[] = [];
  const teamProfile = team.profiles.find((profile) => profile.id === reference);
  const localProfile = local.profiles.find((profile) => profile.id === reference);
  if (teamProfile) matches.push({ source: 'team', profile: teamProfile });
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
  const secret = values[reference]?.API_KEY;
  if (!isApiKeyConfigured(secret)) {
    const detail = secret?.env ? ` (environment variable ${secret.env} is not set)` : '';
    throw new Error(`Profile ${reference} has no API key${detail}. Run \`teamai models configure ${reference}\`.`);
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
