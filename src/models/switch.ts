import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseJson } from '../utils/json.js';
import { parseYaml } from '../utils/yaml.js';
import { z } from 'zod';
import { parse as parseToml, type TomlTable, type TomlValue } from 'smol-toml';
import { withoutTomlBom } from '../utils/toml.js';
import { getUserHome } from '../utils/home.js';
import { agyGatewayOf, agyKeyFilePath, agyKeyFunction } from './agy-gateway.js';
import { toolHome } from '../tool-home.js';
import { errnoCode, pathExists, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { acquireLock, releaseLock } from '../update.js';
import { entryHash } from '../resources/mcp-format.js';
import { detectShellProfile, SHELL_PROFILE_CANDIDATE_NAMES, shellQuoteValue, toGeneratedForm } from '../utils/shell-profile.js';
import { resolveMemberToolRoots } from '../config.js';
import { isJsonObject, JsonValueSchema, recordedToolRootDir, RELOCATABLE_TOOLS, type JsonObject, type JsonValue, type LocalConfig, JsonObjectSchema } from '../types.js';
import { ALL_MODEL_AGENTS, ModelAgentSchema, type ModelAgent, type ModelProtocol, type ResolvedModelProfile, sameTeamIdentity } from './profile.js';

export { ALL_MODEL_AGENTS } from './profile.js';

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
] as const;

const CLAUDE_PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

/** The message of a caught error, which fs, JSON and YAML raise as an `Error`. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The settings TeamAI manages for one agent, as the manifest stores them: each
 * agent's snapshot type below, read back as plain JSON.
 */
type Snapshot = JsonValue;

interface AgentState {
  profile: string;
  /** Team repository identity for `team:` profiles. */
  team?: string;
  /** Default model chosen with `--model`, kept for later re-applies. */
  model?: string;
  previous: Snapshot;
  lastWritten: Snapshot;
  filePath?: string;
  pending?: { kind: 'switch' | 'restore'; before: Snapshot; prior?: AgentState | null };
}

interface ModelSwitchManifest {
  version: 1;
  agents: Partial<Record<ModelAgent, AgentState>>;
  /**
   * Legacy team values identities the user explicitly declined to adopt, as
   * `${target}::<slug>-<digest>` keys scoped to the provider-qualified team
   * target. A durable record — not silent shadowing — is what lets the
   * migration proceed past a foreign team's same-digest file while keeping the
   * choice visible and reversible (remove the key to re-offer the file).
   */
  legacyValueDeclines?: string[];
}

export interface ModelSwitchResult {
  agent: ModelAgent;
  status: 'switched' | 'restored' | 'unchanged' | 'skipped' | 'not-installed' | 'unsupported' | 'failed';
  message: string;
  warning?: string;
}

export interface ActiveModelProfile {
  profile: string;
  team?: string;
  model?: string;
}

function manifestPath(): string {
  return path.join(getUserHome(), '.teamai', 'models', 'managed.json');
}

async function withManifestLock<T>(run: () => Promise<T>): Promise<T> {
  const file = `${manifestPath()}.lock`;
  let acquired = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await acquireLock(file)) { acquired = true; break; }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!acquired) throw new Error('Another model operation is in progress; retry shortly');

  try { return await run(); }
  finally { await releaseLock(file); }
}

/** Claude's and Codex's roots, read once for one model operation (`agentRootsOf`). */
type AgentRoots = { readonly claude: string; readonly codex: string };

/**
 * Claude's and Codex's roots: the shell's CLAUDE_CONFIG_DIR or CODEX_HOME when it sets one,
 * as a switch made from that shell recorded; else the root `teamai init` recorded in the
 * scope's config (the one `pull` passes, else `resolveMemberToolRoots`), so a shell without
 * the variable still writes where the tool reads (#1221); else the default.
 */
async function agentRootsOf(localConfig: Pick<LocalConfig, 'toolRoots'> | undefined, dryRun: boolean | undefined): Promise<AgentRoots> {
  const toolRoots = localConfig ? localConfig.toolRoots : await resolveMemberToolRoots(undefined, { dryRun });

  const rootOf = (tool: 'claude' | 'codex'): string => {
    const { envVar, defaultRoot } = RELOCATABLE_TOOLS[tool];

    return process.env[envVar]?.trim() || recordedToolRootDir(tool, toolRoots) || path.join(getUserHome(), defaultRoot);
  };

  return { claude: rootOf('claude'), codex: rootOf('codex') };
}

function claudeSettingsPath(roots: AgentRoots): string {
  return path.join(roots.claude, 'settings.json');
}

function codexSettingsPath(roots: AgentRoots): string {
  return path.join(roots.codex, 'config.toml');
}

function openCodeSettingsPath(): string {
  const custom = process.env.OPENCODE_CONFIG?.trim();

  if (custom) return custom;

  return path.join(toolHome('opencode'), 'opencode.json');
}

/**
 * Pi relocates its whole agent directory with `PI_CODING_AGENT_DIR`, the same
 * way Codex honors `CODEX_HOME`. The file TeamAI manages inside it is
 * models.json; Pi's own settings.json holds the default-model selection and is
 * deliberately never written.
 */
function piSettingsPath(): string {
  return path.join(toolHome('pi'), 'models.json');
}

/**
 * OMP (Oh My Pi) keeps its provider catalog in `models.yml` in its agent dir,
 * which a profile or `PI_CONFIG_DIR` moves (`TOOLS.omp.home`). teamai does not
 * follow `PI_CODING_AGENT_DIR` for OMP: it is honored for Pi above, so
 * following it here too would send OMP's file into Pi's directory.
 *
 * The file is YAML, not JSON, and OMP only ever reads it — it rewrites neither
 * the file nor its layout, so TeamAI owns the bytes. An `apiKey` is used
 * literally: OMP expands neither `$VAR` nor `${VAR}` the way Pi does, so a key
 * held in the environment cannot stay there and is written out resolved.
 */
function ompSettingsPath(): string {
  return path.join(toolHome('omp'), 'models.yml');
}

/** Muse Code reads `model` and `endpoint_transport` from its user settings.json. */
function museSettingsPath(): string {
  return path.join(toolHome('muse'), 'settings.json');
}

/** Antigravity CLI keeps its settings beside its config root, in ~/.gemini/antigravity-cli. */
function agySettingsPath(): string {
  return path.join(toolHome('agy'), '..', 'antigravity-cli', 'settings.json');
}

function agentSettingsPath(agent: ModelAgent, roots: AgentRoots): string {
  if (agent === 'claude') return claudeSettingsPath(roots);

  if (agent === 'codex') return codexSettingsPath(roots);

  return ownSettingsPath(agent);
}

/** The settings file of an agent no `toolRoots` entry moves. */
function ownSettingsPath(agent: Exclude<ModelAgent, 'claude' | 'codex'>): string {
  if (agent === 'muse') return museSettingsPath();

  if (agent === 'agy') return agySettingsPath();

  if (agent === 'opencode') return openCodeSettingsPath();

  if (agent === 'pi') return piSettingsPath();

  if (agent === 'omp') return ompSettingsPath();

  if (agent === 'codebuddy') return path.join(toolHome('codebuddy'), 'models.json');

  return path.join(getUserHome(), `.${agent}`, 'models.json');
}

function sameAgentSettingsPath(agent: ModelAgent, state: AgentState, roots: AgentRoots): boolean {
  return !state.filePath || path.resolve(agentSettingsPath(agent, roots)) === path.resolve(state.filePath);
}

/** Why a switch whose settings file is not the one the agent uses now is left alone, and how to undo it. */
function movedSettingsMessage(agent: ModelAgent, state: AgentState, roots: AgentRoots): string {
  return `${agent} uses ${agentSettingsPath(agent, roots)} now, but TeamAI switched ${state.filePath}; leaving both untouched. `
    + `To undo that switch, run \`teamai models restore --agent ${agent}\` from a shell where ${agent} uses ${state.filePath}.`;
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** An agent's entry in the manifest, unknown keys kept so a save writes them back. */
const AgentStateSchema = z.looseObject({
  profile: z.string(),
  team: z.string().optional(),
  model: z.string().optional(),
  filePath: z.string().optional(),
  previous: JsonValueSchema,
  lastWritten: JsonValueSchema,
});

/** A write-ahead entry; `prior` is the agent's entry before the switch, which has no pending entry of its own. */
const PendingSchema = z.looseObject({
  kind: z.enum(['switch', 'restore']),
  before: JsonValueSchema,
  prior: AgentStateSchema.extend({ pending: z.never().optional() }).nullable().optional(),
});

const ManifestRootSchema = z.looseObject({
  version: z.literal(1),
  agents: JsonObjectSchema,
  legacyValueDeclines: JsonValueSchema.optional(),
});

async function loadManifest(): Promise<ModelSwitchManifest | null> {
  const file = manifestPath();
  const raw = await readOptionalFile(file);

  if (raw === null) return null;
  let parsed: unknown;

  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`Cannot parse model ownership manifest: ${file}`);
  }

  const root = ManifestRootSchema.safeParse(parsed);

  if (!root.success) {
    throw new Error(`Invalid model ownership manifest: ${file}`);
  }

  const { agents: entries, legacyValueDeclines, ...rest } = root.data;
  const agents: ModelSwitchManifest['agents'] = {};

  for (const [agent, entry] of Object.entries(entries)) {
    const name = ModelAgentSchema.safeParse(agent);
    const state = AgentStateSchema.safeParse(entry);

    if (!name.success || !state.success) {
      throw new Error(`Invalid model ownership entry for ${agent}: ${file}`);
    }

    // A falsy `pending` has always read as no pending entry. The spread keeps the entry's own key order for the next save.
    const { pending: written, ...fields } = isJsonObject(entry) ? { ...entry, ...state.data } : state.data;
    const pending = written ? PendingSchema.safeParse(written) : undefined;

    if (pending && (!pending.success || (pending.data.kind === 'switch' && !('prior' in pending.data)))) {
      throw new Error(`Invalid pending model ownership entry for ${agent}: ${file}`);
    }

    agents[name.data] = pending ? { ...fields, pending: pending.data } : fields;
  }

  const declines = z.array(z.string()).optional().safeParse(legacyValueDeclines);

  if (!declines.success) {
    throw new Error(`Invalid legacy value declines: ${file}`);
  }

  const manifest: ModelSwitchManifest = { ...rest, agents };

  if (declines.data !== undefined) manifest.legacyValueDeclines = declines.data;

  return manifest;
}

async function saveManifest(manifest: ModelSwitchManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(), manifest, { mode: 0o600 });
}

/** The legacy team values identities this machine declined to adopt, keyed `${target}::<slug>-<digest>`. */
export async function refusedLegacyValueKeys(): Promise<ReadonlySet<string>> {
  const manifest = await loadManifest();

  return new Set(manifest?.legacyValueDeclines ?? []);
}

/** Record a durable, target-scoped decline so the file is neither re-offered on every run nor silently shadowed. */
export async function refuseLegacyValue(key: string): Promise<void> {
  await withManifestLock(async () => {
    const manifest = await loadManifest() ?? { version: 1, agents: {} };
    const declines = new Set(manifest.legacyValueDeclines ?? []);
    declines.add(key);
    manifest.legacyValueDeclines = [...declines].sort();
    await saveManifest(manifest);
  });
}

/** A value TeamAI compares: a snapshot, or a value of a JSON, YAML or TOML settings file. */
type SettingsValue = JsonValue | TomlValue | undefined;

type CanonicalValue = SettingsValue | CanonicalValue[] | { [key: string]: CanonicalValue };

function hash(value: SettingsValue): string {
  function canonical(item: SettingsValue): CanonicalValue {
    if (Array.isArray(item)) return item.map(canonical);

    // A JSON or YAML mapping, a TOML table (which has no prototype) or a TOML date: an object whose entries sort.
    if (item === null || item === undefined || Object(item) !== item) return item;

    return Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }

  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}

function equal(a: SettingsValue, b: SettingsValue): boolean {
  return hash(a) === hash(b);
}

/** `snapshot` without `key`, a field the snapshot carries but ownership never compares. */
function withoutField(snapshot: Snapshot | undefined, key: string): Snapshot | undefined {
  if (!isJsonObject(snapshot)) return snapshot;
  const { [key]: _omitted, ...rest } = snapshot;

  return rest;
}

/**
 * Claude's /model command writes its pick to settings.json `model`. That is
 * the user choosing among the models TeamAI offered, not taking over, so the
 * top-level model never decides ownership.
 */
function sameManaged(agent: ModelAgent, a: Snapshot | undefined, b: Snapshot | undefined): boolean {
  // `id` keys the provider for TeamAI and is never written to the file, so it
  // is compared out: the recorded snapshot carries it, the one read back off
  // disk cannot, and an exact-equality check would report the agent as taken
  // over on every restore.
  if (agent === 'pi' || agent === 'omp') return equal(withoutField(a ?? {}, 'id'), withoutField(b ?? {}, 'id'));

  if (agent !== 'claude') return equal(a, b);

  return equal(withoutField(a, 'model'), withoutField(b, 'model'));
}

async function writableTarget(file: string): Promise<string> {
  try {
    return (await fs.promises.lstat(file)).isSymbolicLink()
      ? await fs.promises.realpath(file)
      : file;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return file;
    throw error;
  }
}

async function writeAgentJson(file: string, value: JsonValue): Promise<void> {
  await writeJsonAtomic(await writableTarget(file), value, { mode: 0o600 });
}

/** Read a YAML mapping, the shape OMP's `models.yml` uses. */
async function yamlObject(file: string): Promise<JsonObject> {
  const raw = await readOptionalFile(file);

  if (raw === null || raw.trim() === '') return {};
  let parsed: JsonValue;

  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${messageOf(error)}`, { cause: error });
  }

  if (parsed === null) return {};

  // The parsed document itself, not a schema copy, which would drop a `__proto__` key the file holds.
  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot update ${file}: the root must be a YAML mapping`);
  }

  return parsed;
}

/**
 * Replace OMP's models.yml with `doc`. `writeFileAtomic` resolves a symlinked
 * target itself, so unlike `writeAgentJson` this needs no `writableTarget`.
 *
 * `indent: 2` and a trailing newline match the layout OMP's own docs show; the
 * exact spelling is TeamAI's to choose, since OMP never rewrites the file.
 */
async function writeAgentYaml(file: string, doc: JsonObject): Promise<void> {
  await writeFileAtomic(file, YAML.stringify(doc, { indent: 2 }), { mode: 0o600 });
}

async function jsonObject(file: string): Promise<JsonObject> {
  const raw = await readOptionalFile(file);

  if (raw === null || raw.trim() === '') return {};
  let parsed: JsonValue;

  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${messageOf(error)}`, { cause: error });
  }

  // The parsed document itself, not a schema copy, which would drop a `__proto__` key the file holds.
  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot update ${file}: the root must be a JSON object`);
  }

  return parsed;
}

async function installed(agent: ModelAgent, roots: AgentRoots): Promise<boolean> {
  return pathExists(path.dirname(agentSettingsPath(agent, roots)));
}

function supportedRoute(agent: ModelAgent, profile: ResolvedModelProfile): boolean {
  if (agent === 'claude') return !!profile.routes.anthropic;

  if (agent === 'codex' || agent === 'muse') return !!profile.routes['openai-responses'];

  if (agent === 'agy') return !!profile.routes.gemini;

  // OpenCode, Pi and OMP name an api per model, so any serves an Anthropic or OpenAI protocol.
  if (agent === 'opencode' || agent === 'pi' || agent === 'omp') {
    return !!(profile.routes.anthropic || profile.routes['openai-responses'] || profile.routes['openai-chat-completions']);
  }

  return !!profile.routes['openai-chat-completions'];
}

// ─── Pi / OMP ─────────────────────────────────────────────
//
// OMP is Pi's fork and keeps the same provider catalog: a `providers` map of
// `{ name, baseUrl, apiKey, api, models }`, with a model overriding `api` and
// `baseUrl` per entry. The helpers below are shared; the two differ only in the
// file each writes (`models.json` / `models.yml`), its serialization, and how a
// key held in the environment is spelled.

/**
 * The protocols Pi and OMP can serve, in the order a model reachable through
 * several of them is registered: an OpenAI protocol wins over Anthropic, so a
 * gateway that serves one model both ways is used over its OpenAI-compatible
 * endpoint and only a group declared `anthropic` alone is spoken to as
 * Anthropic Messages. Declare a model such as `claude-opus-4-8` in a group of
 * its own to pin it.
 */
const PI_APIS = [
  ['openai-chat-completions', 'openai-completions'],
  ['openai-responses', 'openai-responses'],
  ['anthropic', 'anthropic-messages'],
] as const satisfies ReadonlyArray<readonly [ModelProtocol, string]>;

/**
 * The provider key TeamAI writes, and the one a later restore removes. It is
 * the profile's qualified ref — `team:<id>` / `local:<id>` — and not the bare
 * `id`: an `id` is unique only within one catalog file, so `local:tokenhub` and
 * `team:tokenhub` can both exist, and keying by the bare id would make the
 * second silently overwrite the first gateway's provider. The ref is also what
 * the rest of the CLI already names a profile by, and it is stable while the
 * gateway is, unlike the display `name`.
 */
function piProviderKey(profile: ResolvedModelProfile): string {
  return profile.ref;
}

type PiModel = { id: string; api?: string; baseUrl?: string };

interface PiProvider {
  /** Provider-level api and url; a model may override both. */
  api: string;
  baseUrl: string;
  models: PiModel[];
}

/**
 * The single provider TeamAI writes into Pi's models.json, or null when the
 * catalog has no protocol Pi can serve.
 *
 * Pi resolves `api` and `baseUrl` per model before falling back to the
 * provider's, so a catalog whose protocols disagree on the URL — Anthropic
 * takes the gateway root, the OpenAI protocols `<root>/v1` — is still one
 * provider: the first protocol in `PI_APIS` becomes the provider default and
 * every model reached through another carries both fields itself.
 */
function piProvider(profile: ResolvedModelProfile): PiProvider | null {
  const models: PiModel[] = [];
  const of = new Map<string, { api: string; baseUrl: string }>();
  let fallback: { api: string; baseUrl: string } | undefined;

  for (const [protocol, api] of PI_APIS) {
    const route = profile.routes[protocol];

    if (!route) continue;
    fallback ??= { api, baseUrl: route.base_url };

    for (const model of route.models) {
      if (of.has(model)) continue;
      of.set(model, { api, baseUrl: route.base_url });
    }
  }

  if (fallback === undefined) return null;

  for (const [model, route] of of) {
    // Only a model that departs from the provider default repeats the fields.
    models.push(route.api === fallback.api && route.baseUrl === fallback.baseUrl
      ? { id: model }
      : { id: model, api: route.api, baseUrl: route.baseUrl });
  }

  return { api: fallback.api, baseUrl: fallback.baseUrl, models };
}

/** The provider entry TeamAI owns, or null when it owns none. */
type PiSnapshot = JsonObject | null;

/**
 * Read the provider TeamAI manages. Its key is the profile ref, which is not
 * part of the snapshot, so `reference` names it — the snapshot last written for
 * this agent, and the same role OpenCode's constant `teamai` key plays there.
 */
function piSnapshot(doc: JsonObject, reference?: Snapshot): PiSnapshot {
  const id = piKeyOf(reference);

  if (id === null) return null;
  const provider = (isJsonObject(doc.providers) ? doc.providers : {})[id];

  return isJsonObject(provider) ? provider : null;
}

/**
 * The key a written snapshot is stored under, read back off the snapshot
 * itself. `id` rides along in the manifest's `lastWritten` but never reaches
 * Pi's file, so it is the one record of the key — shared by the switch that
 * wrote the entry and the restore that later removes it, with no second copy to
 * keep in step.
 */
function piKeyOf(reference: Snapshot | undefined): string | null {
  const id = z.string().safeParse(isJsonObject(reference) ? reference.id : undefined);

  return id.success ? id.data : null;
}

/** The file and reader for the Pi-family agent whose provider TeamAI manages. */
async function piDoc(agent: 'pi' | 'omp'): Promise<JsonObject> {
  const file = ownSettingsPath(agent);
  const doc = agent === 'omp' ? await yamlObject(file) : await jsonObject(file);

  if (doc.providers !== undefined && !isJsonObject(doc.providers)) {
    throw new Error(`Cannot update ${file}: providers must be an object`);
  }

  return doc;
}

/**
 * Write TeamAI's one provider entry, or remove it. `snapshot` is the desired
 * provider — carrying, under `id`, the profile ref it is keyed by — or null on
 * a restore, which writes back whatever the agent had before TeamAI and so
 * names no provider of its own. `previousManaged` is the entry the last switch
 * wrote: its key is used when `snapshot` has none, and dropped when this write
 * does not use it, so re-pointing a profile at a different ref leaves no orphan.
 */
async function writePi(agent: 'pi' | 'omp', snapshot: PiSnapshot, previousManaged?: Snapshot): Promise<void> {
  const file = ownSettingsPath(agent);
  const doc = await piDoc(agent);
  const providers: JsonObject = isJsonObject(doc.providers) ? { ...doc.providers } : {};
  const managed = piKeyOf(previousManaged);
  const id = piKeyOf(snapshot) ?? managed;

  if (id === null) return;

  if (snapshot === null) delete providers[id];
  else {
    // `id` keys the entry for TeamAI and is not part of the provider schema
    // either tool reads, so it is held back from the file.
    const { id: _key, ...provider } = snapshot;
    providers[id] = provider;
  }

  if (managed !== null && managed !== id) delete providers[managed];

  if (Object.keys(providers).length === 0) delete doc.providers;
  else doc.providers = providers;

  if (agent === 'omp') await writeAgentYaml(file, doc);
  else await writeAgentJson(file, doc);
}

// ─── Claude ───────────────────────────────────────────────

type ClaudeSnapshot = Record<(typeof CLAUDE_ENV_KEYS)[number] | 'model' | 'modelPicker', JsonValue>;

function claudeEnv(settings: JsonObject): JsonObject {
  return isJsonObject(settings.env) ? settings.env : {};
}

function claudeSnapshot(settings: JsonObject): ClaudeSnapshot {
  const env = claudeEnv(settings);
  const managed = (key: keyof ClaudeSnapshot) => (key === 'model' || key === 'modelPicker' ? settings[key] : env[key]) ?? null;

  return {
    ANTHROPIC_BASE_URL: managed('ANTHROPIC_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: managed('ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: managed('ANTHROPIC_API_KEY'),
    ANTHROPIC_CUSTOM_HEADERS: managed('ANTHROPIC_CUSTOM_HEADERS'),
    ANTHROPIC_MODEL: managed('ANTHROPIC_MODEL'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: managed('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: managed('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: managed('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ANTHROPIC_CUSTOM_MODEL_OPTION: managed('ANTHROPIC_CUSTOM_MODEL_OPTION'),
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: managed('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME'),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: managed('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'),
    model: managed('model'),
    modelPicker: managed('modelPicker'),
  };
}

/** Write a Claude snapshot; a key the snapshot leaves null or out is removed from settings.json. */
async function writeClaude(snapshot: Partial<ClaudeSnapshot>, roots: AgentRoots): Promise<void> {
  const file = claudeSettingsPath(roots);
  const settings = await jsonObject(file);

  if (settings.env !== undefined && !isJsonObject(settings.env)) {
    throw new Error(`Cannot update ${file}: env must be an object`);
  }

  const env = { ...claudeEnv(settings) };

  for (const key of CLAUDE_ENV_KEYS) {
    if (snapshot[key] === null || snapshot[key] === undefined) delete env[key];
    else env[key] = snapshot[key];
  }

  if (Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;

  for (const key of ['model', 'modelPicker'] as const) {
    if (snapshot[key] === null || snapshot[key] === undefined) delete settings[key];
    else settings[key] = snapshot[key];
  }

  await writeAgentJson(file, settings);
}

/** The models a Claude snapshot's `modelPicker` offers, as `desiredSnapshot` writes it. */
const ClaudeModelPickerSchema = z.object({ options: z.array(z.object({ model: JsonValueSchema.optional() })).optional() }).nullable();

/** A settings.json model without Claude's `[1m]` context suffix. */
function claudeModelId(value: JsonValue | undefined): string | undefined {
  const model = z.string().safeParse(value);

  return model.success ? model.data.replace(/\[1m\]$/i, '') : undefined;
}

function claudeProviderFlagEnabled(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== '' && value !== '0' && value !== 'false' && value !== false;
}

/**
 * Shell variables beat settings.json for Claude sessions started from that
 * shell, so any value that differs from what TeamAI writes keeps overriding
 * it there. Host apps (for example the Claude Code desktop app) set their own
 * values, so this is a warning, not a refusal.
 */
function claudeShellOverrides(desired: Partial<ClaudeSnapshot>): string[] {
  return Object.keys(process.env).filter((key) => {
    const value = process.env[key];

    if (value === '') return false;

    if (CLAUDE_PROVIDER_KEYS.some((flag) => flag === key)) return claudeProviderFlagEnabled(value);
    const managed = CLAUDE_ENV_KEYS.find((envKey) => envKey === key);

    return managed !== undefined && value !== desired[managed];
  }).sort();
}

// ─── Codex ────────────────────────────────────────────────

const CodexSnapshotSchema = z.object({
  model: z.string().optional(),
  model_provider: z.string().optional(),
  providerBlock: z.string().optional(),
});

type CodexSnapshot = z.infer<typeof CodexSnapshotSchema>;

const CODEX_PROVIDER_BLOCK_RE = /^\[model_providers\.teamai\]\s*$[\s\S]*?(?=^\[(?!model_providers\.teamai[.\]])|(?![\s\S]))/m;

function parseCodex(source: string): TomlTable {
  try {
    return parseToml(withoutTomlBom(source));
  } catch (error) {
    throw new Error(`Cannot parse Codex config.toml: ${messageOf(error)}`, { cause: error });
  }
}

/** A top-level string setting of config.toml, which TeamAI refuses to update when it holds anything else. */
function codexString(parsed: TomlTable, key: 'model' | 'model_provider'): string | undefined {
  const value = z.string().optional().safeParse(parsed[key]);

  if (!value.success) throw new Error(`Cannot update Codex config.toml: ${key} must be a string`);

  return value.data;
}

function codexSnapshot(source: string): CodexSnapshot {
  const parsed = parseCodex(source);

  return {
    model: codexString(parsed, 'model'),
    model_provider: codexString(parsed, 'model_provider'),
    providerBlock: withoutTomlBom(source).match(CODEX_PROVIDER_BLOCK_RE)?.[0].replace(/\n+$/, ''),
  };
}

/** A TOML table of a parsed config.toml: only the table itself is checked, its values are what `parseToml` read. */
const TomlTableSchema = z.record(z.string(), z.custom<TomlValue>());

function setTopLevelString(source: string, key: string, value: string | undefined): string {
  const re = new RegExp(`^([ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[ \\t]*)(.*)$`, 'm');
  const firstTable = source.search(/^\s*\[/m);
  const top = firstTable < 0 ? source : source.slice(0, firstTable);
  const tables = firstTable < 0 ? '' : source.slice(firstTable);

  if (re.test(top)) {
    const updated = value === undefined
      ? top.replace(new RegExp(`${re.source}(?:\\r?\\n|$)`, 'm'), '')
      : top.replace(re, (line, prefix: string, oldValue: string) => {
        let quote: '"' | "'" | null = null;
        let escaped = false;
        let comment = '';

        for (let i = 0; i < oldValue.length; i++) {
          const char = oldValue[i];

          if (escaped) { escaped = false; continue; }

          if (quote === '"' && char === '\\') { escaped = true; continue; }

          if (quote) { if (char === quote) quote = null; continue; }

          if (char === '"' || char === "'") { quote = char; continue; }

          if (char === '#') { comment = oldValue.slice(i).trimEnd(); break; }
        }

        return `${prefix}${JSON.stringify(value)}${comment ? ` ${comment}` : ''}`;
      });

    return updated + tables;
  }

  if (value === undefined) return source;
  const line = `${key} = ${JSON.stringify(value)}\n`;

  if (firstTable < 0) return `${source.trimEnd()}${source.trim() ? '\n' : ''}${line}`;

  return `${top.trimEnd()}\n${line}\n${tables}`;
}

function setCodexProviderBlock(source: string, block: string | undefined): string {
  if (CODEX_PROVIDER_BLOCK_RE.test(source)) {
    const updated = source.replace(CODEX_PROVIDER_BLOCK_RE, block ? `${block}\n\n` : '');

    return block === undefined ? updated.replace(/\n{2,}$/, '\n') : updated;
  }

  if (!block) return source;

  return `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${block}\n`;
}

async function writeCodex(snapshot: CodexSnapshot, roots: AgentRoots): Promise<void> {
  const file = codexSettingsPath(roots);
  let source = (await readOptionalFile(file)) ?? '';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  source = withoutTomlBom(source);
  source = setTopLevelString(source, 'model', snapshot.model);
  source = setTopLevelString(source, 'model_provider', snapshot.model_provider);
  source = setCodexProviderBlock(source, snapshot.providerBlock);
  // The edits above are line-based. Parse the result so an unusual layout
  // (multiline strings, inline tables) can never produce a broken config or
  // one that differs from the intended settings.
  const unsafe = new Error(`Cannot safely update ${file}; set model, model_provider, and [model_providers.teamai] manually`);
  let parsed: TomlTable;

  try {
    parsed = parseToml(withoutTomlBom(source));
  } catch {
    throw unsafe;
  }

  const wantedProvider = snapshot.providerBlock
    ? TomlTableSchema.safeParse(parseToml(snapshot.providerBlock).model_providers).data?.teamai
    : undefined;

  const providers = TomlTableSchema.safeParse(parsed.model_providers).data ?? {};

  if (parsed.model !== snapshot.model || parsed.model_provider !== snapshot.model_provider || !equal(providers.teamai, wantedProvider)) {
    throw unsafe;
  }

  await writeFileAtomic(await writableTarget(file), bom + source, { mode: 0o600 });
}

// ─── Key files: Muse Code, Antigravity CLI ────────────────
//
// Muse Code and Antigravity CLI have no settings key for the API key: they
// read it from the environment. So the key goes into a file of the agent's
// own that a shell profile block sources, and only shells started after a
// switch see it. Each block has markers of its own: the team env block's
// markers belong to `teamai pull`, which rewrites or removes that block.

/** An agent's file of exports, and the markers of the profile block that sources it. */
interface KeyFile {
  readonly path: () => string;
  readonly start: string;
  readonly end: string;
}

const MUSE_KEYS: KeyFile = {
  path: () => path.join(getUserHome(), '.teamai', 'models', 'env.sh'),
  start: '# [teamai:models:start]',
  end: '# [teamai:models:end]',
};

const AGY_KEYS: KeyFile = {
  path: agyKeyFilePath,
  start: '# [teamai:models:agy:start]',
  end: '# [teamai:models:agy:end]',
};

function withoutKeyBlock(content: string, keys: KeyFile): string {
  const start = content.indexOf(keys.start);

  if (start === -1) return content;
  const end = content.indexOf(keys.end, start);

  if (end === -1) return content;
  const head = content.slice(0, start).replace(/\n$/, '');
  const tail = content.slice(end + keys.end.length).replace(/^\n/, '');

  return head && tail ? `${head}\n${tail}` : head ? `${head}\n` : tail;
}

/**
 * Write `keyExport` to the agent's key file and source it from the shell profile,
 * or with null remove both; `writeSettings` points the agent at the gateway after
 * the key lands, and back before the key goes.
 */
async function writeKeyExport(keys: KeyFile, keyExport: string | null, writeSettings: () => Promise<void>): Promise<void> {
  const keyFile = keys.path();
  // The file the block goes in for zsh may be under ZDOTDIR.
  const profiles = [...new Set([...SHELL_PROFILE_CANDIDATE_NAMES.map((name) => path.join(getUserHome(), name)), await detectShellProfile()])];

  if (keyExport === null) {
    await writeSettings();
    await fs.promises.rm(keyFile, { force: true });

    for (const profile of profiles) {
      const content = await readOptionalFile(profile);

      if (content !== null && content.includes(keys.start)) {
        await writeFileAtomic(profile, withoutKeyBlock(content, keys));
      }
    }

    return;
  }

  await writeFileAtomic(keyFile, keyExport, { mode: 0o600 });
  await writeSettings();
  const sourced = await Promise.all(profiles.map(async (profile) => (await readOptionalFile(profile))?.includes(keys.start)));

  if (sourced.some(Boolean)) return;
  const profile = await detectShellProfile();
  const content = (await readOptionalFile(profile)) ?? '';
  const quoted = shellQuoteValue(toGeneratedForm(keyFile));
  const block = `${keys.start}\n[ -f ${quoted} ] && . ${quoted}\n${keys.end}\n`;
  await writeFileAtomic(profile, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${block}`);
}

const MuseSnapshotSchema = z.object({
  model: JsonValueSchema.optional(),
  endpoint_transport: JsonValueSchema.optional(),
  /** The content of Muse's key file; null when there is none. */
  keyExport: z.string().nullable(),
});

type MuseSnapshot = z.infer<typeof MuseSnapshotSchema>;

async function museSnapshot(): Promise<MuseSnapshot> {
  const settings = await jsonObject(museSettingsPath());

  return {
    model: settings.model,
    endpoint_transport: settings.endpoint_transport,
    keyExport: await readOptionalFile(MUSE_KEYS.path()),
  };
}

async function writeMuse(snapshot: MuseSnapshot): Promise<void> {
  const file = museSettingsPath();
  // Muse refuses a settings.json without schema_version.
  const settings = Object.assign({ schema_version: 1 }, await jsonObject(file));

  for (const key of ['model', 'endpoint_transport'] as const) {
    if (snapshot[key] === undefined) delete settings[key];
    else settings[key] = snapshot[key];
  }

  await writeKeyExport(MUSE_KEYS, snapshot.keyExport, () => writeAgentJson(file, settings));
}

/**
 * Antigravity CLI uses a gateway when settings.json says `modelProvider: "gemini"`;
 * the key comes from GEMINI_API_KEY and the endpoint from GOOGLE_GEMINI_BASE_URL.
 * Its `model` names an entry of agy's own catalog by display name, and agy sends
 * that entry's Gemini model id whatever the gateway serves, so it is left to the member.
 */
const AgySnapshotSchema = z.object({
  modelProvider: JsonValueSchema.optional(),
  /** The content of agy's key file; null when there is none. */
  keyExport: z.string().nullable().catch(null),
});

type AgySnapshot = z.infer<typeof AgySnapshotSchema>;

async function agySnapshot(): Promise<AgySnapshot> {
  const settings = await jsonObject(agySettingsPath());

  return { modelProvider: settings.modelProvider, keyExport: await readOptionalFile(AGY_KEYS.path()) };
}

/** Write a snapshot `agySnapshot` or `desiredSnapshot` made, read back from the manifest as it was saved. */
async function writeAgy(snapshot: Snapshot): Promise<void> {
  const recorded = AgySnapshotSchema.safeParse(isJsonObject(snapshot) ? snapshot : {}).data ?? { keyExport: null };
  const file = agySettingsPath();
  const settings = await jsonObject(file);

  if (recorded.modelProvider === undefined) delete settings.modelProvider;
  else settings.modelProvider = recorded.modelProvider;
  await writeKeyExport(AGY_KEYS, recorded.keyExport, () => writeAgentJson(file, settings));
}

// ─── OpenCode ─────────────────────────────────────────────

const OPENCODE_PROVIDERS = [
  ['anthropic', 'teamai-anthropic', '@ai-sdk/anthropic'],
  ['openai-chat-completions', 'teamai-chat', '@ai-sdk/openai-compatible'],
  ['openai-responses', 'teamai-responses', '@ai-sdk/openai'],
] as const;

const OPENCODE_PROVIDER_IDS: string[] = OPENCODE_PROVIDERS.map(([, id]) => id);

/** A provider TeamAI writes into opencode.json. */
type OpenCodeProvider = {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey: string };
  models: Record<string, { name: string }>;
};

const OpenCodeSnapshotSchema = z.object({
  model: JsonValueSchema.optional(),
  /** Each TeamAI provider id, with null where the file has none. */
  providers: JsonObjectSchema,
});

type OpenCodeSnapshot = z.infer<typeof OpenCodeSnapshotSchema>;

function openCodeProviders(doc: JsonObject): JsonObject {
  return isJsonObject(doc.provider) ? doc.provider : {};
}

function openCodeSnapshot(doc: JsonObject): OpenCodeSnapshot {
  const providers = openCodeProviders(doc);

  return {
    model: doc.model ?? null,
    providers: Object.fromEntries(OPENCODE_PROVIDER_IDS.map((id) => [id, providers[id] ?? null])),
  };
}

async function writeOpenCode(snapshot: OpenCodeSnapshot): Promise<void> {
  const file = openCodeSettingsPath();
  const doc = await jsonObject(file);

  if (doc.provider !== undefined && !isJsonObject(doc.provider)) {
    throw new Error(`Cannot update ${file}: provider must be an object`);
  }

  const providers = { ...openCodeProviders(doc) };

  if (snapshot.model === null || snapshot.model === undefined) delete doc.model;
  else doc.model = snapshot.model;

  for (const [id, value] of Object.entries(snapshot.providers)) {
    if (value === null) delete providers[id];
    else providers[id] = value;
  }

  if (Object.keys(providers).length === 0) delete doc.provider;
  else doc.provider = providers;
  await writeAgentJson(file, doc);
}

// ─── CodeBuddy / WorkBuddy ────────────────────────────────

type BuddyAgent = 'codebuddy' | 'workbuddy';

const BuddySnapshotSchema = z.object({
  /** Each managed model id's entry, or null where the file has none. */
  entries: JsonObjectSchema,
  allowed: z.record(z.string(), z.boolean()).optional(),
});

type BuddySnapshot = z.infer<typeof BuddySnapshotSchema>;

/** A Buddy agent's models.json: the root, its model entries, and the ids its `availableModels` allows. */
interface BuddyDoc {
  file: string;
  doc: JsonObject | JsonValue[];
  models: JsonValue[];
  availableModels?: string[];
}

async function buddyDoc(agent: BuddyAgent): Promise<BuddyDoc> {
  const file = ownSettingsPath(agent);
  const raw = await readOptionalFile(file);

  if (raw === null || raw.trim() === '') return { file, doc: {}, models: [] };
  let parsed: unknown;

  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`Cannot parse ${file}: ${messageOf(error)}`, { cause: error });
  }

  const root = z.union([z.array(JsonValueSchema), JsonObjectSchema]).safeParse(parsed);

  if (!root.success) throw new Error(`Cannot update ${file}: root must be an object or array`);

  if (Array.isArray(root.data)) return { file, doc: root.data, models: root.data };
  const doc = root.data;
  const availableModels = z.array(z.string()).optional().safeParse(doc.availableModels);

  if (!availableModels.success) {
    throw new Error(`Cannot update ${file}: availableModels must be an array of model IDs`);
  }

  if (doc.models === undefined) return { file, doc, models: [], availableModels: availableModels.data };

  if (!Array.isArray(doc.models)) throw new Error(`Cannot update ${file}: models must be an array`);

  return { file, doc, models: doc.models, availableModels: availableModels.data };
}

function buddyEntry(models: JsonValue[], id: string): JsonValue | undefined {
  return models.find((entry) => isJsonObject(entry) && entry.id === id);
}

function buddyAllowed(availableModels: string[] | undefined, ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, availableModels?.includes(id) ?? false]));
}

function reconcileBuddyAllowed(availableModels: string[] | undefined, allowed: Record<string, boolean | undefined> | undefined): string[] | undefined {
  if (!availableModels || !allowed) return availableModels;
  const next = availableModels.filter((id) => allowed[id] !== false);

  for (const [id, enabled] of Object.entries(allowed)) {
    if (enabled && !next.includes(id)) next.push(id);
  }

  return next;
}

async function localAgentOwnsBuddyEntry(agent: BuddyAgent, id: string, entry: JsonValue): Promise<boolean> {
  const manifest = await jsonObject(path.join(getUserHome(), '.teamai', 'local-agent', 'model-manifest.json'));
  const owned = manifest[agent];

  return isJsonObject(owned) && owned[id] === entryHash(entry);
}

// Buddy apps add their own metadata to entries. Only the fields TeamAI wrote
// decide ownership.
function buddyOwnedEntry(entry: JsonValue | undefined, written: JsonValue): JsonValue {
  if (entry === undefined) return null;

  if (!isJsonObject(entry) || !isJsonObject(written)) return entry;
  const owned: JsonObject = {};

  for (const key of Object.keys(written)) {
    const value = entry[key];

    if (value !== undefined) owned[key] = value;
  }

  return owned;
}

/**
 * Replace TeamAI's Buddy entries. When one TeamAI entry replaces another,
 * metadata the app added to it is kept; a restore puts the original back
 * exactly, so an entry owned by local-agent delivery still matches its hash.
 */
async function replaceBuddy(
  agent: BuddyAgent,
  previousManaged: BuddySnapshot | undefined,
  desired: BuddySnapshot,
  keepAppMetadata: boolean,
  released?: BuddySnapshot,
): Promise<void> {
  const { file, doc, models, availableModels } = await buddyDoc(agent);
  const previousEntries = previousManaged?.entries ?? {};
  const managedIds = new Set([...Object.keys(previousEntries), ...Object.keys(desired.entries)]);

  const next = models.filter((entry) => {
    const id = isJsonObject(entry) ? z.string().safeParse(entry.id) : undefined;

    return !(id?.success && managedIds.has(id.data));
  });

  for (const [id, entry] of Object.entries(desired.entries)) {
    if (entry === null) continue;
    const current = buddyEntry(models, id);
    const prior = previousEntries[id];

    if (keepAppMetadata && isJsonObject(current) && isJsonObject(prior) && isJsonObject(entry)) {
      const extras = Object.fromEntries(Object.entries(current).filter(([key]) => !(key in prior)));
      next.push({ ...extras, ...entry });
    } else next.push(entry);
  }

  next.push(...Object.values(released?.entries ?? {}).filter((entry) => entry !== null));
  const allowed = desired.allowed || released?.allowed ? { ...released?.allowed, ...desired.allowed } : undefined;

  if (Array.isArray(doc)) {
    await writeAgentJson(file, next);

    return;
  }

  const written = Object.assign({}, doc, { models: next });
  const reconciled = allowed ? reconcileBuddyAllowed(availableModels, allowed) : undefined;

  if (reconciled !== undefined) written.availableModels = reconciled;
  await writeAgentJson(file, written);
}

// ─── Snapshots ────────────────────────────────────────────

/**
 * Read the fields TeamAI manages for an agent. Buddy snapshots cover the
 * model IDs in `reference` (the last written or the desired snapshot).
 */
async function currentSnapshot(agent: ModelAgent, roots: AgentRoots, reference?: Snapshot): Promise<Snapshot> {
  if (agent === 'claude') return claudeSnapshot(await jsonObject(claudeSettingsPath(roots)));

  if (agent === 'codex') return codexSnapshot((await readOptionalFile(codexSettingsPath(roots))) ?? '');

  if (agent === 'opencode') return openCodeSnapshot(await jsonObject(openCodeSettingsPath()));

  if (agent === 'muse') return museSnapshot();

  if (agent === 'agy') return agySnapshot();

  if (agent === 'pi' || agent === 'omp') return piSnapshot(await piDoc(agent), reference);
  const written = reference === undefined ? undefined : buddySnapshotOf(agent, reference);
  const { models, availableModels } = await buddyDoc(agent);
  const entries = written?.entries ?? {};
  const snapshot: BuddySnapshot = { entries: {} };

  for (const [id, entry] of Object.entries(entries)) snapshot.entries[id] = buddyOwnedEntry(buddyEntry(models, id), entry);

  if (written?.allowed) snapshot.allowed = buddyAllowed(availableModels, Object.keys(written.allowed));

  return snapshot;
}

/** A Buddy snapshot recorded for `agent`; anything else in its place is a manifest TeamAI did not write. */
function buddySnapshotOf(agent: BuddyAgent, snapshot: Snapshot): BuddySnapshot {
  const parsed = BuddySnapshotSchema.safeParse(snapshot);

  if (!parsed.success) throw new Error(`Invalid model ownership snapshot for ${agent}`);

  return parsed.data;
}

/** Parse a snapshot recorded for `agent` with that agent's schema. */
function recordedSnapshot<T>(agent: ModelAgent, schema: z.ZodType<T>, snapshot: Snapshot): T {
  const parsed = schema.safeParse(snapshot);

  if (!parsed.success) throw new Error(`Invalid model ownership snapshot for ${agent}`);

  return parsed.data;
}

async function writeSnapshot(
  agent: ModelAgent,
  roots: AgentRoots,
  snapshot: Snapshot,
  previousManaged?: Snapshot,
  keepAppMetadata = false,
  released?: BuddySnapshot,
): Promise<void> {
  if (agent === 'claude') return writeClaude(recordedSnapshot(agent, JsonObjectSchema, snapshot), roots);

  if (agent === 'codex') return writeCodex(recordedSnapshot(agent, CodexSnapshotSchema, snapshot), roots);

  if (agent === 'opencode') return writeOpenCode(recordedSnapshot(agent, OpenCodeSnapshotSchema, snapshot));

  if (agent === 'muse') return writeMuse(recordedSnapshot(agent, MuseSnapshotSchema, snapshot));

  if (agent === 'agy') return writeAgy(snapshot);

  if (agent === 'pi' || agent === 'omp') return writePi(agent, isJsonObject(snapshot) ? snapshot : null, previousManaged);

  return replaceBuddy(agent, previousManaged === undefined ? undefined : buddySnapshotOf(agent, previousManaged), buddySnapshotOf(agent, snapshot), keepAppMetadata, released);
}

function desiredSnapshot(agent: ModelAgent, profile: ResolvedModelProfile): Snapshot {
  const envRef = profile.api_key_env;

  if (agent === 'claude') {
    const route = profile.routes.anthropic!;
    const models = route.models;
    // Claude's own background work and subagents ask for opus/sonnet/haiku.
    // Point each family at a matching gateway model, else the default.
    const family = (name: string) => models.find((model) => model.toLowerCase().includes(name)) ?? models[0];

    return {
      ANTHROPIC_BASE_URL: route.base_url,
      ANTHROPIC_AUTH_TOKEN: profile.api_key_value ?? null,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_CUSTOM_HEADERS: null,
      ANTHROPIC_MODEL: null,
      ANTHROPIC_DEFAULT_OPUS_MODEL: family('opus'),
      ANTHROPIC_DEFAULT_SONNET_MODEL: family('sonnet'),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: family('haiku'),
      ANTHROPIC_CUSTOM_MODEL_OPTION: null,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: null,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
      model: models[0],
      modelPicker: { options: models.map((model) => ({ model })), replaceBuiltInOptions: true },
    } satisfies ClaudeSnapshot;
  }

  if (agent === 'codex') {
    const route = profile.routes['openai-responses']!;

    return {
      model: route.models[0],
      model_provider: 'teamai',
      providerBlock: [
        '[model_providers.teamai]',
        `name = ${JSON.stringify(profile.profile.name)}`,
        `base_url = ${JSON.stringify(route.base_url)}`,
        'wire_api = "responses"',
        envRef
          ? `env_key = ${JSON.stringify(envRef)}`
          : `experimental_bearer_token = ${JSON.stringify(profile.api_key_value ?? '')}`,
      ].join('\n'),
    } satisfies CodexSnapshot;
  }

  if (agent === 'muse') {
    const route = profile.routes['openai-responses']!;

    return {
      model: profile.model && route.models.includes(profile.model) ? profile.model : route.models[0],
      // Muse sends its bearer to a base_url other than Meta's only when
      // settings.json pins auth = bearer beside it.
      endpoint_transport: { base_url: route.base_url, auth: 'bearer' },
      keyExport: `export META_API_KEY=${envRef ? `"\${${envRef}}"` : shellQuoteValue(profile.api_key_value ?? '')}\n`,
    } satisfies MuseSnapshot;
  }

  if (agent === 'agy') {
    const route = profile.routes.gemini;

    if (!route) throw new Error(`Profile ${profile.ref} serves no Gemini route for agy`);

    return {
      modelProvider: 'gemini',
      keyExport: agyKeyFunction(envRef ? { envRef } : { value: profile.api_key_value ?? '' }, route.base_url),
    } satisfies AgySnapshot;
  }

  if (agent === 'opencode') {
    const built = new Map<string, OpenCodeProvider>();
    const providerOf = new Map<string, string>();

    // A model served over several protocols is registered once, preferring
    // Chat Completions, then Responses, then Anthropic.
    for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic'] as const) {
      const route = profile.routes[protocol];

      if (!route) continue;
      const [, id, npm] = OPENCODE_PROVIDERS.find(([candidate]) => candidate === protocol)!;

      for (const model of route.models) {
        if (providerOf.has(model)) continue;
        providerOf.set(model, id);
        const existing = built.get(id);
        built.set(id, {
          npm,
          name: `${profile.profile.name} (${protocol})`,
          options: { baseURL: route.base_url, apiKey: envRef ? `{env:${envRef}}` : profile.api_key_value ?? '' },
          models: { ...existing?.models, [model]: { name: model } },
        });
      }
    }

    const providers: JsonObject = {};

    for (const id of OPENCODE_PROVIDER_IDS) providers[id] = built.get(id) ?? null;

    // A model the profile serves only over Gemini has no OpenCode provider.
    const reachable = profile.profile.model_groups.flatMap((group) => group.models).filter((model) => providerOf.has(model));
    const defaultModel = profile.model ?? reachable[0];
    const provider = defaultModel === undefined ? undefined : providerOf.get(defaultModel);

    if (defaultModel === undefined || provider === undefined) {
      throw new Error(`Profile ${profile.ref} serves ${defaultModel ?? 'no model'} only over Gemini, which OpenCode does not speak. Choose one of: ${reachable.join(', ')}.`);
    }

    return { model: `${provider}/${defaultModel}`, providers } satisfies OpenCodeSnapshot;
  }

  if (agent === 'pi' || agent === 'omp') {
    const provider = piProvider(profile)!;

    return {
      // The provider key, read back by currentSnapshot and writePi, which have
      // the snapshot but not the profile.
      id: piProviderKey(profile),
      name: profile.profile.name,
      baseUrl: provider.baseUrl,
      // Pi expands $VAR and ${VAR} in apiKey. OMP has no inline expansion, but
      // a `!command` value is run and its output used as the key — the
      // command-backed form, which keeps a key held in the environment there.
      apiKey: envRef
        ? (agent === 'pi' ? `$${envRef}` : `!printenv ${envRef}`)
        : profile.api_key_value ?? '',
      api: provider.api,
      models: provider.models,
    } satisfies JsonObject;
  }

  const route = profile.routes['openai-chat-completions']!;

  return {
    entries: Object.fromEntries(route.models.map((model) => [model, {
      id: model,
      name: model,
      vendor: profile.profile.name,
      // CodeBuddy and WorkBuddy expand ${VAR} (not OpenCode's {env:VAR}) in apiKey.
      apiKey: envRef ? `\${${envRef}}` : profile.api_key_value ?? '',
      url: `${route.base_url}/chat/completions`,
      supportsToolCall: true,
    }])),
  } satisfies BuddySnapshot;
}

async function firstSnapshot(agent: ModelAgent, roots: AgentRoots, desired: Snapshot): Promise<Snapshot> {
  if (agent !== 'codebuddy' && agent !== 'workbuddy') return currentSnapshot(agent, roots);
  const { models } = await buddyDoc(agent);
  const snapshot: BuddySnapshot = { entries: {} };

  for (const id of Object.keys(buddySnapshotOf(agent, desired).entries)) snapshot.entries[id] = buddyEntry(models, id) ?? null;

  return snapshot;
}

// A write-ahead entry makes either side of an interrupted file replacement
// recognizable on the next command. An unrelated model edit matches neither
// side and is never overwritten automatically.
async function recoverPending(manifest: ModelSwitchManifest, agent: ModelAgent, roots: AgentRoots): Promise<boolean> {
  const state = manifest.agents[agent];
  const pending = state?.pending;

  if (!state || !pending) return true;

  if (!sameAgentSettingsPath(agent, state, roots)) return false;
  const after = await currentSnapshot(agent, roots, state.lastWritten);

  if (pending.kind === 'switch') {
    if (sameManaged(agent, after, state.lastWritten)) {
      delete state.pending;
    } else if (sameManaged(agent, await currentSnapshot(agent, roots, pending.before), pending.before)) {
      if (pending.prior) manifest.agents[agent] = pending.prior;
      else delete manifest.agents[agent];
    } else return false;
  } else if (sameManaged(agent, after, state.lastWritten)) {
    delete state.pending;
  } else if (sameManaged(agent, await currentSnapshot(agent, roots, state.previous), state.previous)) {
    delete manifest.agents[agent];
  } else return false;
  await saveManifest(manifest);

  return true;
}

async function firstSwitchCollision(agent: ModelAgent, roots: AgentRoots, profile: ResolvedModelProfile): Promise<string | undefined> {
  if (agent === 'codex') {
    const source = (await readOptionalFile(codexSettingsPath(roots))) ?? '';
    const providers = parseCodex(source).model_providers;
    const table = TomlTableSchema.safeParse(providers);

    const taken = providers !== undefined && (!table.success
      || Object.prototype.hasOwnProperty.call(table.data, 'teamai')
      // An inline `model_providers = {...}` table cannot be extended.
      || /^\s*(?:model_providers|"model_providers"|'model_providers')\s*=\s*\{/m.test(source));

    return taken ? 'codex already has a user-owned provider named teamai' : undefined;
  }

  if (agent === 'opencode') {
    const providers = openCodeProviders(await jsonObject(openCodeSettingsPath()));
    const taken = OPENCODE_PROVIDER_IDS.find((id) => providers[id] !== undefined);

    return taken ? `opencode already has a user-owned provider named ${taken}` : undefined;
  }

  if (agent === 'pi' || agent === 'omp') {
    // The provider key is the profile ref, so a member who already has a
    // provider under that ref is refused rather than silently overwritten.
    const id = piProviderKey(profile);
    const doc = await piDoc(agent);
    const providers = isJsonObject(doc.providers) ? doc.providers : {};

    return providers[id] !== undefined ? `${agent} already has a user-owned provider named ${id}` : undefined;
  }

  return undefined;
}

async function buddyCollision(agent: BuddyAgent, desired: BuddySnapshot, state: AgentState | undefined): Promise<string | undefined> {
  const managedIds = new Set(Object.keys(state ? buddySnapshotOf(agent, state.lastWritten).entries : {}));
  const { models } = await buddyDoc(agent);

  for (const id of Object.keys(desired.entries)) {
    if (managedIds.has(id)) continue;
    const existing = buddyEntry(models, id);

    if (existing !== undefined && !await localAgentOwnsBuddyEntry(agent, id, existing)) {
      return `${agent} already has a user-owned model named ${id}`;
    }
  }

  return undefined;
}

export interface SwitchOptions {
  dryRun?: boolean;
  /**
   * Only update agents still using this profile. `pull` decides which agents
   * to re-apply before taking the lock; a switch in between must win.
   */
  onlyIfActive?: ActiveModelProfile;
  /**
   * The repo the manifest is understood against. Lets `onlyIfActive` match a
   * team recorded under its legacy identity, so a `pull` can update agents
   * whose switch predates the hash-only team naming (#894).
   */
  localConfig?: LocalConfig;
}

export async function switchModelProfile(
  profile: ResolvedModelProfile,
  agents: ModelAgent[],
  options: SwitchOptions = {},
): Promise<ModelSwitchResult[]> {
  if (options.dryRun) return switchModelProfileUnlocked(profile, agents, options);

  return withManifestLock(() => switchModelProfileUnlocked(profile, agents, options));
}

async function switchModelProfileUnlocked(
  profile: ResolvedModelProfile,
  agents: ModelAgent[],
  options: SwitchOptions,
): Promise<ModelSwitchResult[]> {
  const roots = await agentRootsOf(options.localConfig, options.dryRun);
  const manifest = (await loadManifest()) ?? { version: 1, agents: {} };
  const results: ModelSwitchResult[] = [];

  const metadata: Pick<AgentState, 'profile' | 'team' | 'model'> = { profile: profile.ref };

  if (profile.team) metadata.team = profile.team;

  if (profile.model) metadata.model = profile.model;

  for (const agent of agents) {
    try {
      if (options.dryRun && manifest.agents[agent]?.pending) {
        results.push({ agent, status: 'skipped', message: `${agent} has an interrupted model update; run without --dry-run to recover it` });
        continue;
      }

      if (!options.dryRun && !await recoverPending(manifest, agent, roots)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed during an interrupted TeamAI update; leaving them untouched` });
        continue;
      }

      const expected = options.onlyIfActive;
      const active = manifest.agents[agent];

      const teamMatches = active?.team === expected?.team
        || (expected?.team !== undefined && options.localConfig !== undefined && sameTeamIdentity(active?.team, options.localConfig));

      if (expected && (active?.profile !== expected.profile || !teamMatches || active.model !== expected.model)) {
        results.push({ agent, status: 'unchanged', message: `${agent} no longer uses ${expected.profile}` });
        continue;
      }

      if (!supportedRoute(agent, profile)) {
        results.push({ agent, status: 'unsupported', message: `Profile ${profile.ref} has no protocol ${agent} can use` });
        continue;
      }

      if (!await installed(agent, roots)) {
        results.push({ agent, status: 'not-installed', message: `${agent} is not installed` });
        continue;
      }

      if (agent === 'claude') {
        const settingsEnv = claudeEnv(await jsonObject(claudeSettingsPath(roots)));
        const providerFlags = CLAUDE_PROVIDER_KEYS.filter((key) => claudeProviderFlagEnabled(settingsEnv[key]));

        if (providerFlags.length > 0) {
          results.push({ agent, status: 'skipped', message: `claude settings.json enables ${providerFlags.join(', ')}; disable it before switching` });
          continue;
        }
      }

      const state = manifest.agents[agent];

      if (state && !sameAgentSettingsPath(agent, state, roots)) {
        results.push({ agent, status: 'skipped', message: movedSettingsMessage(agent, state, roots) });
        continue;
      }

      let desired = desiredSnapshot(agent, profile);
      let warning: string | undefined;

      if (agent === 'claude') {
        const overrides = claudeShellOverrides(isJsonObject(desired) ? desired : {});

        if (overrides.length > 0) {
          warning = `This shell sets ${overrides.join(', ')}, which override settings.json for Claude sessions started from it`;
        }
      }

      if (agent === 'muse') {
        const baseUrl = isJsonObject(desired) ? stringField(desired.endpoint_transport, 'base_url') : undefined;
        warning = `Shells started before this switch lack the profile's META_API_KEY: open a new shell before running muse, or Muse Code sends your saved Meta credential to ${baseUrl}`;
      }

      if (agent === 'agy') {
        warning = "Shells started before this switch lack teamai's agy function, which hands agy the profile's key and endpoint: open a new shell before running agy, or agy refuses to start with modelProvider set";
      }

      const current = await currentSnapshot(agent, roots, state ? state.lastWritten : desired);

      if (state && !sameManaged(agent, current, state.lastWritten)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed outside TeamAI; leaving them untouched` });
        continue;
      }

      let previous = state ? structuredClone(state.previous) : await firstSnapshot(agent, roots, desired);
      let released: BuddySnapshot | undefined;

      if (agent === 'codebuddy' || agent === 'workbuddy') {
        const desiredBuddy = buddySnapshotOf(agent, desired);
        const prior = buddySnapshotOf(agent, previous);
        const { availableModels } = await buddyDoc(agent);
        const managedIds = Object.keys(desiredBuddy.entries);

        // A model the catalog dropped gets its original entry back now and
        // leaves TeamAI's records, so a later restore never touches an ID
        // TeamAI no longer writes (the user may have reused it).
        const dropped = Object.keys(state ? buddySnapshotOf(agent, state.lastWritten).entries : {})
          .filter((id) => !managedIds.includes(id));

        released = { entries: Object.fromEntries(dropped.map((id) => [id, prior.entries[id] ?? null])) };
        const priorAllowed = prior.allowed;

        if (priorAllowed) {
          released.allowed = Object.fromEntries(dropped.flatMap((id) => (id in priorAllowed ? [[id, priorAllowed[id]] as const] : [])));
        }

        prior.entries = Object.fromEntries(managedIds.map((id) => [id, prior.entries[id] ?? null]));

        if (availableModels?.length || prior.allowed) {
          const existing = buddyAllowed(availableModels, managedIds);
          prior.allowed = Object.fromEntries(managedIds.map((id) => [id, prior.allowed?.[id] ?? existing[id]]));
          desiredBuddy.allowed = Object.fromEntries(managedIds.map((id) => [id, true]));
        }

        desired = desiredBuddy;
        previous = prior;
      }

      if (agent === 'claude' && state && !profile.model) {
        // Keep the model the user picked in Claude if the catalog still has it.
        const currentModel = isJsonObject(current) ? current.model : undefined;
        const picked = claudeModelId(currentModel);

        if (picked && profile.routes.anthropic!.models.includes(picked) && isJsonObject(desired) && currentModel !== undefined) {
          desired.model = currentModel;
        }
      }

      if (equal(current, desired)) {
        if (state && !options.dryRun && (state.profile !== metadata.profile || state.team !== metadata.team || state.model !== metadata.model)) {
          manifest.agents[agent] = { ...state, profile: metadata.profile, team: metadata.team, model: metadata.model };
          await saveManifest(manifest);
        }

        results.push(withWarning({ agent, status: 'unchanged', message: `${agent} already uses ${profile.ref}` }, warning));
        continue;
      }

      const collision = agent === 'codebuddy' || agent === 'workbuddy'
        ? await buddyCollision(agent, buddySnapshotOf(agent, desired), state)
        : state ? undefined : await firstSwitchCollision(agent, roots, profile);

      if (collision) {
        results.push({ agent, status: 'skipped', message: collision });
        continue;
      }

      if (!options.dryRun) {
        manifest.agents[agent] = {
          ...metadata,
          previous,
          lastWritten: desired,
          filePath: path.resolve(agentSettingsPath(agent, roots)),
          pending: { kind: 'switch', before: state ? current : await firstSnapshot(agent, roots, desired), prior: state ?? null },
        };
        await saveManifest(manifest);

        try {
          await writeSnapshot(agent, roots, desired, state?.lastWritten, true, released);
        } catch (error) {
          // Agent files are replaced atomically, so a failed write left the
          // file as it was. Drop the ownership record written for it.
          if (state) manifest.agents[agent] = state;
          else delete manifest.agents[agent];
          await saveManifest(manifest);
          throw error;
        }

        delete manifest.agents[agent]!.pending;
        await saveManifest(manifest);
      }

      results.push(withWarning({
        agent,
        status: 'switched',
        message: options.dryRun ? `${agent} would switch to ${profile.ref}` : `${agent} switched to ${profile.ref}`,
      }, warning));
    } catch (error) {
      results.push({ agent, status: 'failed', message: `${agent} failed: ${messageOf(error)}` });
    }
  }

  return results;
}

/** `result`, with `warning` when there is one. */
function withWarning(result: ModelSwitchResult, warning: string | undefined): ModelSwitchResult {
  if (warning) result.warning = warning;

  return result;
}

export async function restoreModelProfiles(
  agents: ModelAgent[],
  options: { dryRun?: boolean } = {},
): Promise<ModelSwitchResult[]> {
  if (options.dryRun) return restoreModelProfilesUnlocked(agents, options);

  return withManifestLock(() => restoreModelProfilesUnlocked(agents, options));
}

async function restoreModelProfilesUnlocked(
  agents: ModelAgent[],
  options: { dryRun?: boolean },
): Promise<ModelSwitchResult[]> {
  const roots = await agentRootsOf(undefined, options.dryRun);
  const manifest = (await loadManifest()) ?? { version: 1 as const, agents: {} };
  const results: ModelSwitchResult[] = [];

  for (const agent of agents) {
    try {
      if (options.dryRun && manifest.agents[agent]?.pending) {
        results.push({ agent, status: 'skipped', message: `${agent} has an interrupted model update; run without --dry-run to recover it` });
        continue;
      }

      if (!options.dryRun && !await recoverPending(manifest, agent, roots)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed during an interrupted TeamAI update; leaving them untouched` });
        continue;
      }

      const state = manifest.agents[agent];

      if (!state) {
        results.push({ agent, status: 'unchanged', message: `${agent} has no TeamAI-managed model settings` });
        continue;
      }

      if (!sameAgentSettingsPath(agent, state, roots)) {
        results.push({ agent, status: 'skipped', message: movedSettingsMessage(agent, state, roots) });
        continue;
      }

      const current = await currentSnapshot(agent, roots, state.lastWritten);

      if (!sameManaged(agent, current, state.lastWritten)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed outside TeamAI; leaving them untouched` });
        continue;
      }

      let restored = state.previous;

      if (agent === 'claude') {
        // Put back the original model only if the current one is still one
        // TeamAI offered; a model the user chose elsewhere stays.
        const picker = ClaudeModelPickerSchema.safeParse(isJsonObject(state.lastWritten) ? state.lastWritten.modelPicker : null);
        const offered = (picker.data?.options ?? []).map((option) => option.model);
        const currentModel = isJsonObject(current) ? current.model : undefined;
        const picked = claudeModelId(currentModel);

        if (picked && !offered.includes(picked) && isJsonObject(state.previous) && currentModel !== undefined) {
          restored = { ...state.previous, model: currentModel };
        }
      }

      if (!options.dryRun) {
        state.pending = { kind: 'restore', before: current };
        await saveManifest(manifest);

        try {
          await writeSnapshot(agent, roots, restored, state.lastWritten);
        } catch (error) {
          delete state.pending;
          await saveManifest(manifest);
          throw error;
        }

        delete manifest.agents[agent];
        await saveManifest(manifest);
      }

      const warning = agent === 'muse'
        ? "Shells started before this restore still export the profile's META_API_KEY: open a new shell before running muse"
        : agent === 'agy'
          ? "Shells started before this restore still define teamai's agy function, which sends agy to the profile's gateway: open a new shell before running agy"
          : undefined;

      results.push(withWarning({
        agent,
        status: 'restored',
        message: options.dryRun ? `${agent} model settings would be restored` : `${agent} model settings restored`,
      }, warning));
    } catch (error) {
      results.push({ agent, status: 'failed', message: `${agent} restore failed: ${messageOf(error)}` });
    }
  }

  return results;
}

/** Which profile each agent currently uses through TeamAI. */
export async function activeModelProfiles(): Promise<Partial<Record<ModelAgent, ActiveModelProfile>>> {
  const manifest = await loadManifest();

  return Object.fromEntries(Object.entries(manifest?.agents ?? {}).map(([agent, state]) => [agent, activeProfileOf(state)]));
}

function activeProfileOf(state: AgentState): ActiveModelProfile {
  const active: ActiveModelProfile = { profile: state.profile };

  if (state.team) active.team = state.team;

  if (state.model) active.model = state.model;

  return active;
}

/** Whether a model profile switch still controls one agent, or why that cannot be told. */
export type LiveModelSwitch = { readonly ok: true; readonly switched: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Which agents a TeamAI switch still controls: the switch was recorded for
 * the agent's live settings path (`agentRootsOf` for Claude and Codex, ...) and
 * those settings still hold what TeamAI wrote, the checks `restore` makes
 * before it touches them. A record for another path, or settings the user
 * took over, does not count. Reads without the lock and never writes, so an
 * interrupted switch counts only once its write landed.
 */
export async function liveModelSwitches(localConfig: Pick<LocalConfig, 'toolRoots'>): Promise<Record<ModelAgent, LiveModelSwitch>> {
  let manifest: ModelSwitchManifest | null;

  try {
    manifest = await loadManifest();
  } catch (error) {
    const unreadable: LiveModelSwitch = { ok: false, reason: messageOf(error) };

    // SAFETY: ALL_MODEL_AGENTS is ModelAgentSchema.options, so the entries name every ModelAgent.
    return Object.fromEntries(ALL_MODEL_AGENTS.map((agent) => [agent, unreadable])) as Record<ModelAgent, LiveModelSwitch>;
  }

  const roots = await agentRootsOf(localConfig, true);

  const entries = await Promise.all(ALL_MODEL_AGENTS.map(async (agent): Promise<[ModelAgent, LiveModelSwitch]> => {
    const state = manifest?.agents[agent];

    if (!state || !sameAgentSettingsPath(agent, state, roots)) return [agent, { ok: true, switched: false }];

    try {
      return [agent, { ok: true, switched: sameManaged(agent, await currentSnapshot(agent, roots, state.lastWritten), state.lastWritten) }];
    } catch (error) {
      return [agent, { ok: false, reason: messageOf(error) }];
    }
  }));

  // SAFETY: `entries` maps ALL_MODEL_AGENTS, which is ModelAgentSchema.options, so it names every ModelAgent.
  return Object.fromEntries(entries) as Record<ModelAgent, LiveModelSwitch>;
}

/**
 * For each `team:` profile of the team `localConfig` describes, an agent is
 * switched to: the gateway origins TeamAI last wrote into those agents'
 * settings, where the API key of that profile has actually been sent. Agents
 * recorded under a legacy team identity (#894) count toward the same team.
 */
export async function switchedGatewayOrigins(localConfig: LocalConfig): Promise<Map<string, string[]>> {
  const manifest = await loadManifest();
  const byProfile = new Map<string, string[]>();

  for (const agent of ALL_MODEL_AGENTS) {
    const state = manifest?.agents[agent];

    if (!state || !state.profile.startsWith('team:') || !sameTeamIdentity(state.team, localConfig)) continue;

    const origins = writtenGatewayUrls(agent, state.lastWritten).flatMap((url) => {
      try {
        return [new URL(url).origin];
      } catch {
        return [];
      }
    });

    byProfile.set(state.profile, [...new Set([...(byProfile.get(state.profile) ?? []), ...origins])]);
  }

  return byProfile;
}

/** The string at `key` of a JSON object, when it is one. */
function stringField(value: JsonValue | undefined, key: string): string | undefined {
  return isJsonObject(value) ? z.string().safeParse(value[key]).data : undefined;
}

/** The gateway URLs in one agent's written snapshot, as `desiredSnapshot` lays them out. */
function writtenGatewayUrls(agent: ModelAgent, snapshot: Snapshot): string[] {
  if (!isJsonObject(snapshot)) return [];

  if (agent === 'claude') {
    const url = stringField(snapshot, 'ANTHROPIC_BASE_URL');

    return url === undefined ? [] : [url];
  }

  if (agent === 'codex') {
    const block = stringField(snapshot, 'providerBlock');
    const line = block === undefined ? null : /^base_url = (".*")$/m.exec(block);

    if (!line?.[1]) return [];

    try {
      const url = z.string().safeParse(JSON.parse(line[1]));

      return url.success ? [url.data] : [];
    } catch {
      return [];
    }
  }

  if (agent === 'opencode') {
    const providers = isJsonObject(snapshot.providers) ? Object.values(snapshot.providers) : [];

    return providers.flatMap((provider) => {
      const url = stringField(isJsonObject(provider) ? provider.options : undefined, 'baseURL');

      return url === undefined ? [] : [url];
    });
  }

  if (agent === 'pi' || agent === 'omp') {
    const url = stringField(snapshot, 'baseUrl');

    return url === undefined ? [] : [url];
  }

  if (agent === 'muse') {
    const url = stringField(snapshot.endpoint_transport, 'base_url');

    return url === undefined ? [] : [url];
  }

  if (agent === 'agy') {
    const keyExport = stringField(snapshot, 'keyExport');
    const url = keyExport === undefined ? undefined : agyGatewayOf(keyExport, {})?.GOOGLE_GEMINI_BASE_URL;

    return url ? [url] : [];
  }

  const entries = isJsonObject(snapshot.entries) ? Object.values(snapshot.entries) : [];

  return entries.flatMap((entry) => {
    const url = stringField(entry, 'url');

    return url === undefined ? [] : [url];
  });
}

export async function isModelProfileManaged(agent: ModelAgent): Promise<boolean> {
  return (await loadManifest())?.agents[agent] !== undefined;
}
