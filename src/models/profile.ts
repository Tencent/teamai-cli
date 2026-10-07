import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { getTeamaiHomeDir } from '../types.js';
import { repoIdentity } from '../utils/git.js';
import { writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { acquireLock, releaseLock } from '../update.js';
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
  'pi',
  'omp',
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
    // OpenCode, Pi and OMP name an api per model, so any of them can serve any protocol.
    if (agent === 'opencode' || agent === 'pi' || agent === 'omp') return true;
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

/** A path-shaped `owner/repo`: not a URL, yet it names a single repository — together with its provider. */
function isProviderRelative(value: string): boolean {
  return /\//.test(value);
}

/** Whether a value names a repository for `repoIdentity`: a URL or scp-like remote. A bare alias like `fork` names nothing on its own, and a Windows drive path (`C:\teams\repo`) is no more a scheme than it is a repository. */
export function isRepoReference(value: string): boolean {
  if (/^[^/@]+@[^:/]+:.+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    // `new URL('C:\\teams\\repo')` accepts `c:` as a scheme; drive letters
    // are paths, not hosts — reject them so a path-only config keeps the
    // provider-and-team-slug fallback instead of hashing a phantom URL.
    if (/^[a-z]:$/.test(parsed.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

export function getTeamValuesPath(localConfig: LocalConfig): string {
  // Team inputs may contain credentials. Keep them under the user home even
  // when project scope places dataHome inside a Git workspace.
  const { remote, url, localPath } = localConfig.repo;
  const named = remote && remote !== 'origin' && remote !== 'upstream' ? remote : undefined;
  // Hash only what names a repository. A remote alias (`fork`) does not: two
  // checkouts sharing the alias would share one values file and read each
  // other's keys. A provider-relative remote (`owner/repo`) DOES name one
  // repository, just only together with its provider — exactly like a
  // path-shaped `repo:` claim. The same holds for the local path — it is
  // reused across teams, so it is the last resort and keeps the slug.
  const claim = repoClaim(localPath);
  // A configured non-origin remote names the repository with the highest
  // precedence — whether it is URL-shaped or a provider-relative `owner/repo`
  // (which names one repository together with its provider). Two checkouts
  // with DIFFERENT remotes therefore never share one file, even if they carry
  // the same `repo:` claim; the claim decides only when it is the best
  // identity the checkout actually has.
  const namedRemote = named !== undefined && (isRepoReference(named) || isProviderRelative(named));
  const source = namedRemote ? named
    : url && isRepoReference(url) ? url
    : claim?.claim ?? localPath;
  // The effective provider: the member's own initializer/override wins — the
  // provider a checkout was initialized with (`--provider`) overrides the
  // team's declared one, as everywhere else in the CLI — then the team's own
  // `provider:` in teamai.yaml, then the team default. Provider, remote, and
  // claim survive a team rename, keeping the file bound to the repository
  // rather than the display name.
  const provider = localConfig.provider ?? teamProvider(localPath) ?? 'tgit';
  let identity: string;
  if (isRepoReference(source)) {
    // Host-bearing: repoIdentity normalizes scheme family, host, and path.
    identity = repoIdentity(source);
  } else if (source === claim?.claim) {
    // Path-shaped claim: provider-relative, so the effective provider (the
    // claim's own, else the local override, else the team default) qualifies
    // it. Claim and provider survive a team rename, keeping the file bound
    // to the repository rather than the display name.
    identity = `${provider}:${source}`;
  } else if (source === named) {
    // Provider-relative remote: the same ambiguity the path-shaped claim
    // handles, so the same provider qualification applies.
    identity = `${provider}:${source}`;
  } else {
    // Path-only: no repository identity exists — and a bare remote alias
    // like `fork` names no repository either — so the local path is the
    // last resort and the team slug, the old scheme's discriminator, joins
    // the hash to separate teams sharing a checkout path. Renaming such a
    // team orphans its keys, as before.
    identity = `${provider}:${legacyTeamSlug(localPath)}:${source}`;
  }
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 10);
  return path.join(getTeamaiHomeDir(), 'models', 'teams', `${digest}.json`);
}

/** Stable identity of the team repository, recorded with `team:` switches. */
export function getTeamIdentity(localConfig: LocalConfig): string {
  return path.basename(getTeamValuesPath(localConfig), '.json');
}

/**
 * The `repo:` claim in teamai.yaml, or null when it is missing or not a
 * non-empty string. Its `provider` accompanies the claim: the same
 * `owner/repo` claim names a different repository per provider, and the
 * local `provider` override is normally absent, so the team's own provider
 * is the authoritative one for a path-shaped claim.
 */
function repoClaim(localPath: string): { claim: string; provider?: string } | null {
  try {
    const raw = YAML.parse(fs.readFileSync(path.join(localPath, 'teamai.yaml'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const repo = (raw as { repo?: unknown }).repo;
      if (typeof repo === 'string' && repo.trim()) {
        const provider = (raw as { provider?: unknown }).provider;
        return { claim: repo.trim(), ...(typeof provider === 'string' && provider.trim() ? { provider: provider.trim() } : {}) };
      }
    }
  } catch {
    // teamai.yaml may be absent or unreadable.
  }
  return null;
}

/** The team's own `provider:` in teamai.yaml — authoritative for path-shaped identities even when the `repo:` claim is absent. */
function teamProvider(localPath: string): string | undefined {
  try {
    const raw = YAML.parse(fs.readFileSync(path.join(localPath, 'teamai.yaml'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const provider = (raw as { provider?: unknown }).provider;
      if (typeof provider === 'string' && provider.trim()) return provider.trim();
    }
  } catch {
    // teamai.yaml may be absent or unreadable.
  }
  return undefined;
}

/**
 * The 10-hex digests older versions of `getTeamValuesPath` hashed for this
 * checkout, and how tightly each may be matched. The old implementation
 * hashed exactly one identity — the teamai.yaml `repo:` claim when present,
 * else the configured remote, else the URL, else the local path — so the
 * candidates mirror that precedence: the claim (when present) and the
 * configured remote exclude the identities below them, and the path is a
 * candidate only when the old implementation would have keyed on it (no
 * claim, no configured remote, no URL). That keeps a checkout replaced at
 * the same path by another team from adopting the previous team's file.
 * Repository-bound digests (a URL, a URL-shaped claim or remote) match by
 * digest alone — the identity carries its host, so the slug can drift with
 * team renames with no ambiguity. A path-shaped claim, a provider-relative
 * remote, a bare alias, or a path-only local path names no single repository,
 * and — the old name scheme never encoded the provider — the slug cannot
 * tell two providers' same-named teams apart. Files under such a digest are
 * read only when the user explicitly adopts that exact identity
 * (`unadoptedLegacyFiles` / `findTeamValuesPath`); switch records under it
 * match only under this checkout's slug.
 */
interface LegacyDigest {
  digest: string;
  /** Files under this digest are read only when the user adopted the exact identity. */
  fileNeedsSlug: boolean;
  /** Switch records under this digest match only when this checkout's slug matches. */
  recordNeedsSlug: boolean;
}

function legacyTeamValueHashes(localConfig: LocalConfig): LegacyDigest[] {
  const { remote, url, localPath } = localConfig.repo;
  const configuredRemote = remote && remote !== 'origin' && remote !== 'upstream' ? remote : undefined;
  const claim = repoClaim(localPath);
  const urlShaped = (value?: string) => value !== undefined && isRepoReference(value);
  const candidates: Array<{ identity?: string; fileNeedsSlug: boolean; recordNeedsSlug: boolean }> = [
    // A claim overrode everything below it; with a claim, the old
    // implementation never hashed the remote, URL, or path. A URL-shaped
    // claim names one repository (its host is in it) and matches by digest.
    // A path-shaped claim is provider-ambiguous — the legacy digest hashed
    // the bare claim — so files need the user's explicit adoption and switch
    // records need this checkout's slug.
    { identity: claim?.claim, fileNeedsSlug: !urlShaped(claim?.claim), recordNeedsSlug: !urlShaped(claim?.claim) },
    ...(claim === null ? [
      { identity: configuredRemote, fileNeedsSlug: !urlShaped(configuredRemote), recordNeedsSlug: !urlShaped(configuredRemote) },
      { identity: url, fileNeedsSlug: false, recordNeedsSlug: false },
      // Only when the old implementation would have keyed on the path itself:
      // no repository identity exists there, so the slug separates teams.
      { identity: configuredRemote === undefined && !url ? localPath : undefined, fileNeedsSlug: true, recordNeedsSlug: true },
    ] : []),
  ];
  const seen = new Set<string>();
  const digests: LegacyDigest[] = [];
  for (const { identity, fileNeedsSlug, recordNeedsSlug } of candidates) {
    if (!identity) continue;
    const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 10);
    if (seen.has(digest)) continue;
    seen.add(digest);
    digests.push({ digest, fileNeedsSlug, recordNeedsSlug });
  }
  return digests;
}

/** The team slug the old implementation prefixed, as this checkout computes it now. */
function legacyTeamSlug(localPath: string): string {
  let teamName = '';
  try {
    const raw = YAML.parse(fs.readFileSync(path.join(localPath, 'teamai.yaml'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const candidate = (raw as { team?: unknown }).team;
      if (typeof candidate === 'string') teamName = candidate;
    }
  } catch {
    // Older team repositories may not have a readable teamai.yaml.
  }
  const fallback = path.basename(localPath) || 'team';
  return (teamName || fallback).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'team';
}

/** A provider-ambiguous legacy values file that only an explicit user confirmation may adopt. */
export interface UnadoptedLegacyFile {
  /** Basename including the `.json` extension, e.g. `alpha-a1b2c3d4e5.json`. */
  entry: string;
  /** The stored identity without the extension: `<slug>-<digest>` — what the user adopts. */
  identity: string;
  /** Last-modified time, used to order candidates newest-first. */
  mtime: number;
}

/**
 * The `<slug>-<digest>.json` files under a provider-ambiguous digest (a
 * path-shaped `repo:` claim, a provider-relative remote, a bare alias, or a
 * path-only local path) that this checkout could read but has not been told
 * to. The old name scheme never encoded the provider, so the slug cannot
 * prove ownership across providers — a GitHub and a GitCode team both named
 * `Alpha` on the bare claim `acme/widgets` hash the same file — and no
 * machine-global artifact distinguishes this checkout from another team on
 * the same machine. Adopting such a file is therefore the user's explicit
 * choice, never a silent guess. Repository-bound legacy files (a URL or
 * URL-shaped identity) are not listed: the identity carries its host, so
 * matching by digest alone is safe. When the provider-qualified hash-only
 * target already exists it shadows every legacy file — a past adoption and
 * migration is the permanent record, so nothing is offered again.
 */
export async function unadoptedLegacyFiles(
  localConfig: LocalConfig,
  options: { adopted?: ReadonlySet<string>; declined?: ReadonlySet<string> } = {},
): Promise<UnadoptedLegacyFile[]> {
  const target = getTeamValuesPath(localConfig);
  if (fs.existsSync(target)) return [];
  const candidates = legacyTeamValueHashes(localConfig);
  const dir = path.dirname(target);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files: UnadoptedLegacyFile[] = [];
  for (const entry of entries) {
    const legacy = /^(.+)-([0-9a-f]{10})\.json$/.exec(entry);
    if (legacy === null) continue;
    const digest = legacy[2] ?? '';
    const candidate = candidates.find((match) => match.digest === digest);
    if (candidate === undefined || !candidate.fileNeedsSlug) continue;
    const identity = entry.replace(/\.json$/, '');
    const key = `${target}::${identity}`;
    if (options.adopted?.has(key) || options.declined?.has(key)) continue;
    try {
      const { mtimeMs } = await fs.promises.stat(path.join(dir, entry));
      files.push({ entry, identity, mtime: mtimeMs });
    } catch {
      // Removed by a concurrent process between readdir and stat.
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime || b.entry.localeCompare(a.entry));
}

/**
 * Whether a stored team identity (the current hash-only name or a legacy
 * `<slug>-<digest>` form) names the repository `localConfig` describes, and
 * so may own the switches recorded under it. Digests whose identity names a
 * single repository (a URL, a URL-shaped claim or remote) match by digest
 * alone — the identity is the repository, so the slug can drift with team
 * renames. A path-shaped claim, a path-shaped provider-relative remote, a
 * bare alias, or a path-only local path names no single repository — the
 * old name never encoded the provider, so NEITHER the slug nor any
 * machine-global artifact can attribute a record under it to this checkout:
 * a GitHub and a GitCode team both named `Alpha` on the bare claim
 * `acme/widgets` share the exact `alpha-<digest>` form. A record under such
 * a digest therefore never matches — the same reason a differently named
 * team is refused (no shared store tells a renamed team from another team)
 * closes an equal-slug claim too, because the slug proves nothing across
 * providers. Only the values file's explicit adoption, which migrates the
 * keys to the provider-qualified name, re-establishes this team's presence;
 * its switched agents are re-recorded by the next `models switch`.
 */
export function sameTeamIdentity(stored: string | undefined, localConfig: LocalConfig): boolean {
  if (!stored) return false;
  if (stored === getTeamIdentity(localConfig)) return true;
  const legacy = /^(.+)-([0-9a-f]{10})$/.exec(stored);
  if (legacy === null) return false;
  const digest = legacy[2] ?? '';
  for (const candidate of legacyTeamValueHashes(localConfig)) {
    if (candidate.digest !== digest) continue;
    if (!candidate.recordNeedsSlug) return true;
    return false;
  }
  return false;
}

/**
 * The file to read this team's values from, and where the next save lands:
 * the hash-only name, or — when it does not exist yet — a legacy
 * `<slug>-<digest>.json` an older version wrote for this checkout. Legacy
 * files are read where they lie; nothing is renamed, linked, or copied, so a
 * dry run needs no special casing and no filesystem quirk (races, unsupported
 * hard links, partial targets) can strand the keys. The next save writes the
 * hash-only file, which then shadows the legacy one. Values files under a
 * repository-bound digest (a URL, a URL-shaped remote, a `repo:` claim) match
 * by digest alone — the slug drifts with team renames, and the identity
 * carries its host with no ambiguity. A provider-ambiguous digest (a
 * path-shaped claim, a path-shaped remote, a bare alias, a path-only local
 * path) names no single repository: the old name never encoded the provider,
 * so the slug cannot tell two providers' same-named teams apart and no
 * machine-global artifact can tell this checkout from another team. A file
 * under such a digest is read only when the user has explicitly adopted that
 * exact `<slug>-<digest>` identity for THIS provider-qualified team
 * (`options.adopted` — keyed `${target}::<slug>-<digest>`, so a same-named
 * identity adopted in another scope or for another provider never
 * authorizes this team); the caller surfaces the candidates via
 * `unadoptedLegacyFiles` and turns the user's word into that set. Without it
 * the file is never guessed into read.
 */
export async function findTeamValuesPath(
  localConfig: LocalConfig,
  options: { adopted?: ReadonlySet<string>; declined?: ReadonlySet<string> } = {},
): Promise<string> {
  const target = getTeamValuesPath(localConfig);
  if (fs.existsSync(target)) return target;
  const candidates = legacyTeamValueHashes(localConfig);
  const dir = path.dirname(target);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return target; // no teams directory yet — nothing to read
  }
  const matching: Array<{ entry: string; mtime: number }> = [];
  for (const entry of entries) {
    const legacy = /^(.+)-([0-9a-f]{10})\.json$/.exec(entry);
    if (legacy === null) continue;
    const digest = legacy[2] ?? '';
    const candidate = candidates.find((match) => match.digest === digest);
    if (candidate === undefined) continue;
    if (candidate.fileNeedsSlug) {
      const key = `${target}::${entry.replace(/\.json$/, '')}`;
      if (options.declined?.has(key)) continue;
      if (!options.adopted?.has(key)) continue;
    }
    try {
      const { mtimeMs } = await fs.promises.stat(path.join(dir, entry));
      matching.push({ entry, mtime: mtimeMs });
    } catch {
      // Removed by a concurrent process between readdir and stat; nothing to read.
    }
  }
  // newest first; equal timestamps take the lexicographically last name
  matching.sort((a, b) => b.mtime - a.mtime || b.entry.localeCompare(a.entry));
  return matching.length > 0 ? path.join(dir, matching[0]?.entry ?? '') : target;
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

/**
 * Mutually exclude concurrent read-modify-write cycles of one team values
 * file. writeJsonAtomic makes a single write atomic, but the migration that
 * creates the hash-only target does read-merge-write across what a
 * concurrent configure or switch may be writing in the same window; holding
 * the target's lock here lets every writer serialize that whole cycle. All
 * team-target writers (the migration in loadTeamValues, `models configure`,
 * and `models switch` key prompting) must go through it, or the lock only
 * serializes against itself.
 */
export async function withTeamValuesLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await acquireLock(lockPath)) {
      try { return await run(); }
      finally { await releaseLock(lockPath); }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Another model operation is writing ${filePath}; retry shortly`);
}

/**
 * Union of two stored-inputs maps for the migration save. Legacy values files
 * under one provider-ambiguous digest can differ in which team gateways they
 * carry keys for, so adopting several of them must keep every identity's keys:
 * the later map wins when both hold the same gateway key.
 */
export function mergeModelInputs(into: StoredModelInputs, later: StoredModelInputs): StoredModelInputs {
  return { ...into, ...later };
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
