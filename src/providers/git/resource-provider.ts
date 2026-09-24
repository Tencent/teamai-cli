// ─── Git resource provider ───────────────────────────────
//
// Wraps the existing team-repo sync (git clone + resource deploy) as a
// ResourceProvider so a git backend sits alongside HTTP backends under one
// registry. This is a thin shell: the actual pull/teardown behavior is injected
// as closures by the caller, so wrapping introduces ZERO behavior change — the
// closures run the same code paths as before the abstraction existed.
//
// See issue #404, phase 1.

import type {
  ResourceProvider,
  ProviderCapabilities,
  ProviderResult,
  ProviderSummary,
  SyncContext,
} from '../types.js';

/** Sync a git-backed source. Returns whether anything changed on disk. */
export type GitSyncOperation = (context: SyncContext) => Promise<{ changed: boolean; message?: string }>;

/** Remove a git-backed source's local state (clone, worktrees, manifests). */
export type GitTeardownOperation = () => Promise<void>;

export class GitResourceProvider implements ResourceProvider {
  readonly type = 'git' as const;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly name: string,
    readonly priority: number,
    /** Team repo remote URL, for `describe`. */
    private readonly repo: string,
    private readonly syncOperation: GitSyncOperation,
    private readonly teardownOperation: GitTeardownOperation,
    /** Whether this git source accepts `teamai push` (main repo yes, cross-team source no). */
    writable: boolean,
  ) {
    this.capabilities = { pull: true, push: writable, report: false, commands: false };
  }

  async sync(context: SyncContext): Promise<ProviderResult> {
    const { changed, message } = await this.syncOperation(context);
    return { provider: this.name, ok: true, changed, message };
  }

  async describe(): Promise<ProviderSummary> {
    return {
      name: this.name,
      type: this.type,
      priority: this.priority,
      capabilities: this.capabilities,
      endpoint: this.repo,
    };
  }

  async teardown(): Promise<void> {
    await this.teardownOperation();
  }
}
