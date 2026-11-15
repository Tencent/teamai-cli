import type { InitHomeEnv, InitInstance, OpId, RuntimeFailure } from '@teamai/runtime-protocol';
import type { OpLedger } from '@teamai/runtime-kit/ledger';
import type { Daemon, Target } from './daemon/connect.js';
import type { Journal } from './journal.js';
import type { Offer } from './offer.js';
import type { ProviderToAdd } from './providers.js';

// ─── What one runtime process holds between requests ───
//
//  The daemon init connected to, what it offered, and the prompts, opens and stops in flight in this process. The
//  parts of the runtime (conversation.ts, workspace.ts, judge.ts, providers.ts, sandbox.ts) read and change it; runtime.ts makes it,
//  and init fills what it offered.
//

/**
 * A prompt this process follows: what wakes its waits when teamai stops it, whether its agent exists, and what ends its
 * entry in `creates` once no create of it can still be sent.
 */
export interface Following {
  stop: () => void;
  stopped: Promise<'stopped'>;
  created: boolean;
  landed: () => void;
}

export interface ProcessState {
  journal: Journal;
  ledger: OpLedger;
  write: OpLedger['write'];
  /** Ends `op` failed with `failure`. */
  fail(op: OpId, failure: RuntimeFailure): void;
  /** The Paseo agent the run was started from, when it was (Paseo sets PASEO_AGENT_ID in its agents). */
  startedFrom: string | undefined;
  /** The daemon init connected to, or the one a recover-mode stop connected to. */
  daemon: Daemon | undefined;
  mode: 'attended' | 'unattended';
  /** teamai closed stdin: a prompt's agent goes on in Paseo, and this process stops following it. */
  closing: boolean;
  /**
   * The daemon a stop needs by `deadline`: the one init connected to, or, in recover mode, one connected on first need,
   * or why none answered by then. Undefined: init did not connect to one.
   */
  reachBy(deadline: number): Promise<Daemon | RuntimeFailure | undefined>;
  /** What init offered of each tool and team instance the daemon has installed, by the name a step gives it. */
  offers: Map<string, Offer>;
  /** How Paseo runs each offered tool or instance, by its name. */
  targets: Map<string, Target>;
  /** The Paseo mode each offered tool's steps start in, which init read from Paseo; none for a tool Paseo starts as it does. */
  modeIds: Map<string, string>;
  /**
   * The Claude home each offered Claude or instance of it keeps its sessions in, when Paseo reports one: each finished
   * prompt on it names that home, so teamai reads the session there whatever HOME or tool root it runs with.
   */
  sessionHomes: Map<string, string>;
  /** Whether init offered `tokens`: then a finished prompt whose tokens the runtime cannot read says why. */
  offersTokens: boolean;
  /** Every variable each tool's command reads its home from, by the name a step gives it, as teamai sent it in init. */
  homeEnv: InitHomeEnv;
  /** The home each team instance keeps its sessions in, as teamai resolved it, by its name. */
  homeDirs: Map<string, string>;
  /** The tool home each offered tool or instance runs in when its Paseo provider's env sets one, by its name. */
  providerHomes: Map<string, string>;
  /**
   * The prompts this process follows from their acceptance, each with what wakes its waits when teamai stops it, whether
   * its agent exists, and its create, which settles once no create of it can still be sent.
   */
  waiting: Map<OpId, Following>;
  /** The prompts whose stop this process runs, and settles; one another process stops is settled when it journals the end. */
  stopping: Set<OpId>;
  /**
   * The prompts whose place a close is stopping: the close settles them once their agents stopped, so their own wait,
   * which may see the agent stop first, leaves the end to it, and goes on following if the close fails.
   */
  closeStops: Set<OpId>;
  /** The worktrees this process is opening as Paseo workspaces, by handle: a close waits for its open to end. */
  opens: Map<string, Promise<void>>;
  /** The last open this process runs on each directory, by its resolved path: the next one there waits for it. */
  turns: Map<string, Promise<void>>;
  /** The team instances init offered whose Paseo provider teamai adds at the first open or prompt that runs them, by name. */
  toAdd: Map<string, { planned: ProviderToAdd; instance: InitInstance }>;
  /**
   * The creates of the prompts this process launched, each settled once no create of it can still be sent. Kept apart
   * from `waiting`, which a prompt leaves once it ends: one a cancel ended because its create took too long still has
   * that create pending, and a retried cancel and a close wait for it.
   */
  creates: Map<OpId, Promise<void>>;
}
