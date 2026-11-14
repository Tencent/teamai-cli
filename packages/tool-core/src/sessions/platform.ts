import type { Processes } from '@teamai/shared/exec';
import type { AgentAdapter } from './base.js';
import type { SessionIdFormat } from './ids.js';

/**
 * Where a platform keeps its sessions on a machine, resolved by `sessionStoreDir` (locate.ts).
 * - `tool-home`: `<dir>` in `home`'s root: the member's recorded `toolRoots[root]` (`root`
 *   defaults to `home`), else that tool's home, which a recorded or env move relocates. `home` is
 *   the tool whose `sessions` lists the platform (session-platform-facts.test.ts).
 * - `xdg-data`: `$XDG_DATA_HOME/<child>`, else `~/.local/share/<child>`.
 * - `ide-history`: the CodeBuddy IDE's own data directories (`listIdeHistoryRoots`).
 */
export type SessionStore<TTool extends string = string> =
  | { readonly in: 'tool-home'; readonly home: TTool; readonly dir: string; readonly root?: string }
  | { readonly in: 'xdg-data'; readonly child: string }
  | { readonly in: 'ide-history' };

/**
 * Session storage and migration facts of one platform, declared by the family that owns it.
 * `tool`: only on a platform no `TOOLS` entry lists in its `sessions`, the tool id its sessions
 * are credited to (session-platform-facts.test.ts).
 */
export interface SessionPlatformFacts<TTool extends string = string> {
  tool?: string;
  store: SessionStore<TTool>;
  /** The command that continues a session of this platform in its CLI. */
  resume: (sessionId: string) => string;
  thinking: boolean;
  images: boolean;
  nativeTools: ReadonlySet<string>;
  legacyIdWithoutWorkspace: boolean;
  sqliteRegistrationOnWindows: boolean;
  idFormat: SessionIdFormat;
  /** The tool resumes only from a store TeamAI cannot write, so its sessions are read and never written. */
  readOnly?: true;
  /**
   * Whether this format's sessions can carry another platform id, so an instance of the tool keeps its own sessions in
   * it, read through the definition's `adapterAs`. False when an instance of the tool keeps no sessions teamai reads.
   */
  instanceSessions: boolean;
}

/**
 * What the host gives a session adapter: the processes it may start, the executables of a tool installed here, in
 * the order to try, as the Codex format runs the Codex CLI to index a session it wrote, and the home variables that
 * start a command of `tool` in the home `dir`, which teamai decides (`toolCommandEnv`) and an adapter spreads over its env.
 */
export interface SessionHost {
  readonly processes: Processes;
  executablesOf(tool: string): readonly string[];
  homeEnvAt(tool: string, dir: string): Readonly<Record<string, string>>;
}

/** A platform whose store teamai resolves (`sessionStoreDir`) and hands to its adapter. */
export type StoredPlatformDefinition<TTool extends string = string> = SessionPlatformFacts<TTool> & {
  readonly store: Exclude<SessionStore<TTool>, { readonly in: 'ide-history' }>;
  adapter(storeDir: string, host: SessionHost): AgentAdapter;
} & (
  | {
    readonly instanceSessions: true;
    /** The adapter of an instance's own platform `platform`, in this platform's format, on the instance's store. */
    adapterAs(platform: string, storeDir: string, host: SessionHost): AgentAdapter;
  }
  | { readonly instanceSessions: false; readonly adapterAs?: never }
);

/** A platform whose adapter finds its own store: the CodeBuddy IDE's history. */
export type SelfLocatingPlatformDefinition<TTool extends string = string> = SessionPlatformFacts<TTool> & {
  readonly store: Extract<SessionStore<TTool>, { readonly in: 'ide-history' }>;
  readonly instanceSessions: false;
  adapter(): AgentAdapter;
};

/** A session platform a family declares: its facts, and the adapter it builds on its store. */
export type SessionPlatformDefinition<TTool extends string = string> = StoredPlatformDefinition<TTool> | SelfLocatingPlatformDefinition<TTool>;

/** Whether `platform`'s adapter finds its own store, so no store is resolved for it. */
export function locatesOwnStore<TTool extends string>(platform: SessionPlatformDefinition<TTool>): platform is SelfLocatingPlatformDefinition<TTool> {
  return platform.store.in === 'ide-history';
}
