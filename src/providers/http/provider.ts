// ─── HTTP resource provider ──────────────────────────────
//
// A ResourceProvider backed by an HTTP backend. It owns the common shape
// (capabilities, name, type) and delegates every operation to a protocol
// HttpBackendAdapter, which handles that backend's wire format. HTTP backends
// deliver and report but are never a push target. See issue #404.

import type {
  ResourceProvider,
  ProviderCapabilities,
  ProviderResult,
  ProviderSummary,
  SyncContext,
  HttpBackendAdapter,
  HttpProviderConfig,
} from '../types.js';

const HTTP_CAPABILITIES: ProviderCapabilities = {
  pull: true,
  push: false,
  report: true,
  commands: true,
};

export class HttpResourceProvider implements ResourceProvider {
  readonly type = 'http' as const;
  readonly capabilities = HTTP_CAPABILITIES;

  constructor(
    private readonly config: HttpProviderConfig,
    private readonly adapter: HttpBackendAdapter,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get priority(): number {
    return this.config.priority;
  }

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
