import type {
  HttpBackendAdapter,
  HttpProviderConfig,
  ProviderCapabilities,
  ProviderResult,
  ProviderSummary,
  ResourceProvider,
  SyncContext,
} from '../types.js';

export class HttpResourceProvider implements ResourceProvider {
  readonly type = 'http' as const;
  readonly capabilities: ProviderCapabilities = { pull: true, push: false, report: true, commands: true };

  constructor(
    readonly config: HttpProviderConfig,
    readonly adapter: HttpBackendAdapter,
  ) {}

  get name(): string { return this.config.name; }
  get priority(): number { return this.config.priority; }

  sync(context: SyncContext): Promise<ProviderResult> {
    return this.adapter.sync(this.config, context);
  }

  describe(): Promise<ProviderSummary> {
    return this.adapter.describe(this.config);
  }

  teardown(): Promise<void> {
    return this.adapter.teardown(this.config);
  }
}
