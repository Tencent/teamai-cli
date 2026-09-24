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
  ProviderResult,
  ProviderSummary,
  SyncContext,
} from '../../../types.js';
import {
  withHttpProvider,
  initLocalAgentHttp,
  reportAndSyncFromHook,
  pullLocalAgentForCwd,
  describeLocalAgent,
  removeLocalAgentHttp,
  type SyncOutcome,
} from './client.js';
import { httpProviderExecutionContext } from '../../store.js';

export class ClawProAdapter implements HttpBackendAdapter {
  readonly name = 'clawpro';

  async initialize(config: HttpProviderConfig, token?: string): Promise<void> {
    await withHttpProvider(httpProviderExecutionContext(config.name), () =>
      initLocalAgentHttp({ endpoint: config.endpoint, token, force: true }),
    );
  }

  async sync(config: HttpProviderConfig, context: SyncContext): Promise<ProviderResult> {
    return withHttpProvider(httpProviderExecutionContext(config.name), async () => {
      // reportAndSyncLocalAgent swallows network/command errors (so one bad
      // backend never crashes a hook); it signals them through this outcome
      // instead, so we report an honest ok rather than always true.
      const outcome: SyncOutcome = {};
      let hookOutput: string | null = null;
      if (context.trigger === 'hook' && context.stdin) {
        hookOutput = await reportAndSyncFromHook(context.stdin, context.tool ?? 'workbuddy', outcome);
      } else {
        await pullLocalAgentForCwd({ cwd: context.cwd, tool: context.tool }, outcome);
      }
      return {
        provider: config.name,
        ok: !outcome.failed,
        changed: false,
        ...(outcome.error ? { message: outcome.error } : {}),
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
