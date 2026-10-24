/** Workflow types for the v1alpha1 local-driver subset. */

import type { PinnedScorer } from '../scorers/pin.js';
import type { DeliveryReceipt, UnresolvedCreate } from './delivery-schema.js';
import type { ArchivedPass, LimitsFrom, ReleasedTokens, SessionContinuation, StepState, StoppedAttempt } from './step-state.js';
import type { Requirements, Setup, Unenforced } from './requirements.js';
import type { LeaseSession } from './workspace.js';

/** The driver's lease ownership, independent of its per-request capabilities. */
export interface DriverIdentity {
  kind: string;
  machine: string;
  workspace: string;
}

export type OutputSchema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
  | { type: 'object'; fields: Record<string, OutputSchema> }
  | { type: 'array'; items: OutputSchema };

/** A HITL request that must settle before its step can act or reach an end. */
export interface StepHitl {
  /** The YAML declaration, with approve as the yes-or-no case. */
  kind: 'approve' | 'choose';
  /** Template text rendered from the step's ready context. */
  message: string;
  /** The choices an answer must name exactly. */
  options: string[];
  /** The default for an optional choose when a driver without HITL uses auto approval. */
  default?: string;
  /** Whether the answer must come from a person at a terminal or through a driver UI's declared answer. */
  required: boolean;
}

export interface WorkflowStep {
  id: string;
  /** Step ids this step waits for. Absent only on the first step, which is a root. */
  needs?: string[];
  /** Expression source; a false value skips the step. */
  if?: string;
  command?: string;
  /** Resolved, revision-bound prompt text. */
  prompt?: string;
  /** Original team-repo-relative source path for a cached prompt. */
  promptFile?: string;
  /** A person works in the prompt tool; only a driver with HITL can take the lease. */
  interactive?: true;
  /** The question answered before this step's action or end. */
  hitl?: StepHitl;
  agent?: string;
  /** The model a prompt step runs on, as written: an alias from `models/aliases.yaml` or a model name. The driver resolves it. */
  model?: string;
  /** The scorers that judge this prompt or workflow step's succeeded passes. */
  scorers?: StepScorers;
  output?: OutputSchema;
  /** Variables a command step receives, as written; `{{ inputs.… }}` and `{{ steps.… }}` render when the step is leased. */
  env?: Record<string, string>;
  /**
   * The workflow this step runs: a name, which the cache keeps and `start` snapshots into the run,
   * or an inline workflow, kept in place.
   */
  workflow?: string | InlineWorkflow;
  /** Values for the inputs of the workflow this step runs, as written; every string inside follows the template rules. */
  with?: Record<string, unknown>;
  /** Name in `ends` this step finishes the workflow with when it succeeds. A step with no action only ends the workflow and is never leased. */
  end?: string;
  /** Runs the steps from `backTo` to this step again after this step succeeds. */
  loop?: StepLoop;
  /** Expression source, evaluated when this step succeeds; when true, its workflow, or that workflow's loop, ends as success. */
  break?: string;
  /** Runs the step's action once per item of a list, each as an instance such as `build[2]`. */
  forEach?: ForEach;
  /**
   * Where the step runs. A command that omits it uses the active checkout and is read-only.
   * A prompt that omits it continues an enclosing `new` or `continue` copy, or stays read-only.
   */
  workspace?: typeof WORKSPACE_MODES[number];
  /** Opens a review request after the branch's work succeeds. TeamAI never merges it. */
  deliver?: 'pr';
  /** A session this step resumes. `continue` uses this step's previous pass. `from` names another step. */
  session?: { continue: true } | { from: string };
  /** What the driver that runs this step, or every step of the workflow it runs, must provide. */
  requires?: Requirements;
  /** Milliseconds the step's lease, or the workflow or items it runs, may take before the step fails with `timeout`. */
  timeout?: number;
  /**
   * On a workflow step: the tokens its workflow may spend each time the step starts, a loop's next pass or a retry
   * included. Spending more fails the step with `budget_exceeded`.
   */
  budget?: Budget;
  /** On a prompt step: the most agent turns its tool may take, for a driver that can cap them. */
  maxTurns?: number;
}

/**
 * The input and output tokens a workflow may spend over every pass of its steps, counted from when it starts: the run's
 * from its start, or from the retry that reopened it, and a workflow step's from each time the step starts.
 */
export interface Budget {
  tokens: number;
}

/** A `for_each`: the list of items, and how many of them may run at once. */
export interface ForEach {
  /** Expression source that gives the list. */
  items: string;
  /** At most this many items are started and not yet settled. No limit when absent. */
  maxParallel?: number;
}

/**
 * A workflow loop. When a round reaches no end, every step of the workflow runs again, while `while` is true, or
 * always when there is none. The workflow runs at most `maxIterations` rounds; one more fails it with `loop_exhausted`.
 */
export interface WorkflowLoop {
  /** Expression source, evaluated when a round has nothing left to run. */
  while?: string;
  maxIterations: number;
}

/**
 * A step loop. After its step succeeds, every step from `backTo` to it runs again, while `while` is true, or always
 * when there is none. The step runs at most `maxIterations` times; a run past that fails it with `loop_exhausted`.
 */
export interface StepLoop {
  /** The step itself, or a step it needs, directly or not. */
  backTo: string;
  /** Expression source, evaluated when the step succeeds. */
  while?: string;
  maxIterations: number;
}

/** Where a step runs: in the checkout as it is, in a new copy, or in the copy an enclosing step opened. */
export const WORKSPACE_MODES = ['read-only', 'new', 'continue'] as const;

/** The keys that give a step its action, as YAML writes them, each with the definition field it fills. */
export const STEP_ACTIONS = { command: 'command', prompt: 'prompt', prompt_file: 'promptFile', workflow: 'workflow' } as const satisfies Record<string, keyof WorkflowStep>;

/** Whether a step runs work rather than only a HITL request or end. */
export function hasAction(step: WorkflowStep): boolean {
  return Object.values(STEP_ACTIONS).some((field) => step[field] !== undefined);
}

export type EndOutcome = 'succeeded' | 'failed';

/**
 * A workflow written inside a step. It has no inputs of its own: its steps read the enclosing workflow's inputs
 * and the steps the enclosing step needs, directly or through their needs.
 */
export interface InlineWorkflow {
  ends?: Record<string, EndOutcome>;
  outputs?: Record<string, string>;
  loop?: WorkflowLoop;
  steps: WorkflowStep[];
}

/** Values a workflow file sets for its steps. */
export interface WorkflowDefaults {
  /** The model of a prompt step whose step and definition choose none, as written. */
  model?: string;
  /** Whether a step's scorers share one judge call when the step does not say. */
  scorers?: { batch: boolean };
  /** Requirements as if written on every step of the file. */
  requires?: Requirements;
}

/** `scorers: [a, b]`, or `scorers: { names: [a, b], batch: true }`. Each name is a file in `scorers/`. */
export interface StepScorers {
  names: string[];
  batch?: boolean;
}

export interface WorkflowDefinition {
  schemaVersion: 'v1alpha1';
  name: string;
  description: string;
  /** Values `start --inputs` must pass, each typed with the output shorthand. Every input is required. */
  inputs?: Record<string, OutputSchema>;
  /** Named ends a step can finish this workflow with, each with the run outcome it gives. */
  ends?: Record<string, EndOutcome>;
  /** Values this workflow returns to a step that runs it, each a path such as `steps.<id>.outputs.<field>`. */
  outputs?: Record<string, string>;
  /** Runs the workflow's steps again, round after round. */
  loop?: WorkflowLoop;
  defaults?: WorkflowDefaults;
  /** Milliseconds a run of this file may take, counted from its start, or from the step that runs it. */
  timeout?: number;
  budget?: Budget;
  /** Runs in each workspace a driver creates for a step of this file, or of a workflow it runs that has no setup. */
  setup?: Setup;
  steps: WorkflowStep[];
}

export interface WorkflowDiagnostic {
  file: string;
  line: number;
  column: number;
  field: string;
  message: string;
  /**
   * The cache must not keep an older runnable copy of a file with any code.
   * `unknown_key`: a key this version does not know.
   * `missing_needs`: a step after the first has no `needs`; a copy cached under the old linear rules must not run as a graph.
   * `false_if`: an `if` is always false; an older copy would still run the step the author turned off.
   * `bad_template`: a `{{ inputs.… }}` or `{{ steps.… }}` that does not read a valid path; a prompt cached before
   *   templates existed would now render it as empty text instead of the text it was written as.
   * `dotted_name`: a step id or an `inputs` or `output` field name contains "."; no path can read it, and a
   *   step id would clash with the dotted paths that address steps inside a sub-workflow.
   * `undeclared_output`: a read names an output the workflow a step runs does not declare;
   *   the file may be unchanged while that workflow changed, and the kept copy would read null where it expects a value.
   * `undeclared_end`: an `if` compares `steps.<id>.end` with a name the workflow step `<id>` runs does not declare in `ends`;
   *   for the same reason, the kept copy would take a branch that can never match.
   * `bad_loop`: a `loop`, `break` or `for_each` pull rejects; the kept copy would run once the steps the author wrote
   *   to repeat or to run per item, or run on past the point the author wrote to stop at.
   * `bad_session`: a `session.from` pull rejects; the kept copy would resume a step the author did not name.
   * `bad_workspace`: `workspace` is not read-only, new, or continue; the kept copy would run the step in the wrong place.
   * `bad_delivery`: delivery is not PR creation on a writable branch; the kept copy would apply a different policy.
   */
  code?: 'unknown_key' | 'missing_needs' | 'false_if' | 'bad_template' | 'dotted_name' | 'undeclared_output' | 'undeclared_end' | 'bad_loop' | 'bad_session' | 'bad_workspace' | 'workflow_namespace_conflict' | 'prompt_namespace_conflict' | 'bad_delivery';
}

export type StepOutcome = 'success' | 'failed' | 'released';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
  /** The session the lease offers the step: the report may name it, or one it continued, as `resumed`. */
  session?: LeaseSession;
  /** The best-effort requirements the driver could not enforce, decided when the lease was issued; a hand-back only adds. */
  unenforced?: Unenforced[];
  /** When the step's own `timeout` ends this lease, set when it is issued so a hand-back keeps it. */
  expiresAt?: string;
}

export interface WorkflowFailure {
  code: string;
  message: string;
}

/** Durable run file. `revision` rejects stale reports; `definition` is the cached snapshot. */
export interface RunState {
  schemaVersion: 'v1alpha1';
  id: string;
  name: string;
  revision: number;
  status: RunStatus;
  /** Identity of the latest driver that called next, retained so resume can recover its workspace. */
  driver?: DriverIdentity;
  /** The end this run reached, set when it settles. */
  end?: string;
  /** Why the run failed when no end says it, such as `loop_exhausted` on a looping top-level workflow. */
  failure?: WorkflowFailure;
  /** The validated `--inputs`, stored when the workflow declares inputs. */
  inputs?: Record<string, unknown>;
  /** Covers `definition` and every workflow in `workflows`. */
  sourceHash: string;
  /** Remote-reachable team commit shared by every cached workflow in this run. */
  teamRevision?: string;
  definition: WorkflowDefinition;
  /** The sub-workflows the run uses, by name, as they were cached when it started. */
  workflows?: Record<string, WorkflowDefinition>;
  /** The scorers its steps list, by name, as they were cached when it started. A name with no valid scorer then is absent. */
  scorers?: Record<string, PinnedScorer>;
  /**
   * Step instances in declaration order; a sub-workflow's steps follow the step that runs it. Never changed in place:
   * adding or removing an instance assigns a new array, so an index the engine keeps per array never goes stale.
   */
  steps: readonly StepState[];
  settledAttempts: string[];
  /** Cumulative settled-attempt count; settledAttempts is bounded at 32 for dedup. */
  settledCount?: number;
  /** Whether the run queued its end record when it settled. A run settled with usage reporting off, or before this field, queued none. */
  endRecordQueued?: boolean;
  /** Attempts whose lease the engine cancelled; a report of one is answered `lease_cancelled`. */
  cancelledAttempts?: string[];
  /** Passes of child and item instances a loop removed from `steps`. */
  archive?: ArchivedPass[];
  /** The tokens of attempts their driver released, or reported after the engine stopped them, which no pass keeps. */
  releasedTokens?: ReleasedTokens[];
  /** Attempts the engine stopped whose driver has not reported their tokens yet. Local run state only. */
  stoppedAttempts?: StoppedAttempt[];
  /** The round of a looping top-level workflow. */
  round?: number;
  /**
   * The commit the run's workspaces and agent configuration start from, and the branch it was on. Set by `workflow start`
   * in a git checkout, else by the first `next` that sends `base`. A later `base` does not change it.
   */
  base?: { ref?: string; commit: string };
  /** The checkout `workflow start` ran in, or the one a claim took the run into. Local run state only: never on a lease or a record. */
  checkout?: string;
  /**
   * Workspaces this run has handed out, by branch. A `continue` step stays with the driver that opened the copy. A copy a
   * claim brought from another machine has no owner until a driver leases it. `from` is the run branch the copy started
   * from, `after` items before other needs, so a pull request from it targets the nearest delivered branch it grew from.
   * `used` is set once a step ran in the copy: a report on a lease of it was accepted, neither `released` nor a setup
   * failure. Only a lease on an unused copy carries setup, and only an unused copy's owner gives it up when it hands its
   * lease back. `used` is local run state only.
   */
  copies?: Record<string, { owner?: DriverIdentity; commit?: string; from?: string; used?: true }>;
  /**
   * The pull requests delivered on this run, once each, in the order they first appeared. Append-only: a receipt says a
   * request was opened, never that it is still open, so whether a delivery reuses one is its host's lookup to say.
   */
  deliveries?: DeliveryReceipt[];
  /**
   * The pull requests TeamAI asked a host to open and has no receipt for, listed under the run lock right before each
   * create. A receipt or a lookup removes one; a retry, a cancel or an archive of its step does not.
   */
  creating?: UnresolvedCreate[];
  /**
   * Sessions a step resumed and continued under another id, in report order: a copy on another machine or in another
   * tool. `to` holds the turns of `from` and the ones that step added, so a step that would resume `from` resumes `to`.
   */
  sessionContinuations?: SessionContinuation[];
  /** How this machine last published the run, or took it from another machine. Local run state only. */
  publication?: RunPublication;
  createdAt: string;
  /**
   * Where the workflow's `timeout` and `budget` count from once a retry reopened the run, so the reopened run gets a whole
   * window and a whole budget. Absent, they count from `createdAt`, with nothing spent.
   */
  limitsFrom?: LimitsFrom;
  updatedAt: string;
}

/** What this machine knows of the run's snapshot on `teamai-reports`. */
export interface RunPublication {
  /** The snapshot's state revision when this machine last wrote it or took the run, as origin confirmed it. */
  stateRevision: number;
  /** The `write` of a snapshot this machine committed whose delivery it has not seen. Another reports write may push it later. */
  pending?: string;
  /** Set when this machine takes the run over: the local driver brings its copies' local branches to the recorded commits once. */
  reconcileCopies?: true;
}

export interface CachedWorkflow {
  relativePath: string;
  sourceHash: string;
  /** Remote-reachable team commit that stores the workflow and prompt bytes exactly. */
  teamRevision?: string;
  /**
   * The YAML the definition was parsed from, so a kept copy can be checked again against the workflows it runs.
   * Absent in a cache written before a workflow could run another file.
   */
  content?: string;
  definition: WorkflowDefinition;
  validatedAt: string;
}

export type WorkflowEnvelope =
  | { data: Record<string, unknown> }
  | { error: { code: string; message: string; labels?: Array<Record<string, unknown>> } };

export function isWorkflowError(
  envelope: WorkflowEnvelope,
): envelope is Extract<WorkflowEnvelope, { error: unknown }> {
  return 'error' in envelope;
}
