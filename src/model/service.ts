import { ConfigFile, stringifyConfig } from './config-file.js';
import { deepMerge, isPlainObject } from './merge.js';
import {
  DEFAULT_PROVIDER,
  endpointBaseUrl,
  getProvider,
  resolveApiKey,
  uniqueModels,
  type EndpointName,
  type ModelProvider,
} from './providers.js';
import { getToolTarget, type RenderContext, type ToolTarget } from './tool-targets.js';
import { getUserHome } from '../utils/home.js';

export interface ModelInjectOptions {
  providerId?: string;
  tool: string;
  endpoint?: string;
}

export interface ModelPlan {
  target: ToolTarget;
  provider: ModelProvider;
  endpointName: EndpointName;
  context: RenderContext;
  fragment: unknown;
  configFile: ConfigFile;
  merged?: unknown;
  text?: string;
}

/**
 * Render a provider's model catalog into one tool's native config and merge it
 * into that tool's user-level file.
 *
 * `buildPlan` only resolves (no disk access); `render` adds the merge with the
 * existing file; `apply` writes the result.
 */
export class ModelConfigService {
  buildPlan({ providerId = DEFAULT_PROVIDER, tool, endpoint }: ModelInjectOptions): ModelPlan {
    const target = getToolTarget(tool);
    const provider = getProvider(providerId);
    const endpointName = this.#selectEndpoint(provider, target, endpoint);
    const apiKey = resolveApiKey(provider);
    if (!apiKey.value) {
      throw new Error(
        `Environment variable ${apiKey.envName} is not set; set it before injecting provider "${provider.provider}"`,
      );
    }
    const modelList = uniqueModels(provider);
    const context: RenderContext = {
      provider,
      endpoint: endpointName,
      baseUrl: endpointBaseUrl(provider, endpointName),
      apiKeyEnv: apiKey.envName ?? '',
      apiKey: apiKey.value,
      modelList,
      defaultModelId: provider.models.default.id,
    };
    const fragment = target.render(context);
    const configFile = new ConfigFile(target.configPath(getUserHome()), target.format);
    return { target, provider, endpointName, context, fragment, configFile };
  }

  render(options: ModelInjectOptions): ModelPlan {
    const plan = this.buildPlan(options);
    const existing = plan.configFile.read();
    const merged = plan.target.merge
      ? plan.target.merge(existing, plan.fragment)
      : deepMerge(
          isPlainObject(existing) ? existing : {},
          isPlainObject(plan.fragment) ? plan.fragment : {},
        );
    return { ...plan, merged, text: stringifyConfig(plan.target.format, merged) };
  }

  async apply(options: ModelInjectOptions): Promise<ModelPlan> {
    const plan = this.render(options);
    await plan.configFile.write(plan.merged);
    return plan;
  }

  /** Endpoint priority: tool-mandated > explicit override > tool preference > provider default. */
  #selectEndpoint(provider: ModelProvider, target: ToolTarget, override?: string): EndpointName {
    if (target.forceEndpoint) return target.forceEndpoint;
    const name = (override as EndpointName | undefined)
      || target.preferredEndpoint
      || provider.defaultEndpoint
      || 'openai';
    endpointBaseUrl(provider, name); // validate; throws listing the available endpoints
    return name;
  }
}
