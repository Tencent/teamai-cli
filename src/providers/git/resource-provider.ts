import type {
  ProviderCapabilities,
  ProviderResult,
  ProviderSummary,
  ResourceProvider,
  SyncContext,
} from '../types.js';

/** Resource-level Git transport; host-specific authentication stays in GitProvider. */
export class GitResourceProvider implements ResourceProvider {
  readonly type = 'git' as const;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly name: string,
    readonly priority: number,
    readonly repo: string,
    private readonly syncOperation: (context: SyncContext) => Promise<ProviderResult>,
    private readonly teardownOperation: () => Promise<void>,
    writable = false,
  ) {
    this.capabilities = { pull: true, push: writable, report: false, commands: false };
  }

  sync(context: SyncContext): Promise<ProviderResult> {
    return this.syncOperation(context);
  }

  async describe(): Promise<ProviderSummary> {
    return { name: this.name, type: this.type, priority: this.priority, capabilities: this.capabilities };
  }

  teardown(): Promise<void> {
    return this.teardownOperation();
  }
}
