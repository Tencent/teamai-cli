import type {
  HttpBackendAdapter,
  HttpProviderConfig,
  HttpRoutes,
  ProviderResult,
  ProviderSummary,
  SyncContext,
} from '../../../types.js';
import { getHttpProviderCredentialPath, getHttpProviderHome } from '../../store.js';
import {
  DEFAULT_ROUTES,
  describeLocalAgent,
  initLocalAgentHttp,
  pullLocalAgentForCwd,
  removeLocalAgentHttp,
  reportAndSyncFromHook,
  withLocalAgentProvider,
} from '../../../../local-agent.js';

function inProvider<T>(config: HttpProviderConfig, operation: () => Promise<T>): Promise<T> {
  return withLocalAgentProvider({
    name: config.name,
    home: getHttpProviderHome(config.name),
    credentialPath: getHttpProviderCredentialPath(config.name),
  }, operation);
}

export class ClawProAdapter implements HttpBackendAdapter {
  readonly name = 'clawpro';

  routes(): HttpRoutes {
    return { ...DEFAULT_ROUTES };
  }

  async initialize(config: HttpProviderConfig, token?: string): Promise<void> {
    await inProvider(config, () => initLocalAgentHttp({ endpoint: config.endpoint, token, force: true }));
  }

  async sync(config: HttpProviderConfig, context: SyncContext): Promise<ProviderResult> {
    let hookOutput: string | null = null;
    const active = context.trigger === 'hook' && context.stdin
      ? await inProvider(config, async () => {
        hookOutput = await reportAndSyncFromHook(context.stdin!, context.tool ?? 'claude');
        return true;
      })
      : await inProvider(config, () => pullLocalAgentForCwd({ cwd: context.cwd, tool: context.tool }));
    return {
      provider: config.name,
      ok: true,
      changed: active,
      message: active ? 'synced' : 'not configured',
      ...(hookOutput ? { hookOutput } : {}),
    };
  }

  async describe(config: HttpProviderConfig): Promise<ProviderSummary> {
    const summary = await inProvider(config, () => describeLocalAgent());
    return {
      name: config.name,
      type: 'http',
      priority: config.priority,
      capabilities: { pull: true, push: false, report: true, commands: true },
      endpoint: summary?.endpoint ?? config.endpoint,
      adapter: this.name,
    };
  }

  async teardown(config: HttpProviderConfig): Promise<void> {
    await inProvider(config, () => removeLocalAgentHttp());
  }
}
