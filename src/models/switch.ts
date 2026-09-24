import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { getUserHome } from '../utils/home.js';
import { pathExists, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { acquireLock, releaseLock } from '../update.js';
import { entryHash } from '../resources/mcp-format.js';
import { ALL_MODEL_AGENTS, type ModelAgent, type ResolvedModelProfile } from './profile.js';

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

interface AgentState {
  profile: string;
  /** Team repository identity for `team:` profiles. */
  team?: string;
  /** Default model chosen with `--model`, kept for later re-applies. */
  model?: string;
  previous: unknown;
  lastWritten: unknown;
  filePath?: string;
  pending?: { kind: 'switch' | 'restore'; before: unknown; prior?: AgentState | null };
}

interface ModelSwitchManifest {
  version: 1;
  agents: Partial<Record<ModelAgent, AgentState>>;
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

function claudeSettingsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(getUserHome(), '.claude'), 'settings.json');
}

function codexSettingsPath(): string {
  return path.join(process.env.CODEX_HOME?.trim() || path.join(getUserHome(), '.codex'), 'config.toml');
}

function openCodeSettingsPath(): string {
  const custom = process.env.OPENCODE_CONFIG?.trim();
  if (custom) return custom;
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(getUserHome(), '.config'), 'opencode', 'opencode.json');
}

function agentSettingsPath(agent: ModelAgent): string {
  if (agent === 'claude') return claudeSettingsPath();
  if (agent === 'codex') return codexSettingsPath();
  if (agent === 'opencode') return openCodeSettingsPath();
  return path.join(getUserHome(), `.${agent}`, 'models.json');
}

function sameAgentSettingsPath(agent: ModelAgent, state: AgentState): boolean {
  return !state.filePath || path.resolve(agentSettingsPath(agent)) === path.resolve(state.filePath);
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validAgentState(state: unknown): state is AgentState {
  return isRecord(state)
    && typeof state.profile === 'string'
    && (state.team === undefined || typeof state.team === 'string')
    && (state.model === undefined || typeof state.model === 'string')
    && (state.filePath === undefined || typeof state.filePath === 'string')
    && Object.prototype.hasOwnProperty.call(state, 'previous')
    && Object.prototype.hasOwnProperty.call(state, 'lastWritten');
}

async function loadManifest(): Promise<ModelSwitchManifest | null> {
  const file = manifestPath();
  const raw = await readOptionalFile(file);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`Cannot parse model ownership manifest: ${file}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.agents)) {
    throw new Error(`Invalid model ownership manifest: ${file}`);
  }
  for (const [agent, state] of Object.entries(parsed.agents)) {
    if (!(ALL_MODEL_AGENTS as string[]).includes(agent) || !validAgentState(state)) {
      throw new Error(`Invalid model ownership entry for ${agent}: ${file}`);
    }
    const pending = state.pending;
    if (pending && (!isRecord(pending) || !['switch', 'restore'].includes(pending.kind as string)
      || !Object.prototype.hasOwnProperty.call(pending, 'before')
      || (pending.kind === 'switch' && !Object.prototype.hasOwnProperty.call(pending, 'prior'))
      || (pending.prior !== undefined && pending.prior !== null
        && (!validAgentState(pending.prior) || pending.prior.pending !== undefined)))) {
      throw new Error(`Invalid pending model ownership entry for ${agent}: ${file}`);
    }
  }
  return parsed as unknown as ModelSwitchManifest;
}

async function saveManifest(manifest: ModelSwitchManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(), manifest, { mode: 0o600 });
}

function hash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (isRecord(item)) {
      return Object.fromEntries(Object.entries(item)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return item;
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}

function equal(a: unknown, b: unknown): boolean {
  return hash(a) === hash(b);
}

/**
 * Claude's /model command writes its pick to settings.json `model`. That is
 * the user choosing among the models TeamAI offered, not taking over, so the
 * top-level model never decides ownership.
 */
function sameManaged(agent: ModelAgent, a: unknown, b: unknown): boolean {
  if (agent !== 'claude') return equal(a, b);
  const { model: _left, ...left } = a as ClaudeSnapshot;
  const { model: _right, ...right } = b as ClaudeSnapshot;
  return equal(left, right);
}

async function writableTarget(file: string): Promise<string> {
  try {
    return (await fs.promises.lstat(file)).isSymbolicLink()
      ? await fs.promises.realpath(file)
      : file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file;
    throw error;
  }
}

async function writeAgentJson(file: string, value: unknown): Promise<void> {
  await writeJsonAtomic(await writableTarget(file), value, { mode: 0o600 });
}

async function jsonObject(file: string): Promise<Record<string, unknown>> {
  const raw = await readOptionalFile(file);
  if (raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot update ${file}: the root must be a JSON object`);
  }
  return parsed;
}

async function installed(agent: ModelAgent): Promise<boolean> {
  return pathExists(path.dirname(agentSettingsPath(agent)));
}

function supportedRoute(agent: ModelAgent, profile: ResolvedModelProfile): boolean {
  if (agent === 'claude') return !!profile.routes.anthropic;
  if (agent === 'codex') return !!profile.routes['openai-responses'];
  if (agent === 'opencode') return Object.keys(profile.routes).length > 0;
  return !!profile.routes['openai-chat-completions'];
}

// ─── Claude ───────────────────────────────────────────────

type ClaudeSnapshot = Record<(typeof CLAUDE_ENV_KEYS)[number] | 'model' | 'modelPicker', unknown>;

function claudeEnv(settings: Record<string, unknown>): Record<string, unknown> {
  return isRecord(settings.env) ? settings.env : {};
}

function claudeSnapshot(settings: Record<string, unknown>): ClaudeSnapshot {
  const env = claudeEnv(settings);
  return {
    ...Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, env[key] ?? null])),
    model: settings.model ?? null,
    modelPicker: settings.modelPicker ?? null,
  } as ClaudeSnapshot;
}

async function writeClaude(snapshot: ClaudeSnapshot): Promise<void> {
  const file = claudeSettingsPath();
  const settings = await jsonObject(file);
  if (settings.env !== undefined && !isRecord(settings.env)) {
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

/** A settings.json model without Claude's `[1m]` context suffix. */
function claudeModelId(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/\[1m\]$/i, '') : undefined;
}

function claudeProviderFlagEnabled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== '0' && value !== 'false' && value !== false;
}

/**
 * Shell variables beat settings.json for Claude sessions started from that
 * shell, so any value that differs from what TeamAI writes keeps overriding
 * it there. Host apps (for example the Claude Code desktop app) set their own
 * values, so this is a warning, not a refusal.
 */
function claudeShellOverrides(desired: ClaudeSnapshot): string[] {
  return Object.keys(process.env).filter((key) => {
    const value = process.env[key];
    if (value === '') return false;
    if ((CLAUDE_PROVIDER_KEYS as readonly string[]).includes(key)) return claudeProviderFlagEnabled(value);
    return (CLAUDE_ENV_KEYS as readonly string[]).includes(key) && value !== desired[key as (typeof CLAUDE_ENV_KEYS)[number]];
  }).sort();
}

// ─── Codex ────────────────────────────────────────────────

interface CodexSnapshot {
  model?: string;
  model_provider?: string;
  providerBlock?: string;
}

const CODEX_PROVIDER_BLOCK_RE = /^\[model_providers\.teamai\]\s*$[\s\S]*?(?=^\[(?!model_providers\.teamai[.\]])|(?![\s\S]))/m;

function parseCodex(source: string): Record<string, unknown> {
  try {
    return parseToml(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot parse Codex config.toml: ${(error as Error).message}`);
  }
}

function codexSnapshot(source: string): CodexSnapshot {
  const parsed = parseCodex(source);
  for (const key of ['model', 'model_provider'] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== 'string') {
      throw new Error(`Cannot update Codex config.toml: ${key} must be a string`);
    }
  }
  return {
    model: parsed.model as string | undefined,
    model_provider: parsed.model_provider as string | undefined,
    providerBlock: source.match(CODEX_PROVIDER_BLOCK_RE)?.[0].replace(/\n+$/, ''),
  };
}

function setTopLevelString(source: string, key: string, value: string | undefined): string {
  const re = new RegExp(`^([ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[ \\t]*)(.*)$`, 'm');
  const firstTable = source.search(/^\s*\[/m);
  const top = firstTable < 0 ? source : source.slice(0, firstTable);
  const tables = firstTable < 0 ? '' : source.slice(firstTable);
  if (re.test(top)) {
    const updated = top.replace(re, (line, prefix: string, oldValue: string) => {
      if (value === undefined) return '';
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
    return source.replace(CODEX_PROVIDER_BLOCK_RE, block ? `${block}\n\n` : '');
  }
  if (!block) return source;
  return `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${block}\n`;
}

async function writeCodex(snapshot: CodexSnapshot): Promise<void> {
  const file = codexSettingsPath();
  let source = (await readOptionalFile(file)) ?? '';
  source = setTopLevelString(source, 'model', snapshot.model);
  source = setTopLevelString(source, 'model_provider', snapshot.model_provider);
  source = setCodexProviderBlock(source, snapshot.providerBlock);
  // The edits above are line-based. Parse the result so an unusual layout
  // (multiline strings, inline tables) can never produce a broken config or
  // one that differs from the intended settings.
  const unsafe = new Error(`Cannot safely update ${file}; set model, model_provider, and [model_providers.teamai] manually`);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(source) as Record<string, unknown>;
  } catch {
    throw unsafe;
  }
  const wantedProvider = snapshot.providerBlock
    ? (parseToml(snapshot.providerBlock) as { model_providers?: Record<string, unknown> }).model_providers?.teamai
    : undefined;
  const providers = isRecord(parsed.model_providers) ? parsed.model_providers : {};
  if (parsed.model !== snapshot.model || parsed.model_provider !== snapshot.model_provider || !equal(providers.teamai, wantedProvider)) {
    throw unsafe;
  }
  await writeFileAtomic(await writableTarget(file), source, { mode: 0o600 });
}

// ─── OpenCode ─────────────────────────────────────────────

const OPENCODE_PROVIDERS = [
  ['anthropic', 'teamai-anthropic', '@ai-sdk/anthropic'],
  ['openai-chat-completions', 'teamai-chat', '@ai-sdk/openai-compatible'],
  ['openai-responses', 'teamai-responses', '@ai-sdk/openai'],
] as const;
const OPENCODE_PROVIDER_IDS: string[] = OPENCODE_PROVIDERS.map(([, id]) => id);

interface OpenCodeSnapshot {
  model: unknown;
  providers: Record<string, unknown>;
}

function openCodeProviders(doc: Record<string, unknown>): Record<string, unknown> {
  return isRecord(doc.provider) ? doc.provider : {};
}

function openCodeSnapshot(doc: Record<string, unknown>): OpenCodeSnapshot {
  const providers = openCodeProviders(doc);
  return {
    model: doc.model ?? null,
    providers: Object.fromEntries(OPENCODE_PROVIDER_IDS.map((id) => [id, providers[id] ?? null])),
  };
}

async function writeOpenCode(snapshot: OpenCodeSnapshot): Promise<void> {
  const file = openCodeSettingsPath();
  const doc = await jsonObject(file);
  if (doc.provider !== undefined && !isRecord(doc.provider)) {
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

interface BuddySnapshot {
  entries: Record<string, unknown | null>;
  allowed?: Record<string, boolean>;
}

async function buddyDoc(agent: BuddyAgent): Promise<{
  file: string;
  doc: Record<string, unknown> | unknown[];
  models: unknown[];
  availableModels?: string[];
}> {
  const file = agentSettingsPath(agent);
  const raw = await readOptionalFile(file);
  if (raw === null || raw.trim() === '') return { file, doc: {}, models: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`Cannot parse ${file}: ${(error as Error).message}`);
  }
  if (Array.isArray(parsed)) return { file, doc: parsed, models: parsed };
  if (!isRecord(parsed)) throw new Error(`Cannot update ${file}: root must be an object or array`);
  if (parsed.availableModels !== undefined && (!Array.isArray(parsed.availableModels) || !parsed.availableModels.every((id) => typeof id === 'string'))) {
    throw new Error(`Cannot update ${file}: availableModels must be an array of model IDs`);
  }
  const availableModels = parsed.availableModels as string[] | undefined;
  if (parsed.models === undefined) return { file, doc: parsed, models: [], availableModels };
  if (!Array.isArray(parsed.models)) throw new Error(`Cannot update ${file}: models must be an array`);
  return { file, doc: parsed, models: parsed.models, availableModels };
}

function buddyEntry(models: unknown[], id: string): unknown {
  return models.find((entry) => isRecord(entry) && entry.id === id);
}

function buddyAllowed(availableModels: string[] | undefined, ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, availableModels?.includes(id) ?? false]));
}

function reconcileBuddyAllowed(availableModels: string[] | undefined, allowed: Record<string, boolean> | undefined): string[] | undefined {
  if (!availableModels || !allowed) return availableModels;
  const next = availableModels.filter((id) => allowed[id] !== false);
  for (const [id, enabled] of Object.entries(allowed)) {
    if (enabled && !next.includes(id)) next.push(id);
  }
  return next;
}

async function localAgentOwnsBuddyEntry(agent: BuddyAgent, id: string, entry: unknown): Promise<boolean> {
  const manifest = await jsonObject(path.join(getUserHome(), '.teamai', 'local-agent', 'model-manifest.json'));
  const owned = manifest[agent];
  return isRecord(owned) && owned[id] === entryHash(entry);
}

// Buddy apps add their own metadata to entries. Only the fields TeamAI wrote
// decide ownership.
function buddyOwnedEntry(entry: unknown, written: unknown): unknown {
  if (entry === undefined) return null;
  if (!isRecord(entry) || !isRecord(written)) return entry;
  return Object.fromEntries(Object.keys(written).map((key) => [key, entry[key]]));
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
  const next = models.filter((entry) => !(isRecord(entry) && typeof entry.id === 'string' && managedIds.has(entry.id)));
  for (const [id, entry] of Object.entries(desired.entries)) {
    if (entry === null) continue;
    const current = buddyEntry(models, id);
    const prior = previousEntries[id];
    if (keepAppMetadata && isRecord(current) && isRecord(prior) && isRecord(entry)) {
      const extras = Object.fromEntries(Object.entries(current).filter(([key]) => !(key in prior)));
      next.push({ ...extras, ...entry });
    } else next.push(entry);
  }
  next.push(...Object.values(released?.entries ?? {}).filter((entry) => entry !== null));
  const allowed = desired.allowed || released?.allowed ? { ...released?.allowed, ...desired.allowed } : undefined;
  if (Array.isArray(doc)) await writeAgentJson(file, next);
  else await writeAgentJson(file, { ...doc, models: next, ...(allowed ? { availableModels: reconcileBuddyAllowed(availableModels, allowed) } : {}) });
}

// ─── Snapshots ────────────────────────────────────────────

/**
 * Read the fields TeamAI manages for an agent. Buddy snapshots cover the
 * model IDs in `reference` (the last written or the desired snapshot).
 */
async function currentSnapshot(agent: ModelAgent, reference?: unknown): Promise<unknown> {
  if (agent === 'claude') return claudeSnapshot(await jsonObject(claudeSettingsPath()));
  if (agent === 'codex') return codexSnapshot((await readOptionalFile(codexSettingsPath())) ?? '');
  if (agent === 'opencode') return openCodeSnapshot(await jsonObject(openCodeSettingsPath()));
  const written = reference as BuddySnapshot | undefined;
  const { models, availableModels } = await buddyDoc(agent);
  const entries = written?.entries ?? {};
  return {
    entries: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, buddyOwnedEntry(buddyEntry(models, id), entry)])),
    ...(written?.allowed ? { allowed: buddyAllowed(availableModels, Object.keys(written.allowed)) } : {}),
  } satisfies BuddySnapshot;
}

async function writeSnapshot(
  agent: ModelAgent,
  snapshot: unknown,
  previousManaged?: unknown,
  keepAppMetadata = false,
  released?: BuddySnapshot,
): Promise<void> {
  if (agent === 'claude') return writeClaude(snapshot as ClaudeSnapshot);
  if (agent === 'codex') return writeCodex(snapshot as CodexSnapshot);
  if (agent === 'opencode') return writeOpenCode(snapshot as OpenCodeSnapshot);
  return replaceBuddy(agent, previousManaged as BuddySnapshot | undefined, snapshot as BuddySnapshot, keepAppMetadata, released);
}

function desiredSnapshot(agent: ModelAgent, profile: ResolvedModelProfile): unknown {
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
  if (agent === 'opencode') {
    const providers: Record<string, unknown> = Object.fromEntries(OPENCODE_PROVIDER_IDS.map((id) => [id, null]));
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
        const existing = providers[id] as { models: Record<string, unknown> } | null;
        providers[id] = {
          npm,
          name: `${profile.profile.name} (${protocol})`,
          options: { baseURL: route.base_url, apiKey: envRef ? `{env:${envRef}}` : profile.api_key_value ?? '' },
          models: { ...existing?.models, [model]: { name: model } },
        };
      }
    }
    const catalog = profile.profile.model_groups.flatMap((group) => group.models);
    const defaultModel = profile.model ?? catalog[0];
    return { model: `${providerOf.get(defaultModel)}/${defaultModel}`, providers } satisfies OpenCodeSnapshot;
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

async function firstSnapshot(agent: ModelAgent, desired: unknown): Promise<unknown> {
  if (agent !== 'codebuddy' && agent !== 'workbuddy') return currentSnapshot(agent);
  const { models } = await buddyDoc(agent);
  const ids = Object.keys((desired as BuddySnapshot).entries);
  return { entries: Object.fromEntries(ids.map((id) => [id, buddyEntry(models, id) ?? null])) } satisfies BuddySnapshot;
}

// A write-ahead entry makes either side of an interrupted file replacement
// recognizable on the next command. An unrelated model edit matches neither
// side and is never overwritten automatically.
async function recoverPending(manifest: ModelSwitchManifest, agent: ModelAgent): Promise<boolean> {
  const state = manifest.agents[agent];
  const pending = state?.pending;
  if (!state || !pending) return true;
  if (!sameAgentSettingsPath(agent, state)) return false;
  const after = await currentSnapshot(agent, state.lastWritten);
  if (pending.kind === 'switch') {
    if (sameManaged(agent, after, state.lastWritten)) {
      delete state.pending;
    } else if (sameManaged(agent, await currentSnapshot(agent, pending.before), pending.before)) {
      if (pending.prior) manifest.agents[agent] = pending.prior;
      else delete manifest.agents[agent];
    } else return false;
  } else if (sameManaged(agent, after, state.lastWritten)) {
    delete state.pending;
  } else if (sameManaged(agent, await currentSnapshot(agent, state.previous), state.previous)) {
    delete manifest.agents[agent];
  } else return false;
  await saveManifest(manifest);
  return true;
}

async function firstSwitchCollision(agent: ModelAgent): Promise<string | undefined> {
  if (agent === 'codex') {
    const source = (await readOptionalFile(codexSettingsPath())) ?? '';
    const providers = parseCodex(source).model_providers;
    const taken = providers !== undefined && (!isRecord(providers)
      || Object.prototype.hasOwnProperty.call(providers, 'teamai')
      // An inline `model_providers = {...}` table cannot be extended.
      || /^\s*(?:model_providers|"model_providers"|'model_providers')\s*=\s*\{/m.test(source));
    return taken ? 'codex already has a user-owned provider named teamai' : undefined;
  }
  if (agent === 'opencode') {
    const providers = openCodeProviders(await jsonObject(openCodeSettingsPath()));
    const taken = OPENCODE_PROVIDER_IDS.find((id) => providers[id] !== undefined);
    return taken ? `opencode already has a user-owned provider named ${taken}` : undefined;
  }
  return undefined;
}

async function buddyCollision(agent: BuddyAgent, desired: BuddySnapshot, state: AgentState | undefined): Promise<string | undefined> {
  const managedIds = new Set(Object.keys((state?.lastWritten as BuddySnapshot | undefined)?.entries ?? {}));
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
  const manifest = (await loadManifest()) ?? { version: 1, agents: {} };
  const results: ModelSwitchResult[] = [];
  const metadata: Pick<AgentState, 'profile' | 'team' | 'model'> = {
    profile: profile.ref,
    ...(profile.team ? { team: profile.team } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  };

  for (const agent of agents) {
    try {
      if (options.dryRun && manifest.agents[agent]?.pending) {
        results.push({ agent, status: 'skipped', message: `${agent} has an interrupted model update; run without --dry-run to recover it` });
        continue;
      }
      if (!options.dryRun && !await recoverPending(manifest, agent)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed during an interrupted TeamAI update; leaving them untouched` });
        continue;
      }
      const expected = options.onlyIfActive;
      const active = manifest.agents[agent];
      if (expected && (active?.profile !== expected.profile || active.team !== expected.team || active.model !== expected.model)) {
        results.push({ agent, status: 'unchanged', message: `${agent} no longer uses ${expected.profile}` });
        continue;
      }
      if (!supportedRoute(agent, profile)) {
        results.push({ agent, status: 'unsupported', message: `Profile ${profile.ref} has no protocol ${agent} can use` });
        continue;
      }
      if (!await installed(agent)) {
        results.push({ agent, status: 'not-installed', message: `${agent} is not installed` });
        continue;
      }
      if (agent === 'claude') {
        const settingsEnv = claudeEnv(await jsonObject(claudeSettingsPath()));
        const providerFlags = CLAUDE_PROVIDER_KEYS.filter((key) => claudeProviderFlagEnabled(settingsEnv[key]));
        if (providerFlags.length > 0) {
          results.push({ agent, status: 'skipped', message: `claude settings.json enables ${providerFlags.join(', ')}; disable it before switching` });
          continue;
        }
      }
      const state = manifest.agents[agent];
      if (state && !sameAgentSettingsPath(agent, state)) {
        results.push({ agent, status: 'skipped', message: `${agent} configuration path changed since TeamAI switched it; leaving it untouched` });
        continue;
      }
      const desired = desiredSnapshot(agent, profile);
      let warning: string | undefined;
      if (agent === 'claude') {
        const overrides = claudeShellOverrides(desired as ClaudeSnapshot);
        if (overrides.length > 0) {
          warning = `This shell sets ${overrides.join(', ')}, which override settings.json for Claude sessions started from it`;
        }
      }
      const current = await currentSnapshot(agent, state ? state.lastWritten : desired);
      if (state && !sameManaged(agent, current, state.lastWritten)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed outside TeamAI; leaving them untouched` });
        continue;
      }
      const previous = state ? structuredClone(state.previous) : await firstSnapshot(agent, desired);
      let released: BuddySnapshot | undefined;
      if (agent === 'codebuddy' || agent === 'workbuddy') {
        const desiredBuddy = desired as BuddySnapshot;
        const prior = previous as BuddySnapshot;
        const { availableModels } = await buddyDoc(agent);
        const managedIds = Object.keys(desiredBuddy.entries);
        // A model the catalog dropped gets its original entry back now and
        // leaves TeamAI's records, so a later restore never touches an ID
        // TeamAI no longer writes (the user may have reused it).
        const dropped = Object.keys((state?.lastWritten as BuddySnapshot | undefined)?.entries ?? {})
          .filter((id) => !managedIds.includes(id));
        released = {
          entries: Object.fromEntries(dropped.map((id) => [id, prior.entries[id] ?? null])),
          ...(prior.allowed ? { allowed: Object.fromEntries(dropped.filter((id) => id in prior.allowed!).map((id) => [id, prior.allowed![id]])) } : {}),
        };
        prior.entries = Object.fromEntries(managedIds.map((id) => [id, prior.entries[id] ?? null]));
        if (availableModels?.length || prior.allowed) {
          const existing = buddyAllowed(availableModels, managedIds);
          prior.allowed = Object.fromEntries(managedIds.map((id) => [id, prior.allowed?.[id] ?? existing[id]]));
          desiredBuddy.allowed = Object.fromEntries(managedIds.map((id) => [id, true]));
        }
      }
      if (agent === 'claude' && state && !profile.model) {
        // Keep the model the user picked in Claude if the catalog still has it.
        const picked = claudeModelId((current as ClaudeSnapshot).model);
        if (picked && profile.routes.anthropic!.models.includes(picked)) {
          (desired as ClaudeSnapshot).model = (current as ClaudeSnapshot).model;
        }
      }
      if (equal(current, desired)) {
        if (state && !options.dryRun && (state.profile !== metadata.profile || state.team !== metadata.team || state.model !== metadata.model)) {
          manifest.agents[agent] = { ...state, profile: metadata.profile, team: metadata.team, model: metadata.model };
          await saveManifest(manifest);
        }
        results.push({ agent, status: 'unchanged', message: `${agent} already uses ${profile.ref}`, ...(warning ? { warning } : {}) });
        continue;
      }

      const collision = agent === 'codebuddy' || agent === 'workbuddy'
        ? await buddyCollision(agent, desired as BuddySnapshot, state)
        : state ? undefined : await firstSwitchCollision(agent);
      if (collision) {
        results.push({ agent, status: 'skipped', message: collision });
        continue;
      }

      if (!options.dryRun) {
        manifest.agents[agent] = {
          ...metadata,
          previous,
          lastWritten: desired,
          filePath: path.resolve(agentSettingsPath(agent)),
          pending: { kind: 'switch', before: state ? current : await firstSnapshot(agent, desired), prior: state ?? null },
        };
        await saveManifest(manifest);
        try {
          await writeSnapshot(agent, desired, state?.lastWritten, true, released);
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
      results.push({
        agent,
        status: 'switched',
        message: options.dryRun ? `${agent} would switch to ${profile.ref}` : `${agent} switched to ${profile.ref}`,
        ...(warning ? { warning } : {}),
      });
    } catch (error) {
      results.push({ agent, status: 'failed', message: `${agent} failed: ${(error as Error).message}` });
    }
  }

  return results;
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
  const manifest = (await loadManifest()) ?? { version: 1 as const, agents: {} };
  const results: ModelSwitchResult[] = [];
  for (const agent of agents) {
    try {
      if (options.dryRun && manifest.agents[agent]?.pending) {
        results.push({ agent, status: 'skipped', message: `${agent} has an interrupted model update; run without --dry-run to recover it` });
        continue;
      }
      if (!options.dryRun && !await recoverPending(manifest, agent)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed during an interrupted TeamAI update; leaving them untouched` });
        continue;
      }
      const state = manifest.agents[agent];
      if (!state) {
        results.push({ agent, status: 'unchanged', message: `${agent} has no TeamAI-managed model settings` });
        continue;
      }
      if (!sameAgentSettingsPath(agent, state)) {
        results.push({ agent, status: 'skipped', message: `${agent} configuration path changed since TeamAI switched it; leaving it untouched` });
        continue;
      }
      const current = await currentSnapshot(agent, state.lastWritten);
      if (!sameManaged(agent, current, state.lastWritten)) {
        results.push({ agent, status: 'skipped', message: `${agent} model settings changed outside TeamAI; leaving them untouched` });
        continue;
      }
      let restored = state.previous;
      if (agent === 'claude') {
        // Put back the original model only if the current one is still one
        // TeamAI offered; a model the user chose elsewhere stays.
        const offered = (((state.lastWritten as ClaudeSnapshot).modelPicker as { options?: Array<{ model?: unknown }> } | null)?.options ?? [])
          .map((option) => option.model);
        const picked = claudeModelId((current as ClaudeSnapshot).model);
        if (picked && !offered.includes(picked)) restored = { ...(state.previous as ClaudeSnapshot), model: (current as ClaudeSnapshot).model };
      }
      if (!options.dryRun) {
        state.pending = { kind: 'restore', before: current };
        await saveManifest(manifest);
        try {
          await writeSnapshot(agent, restored, state.lastWritten);
        } catch (error) {
          delete state.pending;
          await saveManifest(manifest);
          throw error;
        }
        delete manifest.agents[agent];
        await saveManifest(manifest);
      }
      results.push({
        agent,
        status: 'restored',
        message: options.dryRun ? `${agent} model settings would be restored` : `${agent} model settings restored`,
      });
    } catch (error) {
      results.push({ agent, status: 'failed', message: `${agent} restore failed: ${(error as Error).message}` });
    }
  }
  return results;
}

/** Which profile each agent currently uses through TeamAI. */
export async function activeModelProfiles(): Promise<Partial<Record<ModelAgent, ActiveModelProfile>>> {
  const manifest = await loadManifest();
  return Object.fromEntries(Object.entries(manifest?.agents ?? {}).map(([agent, state]) => [
    agent,
    { profile: state.profile, ...(state.team ? { team: state.team } : {}), ...(state.model ? { model: state.model } : {}) },
  ]));
}

export async function isModelProfileManaged(agent: ModelAgent): Promise<boolean> {
  return (await loadManifest())?.agents[agent] !== undefined;
}
