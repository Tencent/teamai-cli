import { z } from 'zod';

/**
 * Provider-agnostic model catalog.
 *
 * A provider declares its two API endpoints (Anthropic- and OpenAI-compatible),
 * a `${ENV_VAR}` API-key placeholder, and three model tiers. `teamai model inject`
 * renders this catalog into each AI tool's native model config.
 */

const ModelEntrySchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
});

const ProviderSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  /** `${ENV_VAR}` placeholder (or a literal key, though the built-ins are all placeholders). */
  apiKey: z.string().min(1),
  /** Endpoint used when a tool supports both; defaults to `openai`. */
  defaultEndpoint: z.enum(['anthropic', 'openai']).optional(),
  endpoints: z.object({
    anthropic: z.object({ baseUrl: z.string().min(1) }),
    openai: z.object({ baseUrl: z.string().min(1) }),
  }),
  models: z.object({
    fast: ModelEntrySchema,
    default: ModelEntrySchema,
    powerful: ModelEntrySchema,
  }),
});

export type ModelProvider = z.infer<typeof ProviderSchema>;
export type ModelTier = 'fast' | 'default' | 'powerful';
export type EndpointName = 'anthropic' | 'openai';

const TIERS: ModelTier[] = ['fast', 'default', 'powerful'];
const ENDPOINTS: EndpointName[] = ['anthropic', 'openai'];

/** Provider used when `--provider` is omitted. */
export const DEFAULT_PROVIDER = 'deepseek';

const BUILTIN_PROVIDERS: unknown[] = [
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    apiKey: '${DEEPSEEK_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://api.deepseek.com/anthropic' },
      openai: { baseUrl: 'https://api.deepseek.com/v1' },
    },
    models: {
      fast: { id: 'deepseek-v4-flash', contextWindow: 1000000 },
      default: { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1000000 },
      powerful: { id: 'deepseek-v4-pro', contextWindow: 1000000 },
    },
  },
  {
    provider: 'glm',
    name: 'GLM',
    apiKey: '${GLM_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      openai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    },
    models: {
      fast: { id: 'glm-4.5-air' },
      default: { id: 'glm-4.7' },
      powerful: { id: 'glm-5' },
    },
  },
  {
    provider: 'kimi',
    name: 'Kimi',
    apiKey: '${MOONSHOT_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://api.moonshot.cn/anthropic' },
      openai: { baseUrl: 'https://api.moonshot.cn/v1' },
    },
    models: {
      fast: { id: 'kimi-k2.7-code-highspeed' },
      default: { id: 'kimi-k2.7-code' },
      powerful: { id: 'kimi-k3', contextWindow: 1000000 },
    },
  },
  {
    provider: 'minimax',
    name: 'MiniMax',
    apiKey: '${MINIMAX_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://api.minimaxi.com/anthropic' },
      openai: { baseUrl: 'https://api.minimaxi.com/v1' },
    },
    models: {
      fast: { id: 'MiniMax M2.7-highspeed' },
      default: { id: 'MiniMax M2.7-highspeed' },
      powerful: { id: 'MiniMax-Text-01' },
    },
  },
  {
    provider: 'ollama',
    name: 'Ollama',
    apiKey: '${OLLAMA_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'http://localhost:11890' },
      openai: { baseUrl: 'http://localhost:11434/v1' },
    },
    models: {
      fast: { id: 'qwen3.5:4b' },
      default: { id: 'qwen3.5:4b' },
      powerful: { id: 'qwen3.5:4b' },
    },
  },
  {
    provider: 'qwen',
    name: 'Qwen',
    apiKey: '${DASHSCOPE_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy' },
      openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    },
    models: {
      fast: { id: 'qwen3-coder-plus' },
      default: { id: 'qwen3-coder-plus' },
      powerful: { id: 'qwen3-coder-plus' },
    },
  },
  {
    provider: 'volcengine',
    name: 'Volcengine Ark',
    apiKey: '${ARK_API_KEY}',
    defaultEndpoint: 'openai',
    endpoints: {
      anthropic: { baseUrl: 'https://ark.cn-beijing.volces.com/api/plan' },
      openai: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
    },
    models: {
      fast: { id: 'deepseek-v4-flash', contextWindow: 1000000 },
      default: { id: 'deepseek-v4-pro', contextWindow: 1000000 },
      powerful: { id: 'kimi-k3', contextWindow: 1000000 },
    },
  },
];

const PROVIDERS: ModelProvider[] = BUILTIN_PROVIDERS.map((entry) => ProviderSchema.parse(entry));
const BY_ID = new Map(PROVIDERS.map((provider) => [provider.provider, provider]));

export function listProviders(): ModelProvider[] {
  return PROVIDERS;
}

export function providerIds(): string[] {
  return PROVIDERS.map((provider) => provider.provider);
}

/** Load a built-in provider; throws with the available ids when unknown. */
export function getProvider(id: string): ModelProvider {
  const provider = BY_ID.get(id);
  if (!provider) {
    throw new Error(`Unknown provider "${id}" (available: ${providerIds().join(', ')})`);
  }
  return provider;
}

/** Resolve the base URL for an endpoint; throws listing the available endpoints. */
export function endpointBaseUrl(provider: ModelProvider, endpoint: EndpointName): string {
  const baseUrl = provider.endpoints[endpoint]?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `Provider "${provider.provider}" has no "${endpoint}" endpoint (available: ${ENDPOINTS.join(', ')})`,
    );
  }
  return baseUrl;
}

export interface ProviderModel {
  tier: ModelTier;
  id: string;
  contextWindow?: number;
}

/**
 * Model list in tier order, de-duplicated by id: several providers reuse one
 * model across tiers, while each tool renders a flat list.
 */
export function uniqueModels(provider: ModelProvider): ProviderModel[] {
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const tier of TIERS) {
    const model = provider.models[tier];
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push({ tier, id: model.id, contextWindow: model.contextWindow });
  }
  return result;
}

export interface ResolvedApiKey {
  /** True when the provider declares a `${ENV_VAR}` placeholder rather than a literal. */
  isPlaceholder: boolean;
  /** Environment variable name for a placeholder; undefined for a literal. */
  envName?: string;
  /** Resolved key value; empty when a placeholder's env var is unset. */
  value: string;
}

const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Resolve a provider's API-key declaration against the environment. */
export function resolveApiKey(provider: ModelProvider, env: NodeJS.ProcessEnv = process.env): ResolvedApiKey {
  const envName = PLACEHOLDER.exec(provider.apiKey)?.[1];
  if (envName) {
    return { isPlaceholder: true, envName, value: env[envName] ?? '' };
  }
  return { isPlaceholder: false, value: provider.apiKey };
}
