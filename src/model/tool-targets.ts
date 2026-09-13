import path from 'node:path';
import type { ModelProvider, EndpointName, ProviderModel } from './providers.js';
import type { ConfigFormat } from './config-file.js';
import { deepMerge, isPlainObject, upsertBy, upsertById } from './merge.js';

/** View model handed to a tool's render function. */
export interface RenderContext {
  provider: ModelProvider;
  endpoint: EndpointName;
  baseUrl: string;
  /** Environment variable name the provider's key comes from. */
  apiKeyEnv: string;
  /** Resolved API-key value. */
  apiKey: string;
  /** Unique models in tier order. */
  modelList: ProviderModel[];
  defaultModelId: string;
}

export type MergeFn = (existing: unknown, fragment: unknown) => unknown;

export interface ToolTarget {
  name: string;
  format: ConfigFormat;
  /** Endpoint used when the tool supports both and the user gives no override. */
  preferredEndpoint: EndpointName;
  /** Endpoint the tool's format mandates, ignoring any override. */
  forceEndpoint?: EndpointName;
  configPath(home: string): string;
  render(ctx: RenderContext): unknown;
  /** Merge a rendered fragment into the existing document; defaults to `deepMerge`. */
  merge?: MergeFn;
}

/**
 * Render a token count as a Claude Code context suffix: `m` = million, `k` = thousand
 * (1000000 → `[1m]`, 128000 → `[128k]`); non-round values fall back to the raw count.
 */
export function contextSuffix(tokens?: number): string {
  if (tokens === undefined || !Number.isInteger(tokens) || tokens <= 0) return '';
  if (tokens % 1_000_000 === 0) return `[${tokens / 1_000_000}m]`;
  if (tokens % 1_000 === 0) return `[${tokens / 1_000}k]`;
  return `[${tokens}]`;
}

/** CodeBuddy / WorkBuddy default `maxOutputTokens`. */
const BUDDY_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Expand a leading `~` in a path/env value; other values pass through. */
function expandTilde(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/** Resolve a config-dir env override, expanding a leading `~`; falls back when unset. */
function resolveDir(envValue: string | undefined, fallback: string, home: string): string {
  if (!envValue) return fallback;
  return expandTilde(envValue, home);
}

function renderClaude(ctx: RenderContext): unknown {
  const { models } = ctx.provider;
  return {
    env: {
      ANTHROPIC_BASE_URL: ctx.baseUrl,
      ANTHROPIC_AUTH_TOKEN: ctx.apiKey,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: models.fast.id + contextSuffix(models.fast.contextWindow),
      ANTHROPIC_DEFAULT_SONNET_MODEL: models.default.id + contextSuffix(models.default.contextWindow),
      ANTHROPIC_DEFAULT_OPUS_MODEL: models.powerful.id + contextSuffix(models.powerful.contextWindow),
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
    },
  };
}

function renderCodex(ctx: RenderContext): unknown {
  const id = ctx.provider.provider;
  const contextWindow = ctx.provider.models.default.contextWindow;
  return {
    model: ctx.defaultModelId,
    model_provider: id,
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
    model_providers: {
      [id]: {
        name: ctx.provider.name,
        base_url: ctx.baseUrl,
        env_key: ctx.apiKeyEnv,
        wire_api: 'responses',
      },
    },
  };
}

function renderOpencode(ctx: RenderContext): unknown {
  const id = ctx.provider.provider;
  const models: Record<string, unknown> = {};
  for (const model of ctx.modelList) {
    models[model.id] = {
      name: model.id,
      ...(model.contextWindow === undefined ? {} : { limit: { context: model.contextWindow } }),
    };
  }
  return {
    provider: {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: ctx.provider.name,
        options: { baseURL: ctx.baseUrl, apiKey: ctx.apiKey },
        models,
      },
    },
    model: `${id}/${ctx.defaultModelId}`,
  };
}

function renderDsh(ctx: RenderContext): unknown {
  const id = ctx.provider.provider;
  return {
    'llm-pi-ai': {
      providers: {
        [id]: {
          apiKeyEnv: ctx.apiKeyEnv,
          api: 'openai-completions',
          baseURL: ctx.baseUrl,
          models: ctx.modelList.map((model) => ({
            id: model.id,
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          })),
        },
      },
    },
    'agent-default-model': { provider: id, model: ctx.defaultModelId },
  };
}

function renderBuddy(ctx: RenderContext): unknown {
  const baseUrl = trimTrailingSlash(ctx.baseUrl);
  return {
    models: ctx.modelList.map((model) => ({
      id: model.id,
      name: model.id,
      vendor: ctx.provider.name,
      apiKey: ctx.apiKey,
      ...(model.contextWindow === undefined ? {} : { maxInputTokens: model.contextWindow }),
      maxOutputTokens: BUDDY_DEFAULT_MAX_OUTPUT_TOKENS,
      url: `${baseUrl}/chat/completions`,
      supportsToolCall: true,
    })),
  };
}

/**
 * CodeBuddy / WorkBuddy accept either the current object wrapper
 * (`{ models: [...] }`) or the legacy top-level array. Upsert models by id and
 * preserve the existing root shape; leave `availableModels` untouched (an
 * empty/absent list means "show every model").
 */
function mergeBuddyModels(existing: unknown, fragment: unknown): unknown {
  const incoming = isPlainObject(fragment) && Array.isArray(fragment.models)
    ? (fragment.models as Array<Record<string, unknown> & { id: string }>)
    : [];
  if (Array.isArray(existing)) {
    return upsertById(existing as Array<Record<string, unknown> & { id: string }>, incoming);
  }
  const doc = isPlainObject(existing) ? { ...existing } : {};
  const current = Array.isArray(doc.models)
    ? (doc.models as Array<Record<string, unknown> & { id: string }>)
    : [];
  doc.models = upsertById(current, incoming);
  return doc;
}

function renderOpenclaw(ctx: RenderContext): unknown {
  const id = ctx.provider.provider;
  return {
    models: {
      providers: {
        [id]: {
          baseUrl: ctx.baseUrl,
          apiKey: ctx.apiKey,
          api: ctx.endpoint === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
          models: ctx.modelList.map((model) => ({
            id: model.id,
            name: model.id,
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          })),
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: `${id}/${ctx.defaultModelId}` },
      },
    },
  };
}

function renderHermes(ctx: RenderContext): unknown {
  const contextWindow = ctx.provider.models.default.contextWindow;
  return {
    model: {
      provider: 'custom',
      default: ctx.defaultModelId,
      base_url: ctx.baseUrl,
      api_key: ctx.apiKey,
      ...(contextWindow === undefined ? {} : { context_length: contextWindow }),
    },
  };
}

function renderQoder(ctx: RenderContext): unknown {
  const format = ctx.endpoint === 'anthropic' ? 'anthropic' : 'openai';
  return {
    modelConfigs: {
      customModels: ctx.modelList.map((model) => ({
        provider: ctx.provider.provider,
        apiKey: ctx.apiKey,
        model: model.id,
        baseURL: ctx.baseUrl,
        key: model.id,
        displayName: model.id,
        format,
        ...(model.contextWindow === undefined ? {} : { maxInputTokens: model.contextWindow }),
      })),
    },
    model: { name: ctx.defaultModelId },
  };
}

function renderZcode(ctx: RenderContext): unknown {
  const id = ctx.provider.provider;
  const models: Record<string, unknown> = {};
  for (const model of ctx.modelList) {
    models[model.id] = {
      name: model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    };
  }
  return {
    model: { main: `${id}/${ctx.defaultModelId}`, lite: `${id}/${ctx.defaultModelId}` },
    provider: {
      [id]: {
        name: ctx.provider.name,
        kind: ctx.endpoint === 'anthropic' ? 'anthropic' : 'openai-compatible',
        options: { baseURL: ctx.baseUrl, apiKey: ctx.apiKey, apiKeyRequired: true },
        models,
        enabled: true,
      },
    },
  };
}

/**
 * Qoder's `modelConfigs.customModels` entries are keyed by `key` (not `id`), so
 * upsert them by key instead of the generic append; `model` and any other keys
 * merge shallowly.
 */
function mergeQoderModels(existing: unknown, fragment: unknown): unknown {
  const doc = isPlainObject(existing) ? { ...existing } : {};
  const frag = isPlainObject(fragment) ? fragment : {};

  const mergedModel = {
    ...(isPlainObject(doc.model) ? doc.model : {}),
    ...(isPlainObject(frag.model) ? frag.model : {}),
  };

  const docConfigs = isPlainObject(doc.modelConfigs) ? doc.modelConfigs : {};
  const fragConfigs = isPlainObject(frag.modelConfigs) ? frag.modelConfigs : {};
  const current = Array.isArray(docConfigs.customModels)
    ? (docConfigs.customModels as Array<Record<string, unknown>>)
    : [];
  const incoming = Array.isArray(fragConfigs.customModels)
    ? (fragConfigs.customModels as Array<Record<string, unknown>>)
    : [];
  const customModels = upsertBy(current, incoming, (item) => (
    typeof item.key === 'string' ? item.key : undefined
  ));

  return {
    ...doc,
    model: mergedModel,
    modelConfigs: { ...docConfigs, ...fragConfigs, customModels },
  };
}

const define = (target: ToolTarget): [string, ToolTarget] => [target.name, target];

/** Supported tool registry (Phase 1). */
export const TOOL_TARGETS = new Map<string, ToolTarget>([
  define({
    name: 'claude',
    format: 'json',
    preferredEndpoint: 'anthropic',
    forceEndpoint: 'anthropic',
    configPath: (home) =>
      path.join(resolveDir(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), home), 'settings.json'),
    render: renderClaude,
  }),
  define({
    name: 'codex',
    format: 'toml',
    preferredEndpoint: 'openai',
    configPath: (home) =>
      path.join(resolveDir(process.env.CODEX_HOME, path.join(home, '.codex'), home), 'config.toml'),
    render: renderCodex,
  }),
  define({
    name: 'opencode',
    format: 'json',
    preferredEndpoint: 'openai',
    configPath: (home) =>
      path.join(resolveDir(process.env.XDG_CONFIG_HOME, path.join(home, '.config'), home), 'opencode', 'opencode.json'),
    render: renderOpencode,
  }),
  define({
    name: 'dsh',
    format: 'yaml',
    preferredEndpoint: 'openai',
    configPath: (home) =>
      path.join(resolveDir(process.env.DSH_HOME, path.join(home, '.dsh'), home), 'settings.yaml'),
    render: renderDsh,
  }),
  define({
    name: 'codebuddy',
    format: 'json',
    preferredEndpoint: 'openai',
    forceEndpoint: 'openai',
    configPath: (home) => path.join(home, '.codebuddy', 'models.json'),
    render: renderBuddy,
    merge: mergeBuddyModels,
  }),
  define({
    name: 'workbuddy',
    format: 'json',
    preferredEndpoint: 'openai',
    forceEndpoint: 'openai',
    configPath: (home) => path.join(home, '.workbuddy', 'models.json'),
    render: renderBuddy,
    merge: mergeBuddyModels,
  }),
  define({
    name: 'openclaw',
    format: 'json5',
    preferredEndpoint: 'openai',
    // OPENCLAW_CONFIG_PATH points straight at the file; OPENCLAW_STATE_DIR at the
    // state directory that holds openclaw.json. Both fall back to ~/.openclaw.
    configPath: (home) => {
      const direct = process.env.OPENCLAW_CONFIG_PATH;
      if (direct) return expandTilde(direct, home);
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (stateDir) return path.join(expandTilde(stateDir, home), 'openclaw.json');
      return path.join(home, '.openclaw', 'openclaw.json');
    },
    render: renderOpenclaw,
  }),
  define({
    name: 'hermes',
    format: 'yaml',
    preferredEndpoint: 'openai',
    // Hermes custom endpoints are OpenAI-compatible; keep it on the openai endpoint.
    forceEndpoint: 'openai',
    configPath: (home) =>
      path.join(resolveDir(process.env.HERMES_HOME, path.join(home, '.hermes'), home), 'config.yaml'),
    render: renderHermes,
  }),
  define({
    name: 'qoder',
    format: 'json5',
    preferredEndpoint: 'openai',
    configPath: (home) =>
      path.join(resolveDir(process.env.QODER_CONFIG_DIR, path.join(home, '.qoder'), home), 'settings.json'),
    render: renderQoder,
    merge: mergeQoderModels,
  }),
  define({
    name: 'zcode',
    format: 'json',
    preferredEndpoint: 'openai',
    configPath: (home) => path.join(home, '.zcode', 'cli', 'config.json'),
    render: renderZcode,
  }),
]);

/** Tools that exist but cannot accept a custom provider/model config. */
const UNSUPPORTED_TOOLS: Record<string, string> = {
  cursor:
    'Cursor CLI does not support custom model providers (BYOK); it authenticates only through a Cursor account',
};

export function supportedToolNames(): string[] {
  return [...TOOL_TARGETS.keys()];
}

export function unsupportedTools(): Array<{ name: string; reason: string }> {
  return Object.entries(UNSUPPORTED_TOOLS).map(([name, reason]) => ({ name, reason }));
}

export function getToolTarget(name: string): ToolTarget {
  const target = TOOL_TARGETS.get(name);
  if (target) return target;
  if (UNSUPPORTED_TOOLS[name]) {
    throw new Error(`Tool "${name}" is not supported: ${UNSUPPORTED_TOOLS[name]}`);
  }
  throw new Error(`Unknown tool "${name}" (available: ${supportedToolNames().join(', ')})`);
}
