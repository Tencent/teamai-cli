/** Command-only workflow types for the v1alpha1 subset. */

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
  command: string;
  output?: OutputSchema;
}

export interface WorkflowDefinition {
  schemaVersion: 'v1alpha1';
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface WorkflowDiagnostic {
  file: string;
  line: number;
  column: number;
  field: string;
  message: string;
}

export type StepStatus = 'pending' | 'leased' | 'succeeded' | 'failed';
export type StepOutcome = 'success' | 'failed' | 'released';
export type RunStatus = 'running' | 'succeeded' | 'failed';

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
  exitCode?: number;
  message?: string;
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
