// ─── ClawPro HTTP backend adapter ────────────────────────
//
// Speaks the ClawPro report/sync/ack wire format. It is a thin translation
// layer over ./client.ts (relocated from the former src/local-agent.ts): each
// HttpBackendAdapter method runs the corresponding client entry point inside the
// provider's isolated execution context, so a named provider's state lands in
// its own directory. The wire format — routes, `local_agent_id`, payload shapes
// — is unchanged; see issue #404.

import type {
  HttpBackendAdapter,
  HttpProviderConfig,
  HttpRoutes,
  ProviderResult,
  ProviderSummary,
  SyncContext,
} from '../../../types.js';
import {
  DEFAULT_ROUTES,
  withHttpProvider,
  initLocalAgentHttp,
  reportAndSyncFromHook,
  pullLocalAgentForCwd,
  describeLocalAgent,
  removeLocalAgentHttp,
} from './client.js';
import { httpProviderExecutionContext } from '../../store.js';

export class ClawProAdapter implements HttpBackendAdapter {
  readonly name = 'clawpro';

  routes(_config: HttpProviderConfig): HttpRoutes {
    // ClawPro uses the default /api/local-agent/* layout.
    return { ...DEFAULT_ROUTES };
  }

  async initialize(config: HttpProviderConfig, token?: string): Promise<void> {
    await withHttpProvider(httpProviderExecutionContext(config.name), () =>
      initLocalAgentHttp({ endpoint: config.endpoint, token, force: true }),
    );
  }

  async sync(config: HttpProviderConfig, context: SyncContext): Promise<ProviderResult> {
    return withHttpProvider(httpProviderExecutionContext(config.name), async () => {
      let hookOutput: string | null = null;
      if (context.trigger === 'hook' && context.stdin) {
        hookOutput = await reportAndSyncFromHook(context.stdin, context.tool ?? 'workbuddy');
      } else {
        await pullLocalAgentForCwd({ cwd: context.cwd, tool: context.tool });
      }
      return {
        provider: config.name,
        ok: true,
        changed: false,
        ...(hookOutput ? { hookOutput } : {}),
      };
    });
  }

  async describe(config: HttpProviderConfig): Promise<ProviderSummary> {
    const summary = await withHttpProvider(httpProviderExecutionContext(config.name), () =>
      describeLocalAgent(),
    );
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
    await withHttpProvider(httpProviderExecutionContext(config.name), () =>
      removeLocalAgentHttp(),
    );
  }
}
