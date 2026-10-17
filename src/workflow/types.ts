/** Workflow types for the v1alpha1 local-driver subset. */

import type { ArchivedPass, StepState } from './step-state.js';

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
  agent?: string;
  /** The model a prompt step runs on, as written: an alias from `models/aliases.yaml` or a model name. The driver resolves it. */
  model?: string;
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

/** The keys that give a step its action, as YAML writes them, each with the definition field it fills. */
export const STEP_ACTIONS = { command: 'command', prompt: 'prompt', prompt_file: 'promptFile', workflow: 'workflow' } as const satisfies Record<string, keyof WorkflowStep>;

/** A step with no action only ends its workflow. */
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
   */
  code?: 'unknown_key' | 'missing_needs' | 'false_if' | 'bad_template' | 'dotted_name' | 'undeclared_output' | 'undeclared_end' | 'bad_loop';
}

export type StepOutcome = 'success' | 'failed' | 'released';
export type RunStatus = 'running' | 'succeeded' | 'failed';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
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
  /** The end this run reached, set when it settles. */
  end?: string;
  /** Why the run failed when no end says it, such as `loop_exhausted` on a looping top-level workflow. */
  failure?: WorkflowFailure;
  /** The validated `--inputs`, stored when the workflow declares inputs. */
  inputs?: Record<string, unknown>;
  /** Covers `definition` and every workflow in `workflows`. */
  sourceHash: string;
  definition: WorkflowDefinition;
  /** The sub-workflows the run uses, by name, as they were cached when it started. */
  workflows?: Record<string, WorkflowDefinition>;
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
  /** The round of a looping top-level workflow. */
  round?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CachedWorkflow {
  relativePath: string;
  sourceHash: string;
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
  | { error: { code: string; message: string } };

export function isWorkflowError(
  envelope: WorkflowEnvelope,
): envelope is { error: { code: string; message: string } } {
  return 'error' in envelope;
}
