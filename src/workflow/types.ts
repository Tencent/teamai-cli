/** Workflow types for the v1alpha1 local-driver subset. */

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
  steps: WorkflowStep[];
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
   * `undeclared_output`: a read of `steps.<id>.outputs.<name>` that the workflow step `<id>` runs does not declare;
   *   the file may be unchanged while that workflow changed, and the kept copy would read null where it expects a value.
   * `undeclared_end`: an `if` compares `steps.<id>.end` with a name the workflow step `<id>` runs does not declare in `ends`;
   *   for the same reason, the kept copy would take a branch that can never match.
   */
  code?: 'unknown_key' | 'missing_needs' | 'false_if' | 'bad_template' | 'dotted_name' | 'undeclared_output' | 'undeclared_end';
}

/** `running`: a workflow step whose child steps are in the run and not all settled. */
export type StepStatus = 'pending' | 'leased' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type StepOutcome = 'success' | 'failed' | 'released';
export type RunStatus = 'running' | 'succeeded' | 'failed';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
}

/**
 * One step instance. `id` is its path: a top-level step id, or `<workflow step path>.<child step id>`
 * for a step inside a sub-workflow, such as `check.classify`.
 */
export interface StepState {
  id: string;
  status: StepStatus;
  attempt?: string;
  lease?: StepLease;
  outcome?: StepOutcome;
  outputs?: unknown;
  /** The values `with` passed to the workflow this step runs, kept when that workflow declares inputs. */
  inputs?: Record<string, unknown>;
  /** The end the workflow this step runs reached. */
  end?: string;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
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
  /** The validated `--inputs`, stored when the workflow declares inputs. */
  inputs?: Record<string, unknown>;
  /** Covers `definition` and every workflow in `workflows`. */
  sourceHash: string;
  definition: WorkflowDefinition;
  /** The sub-workflows the run uses, by name, as they were cached when it started. */
  workflows?: Record<string, WorkflowDefinition>;
  /** Step instances in declaration order; a sub-workflow's steps follow the step that runs it. */
  steps: StepState[];
  settledAttempts: string[];
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
