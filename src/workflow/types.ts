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

export interface InlineWorkflow {
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  needs?: string[];
  if?: string;
  command?: string;
  env?: Record<string, string>;
  /** Resolved, revision-bound prompt text. */
  prompt?: string;
  /** Original team-repo-relative source path for a cached prompt. */
  promptFile?: string;
  agent?: string;
  workflow?: string | InlineWorkflow;
  with?: Record<string, unknown>;
  output?: OutputSchema;
  end?: string;
}

export interface WorkflowDefinition {
  schemaVersion: 'v1alpha1';
  name: string;
  description: string;
  inputs?: Record<string, OutputSchema>;
  outputs?: Record<string, string>;
  ends?: Record<string, 'succeeded' | 'failed'>;
  steps: WorkflowStep[];
}

export interface WorkflowDiagnostic {
  file: string;
  line: number;
  column: number;
  field: string;
  message: string;
  /** A key this version does not know. The cache must not keep an older runnable copy. */
  code?: 'unknown_key';
}

export type StepStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'skipped' | 'stopped';
export type StepOutcome = 'success' | 'failed' | 'released' | 'skipped' | 'stopped';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
}

export interface StepState {
  id: string;
  status: StepStatus;
  attempt?: string;
  lease?: StepLease;
  outcome?: StepOutcome;
  outputs?: unknown;
  end?: string;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
  subRun?: RunState;
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
  sourceHash: string;
  definition: WorkflowDefinition;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  settledEnd?: string;
  steps: StepState[];
  settledAttempts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CachedWorkflow {
  relativePath: string;
  sourceHash: string;
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
