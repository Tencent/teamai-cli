import type { DriverIdentity, WorkflowEnvelope } from './types.js';

export interface WorkflowClient {
  start(name: string): Promise<WorkflowEnvelope>;
  next(runId: string, driver: DriverIdentity): Promise<WorkflowEnvelope>;
  report(runId: string, body: unknown): Promise<WorkflowEnvelope>;
}

export interface ConformanceScenario {
  name: string;
  workflowName: string;
  yaml: string;
  operations: ConformanceOperation[];
}

export type ConformanceOperation =
  | { kind: 'next'; saveAs: string; expect: Record<string, unknown> }
  | {
    kind: 'report';
    lease?: string;
    attempt?: string;
    revision?: number;
    body: Record<string, unknown>;
    expect: Record<string, unknown>;
  };

const TWO_STEPS = `schemaVersion: v1alpha1
name: build
description: Exercise the workflow protocol.
steps:
  - id: one
    command: echo one
  - id: two
    command: echo two
    output:
      ok: boolean
`;

export const workflowConformanceScenarios: ConformanceScenario[] = [
  {
    name: 'two-step command success',
    workflowName: 'build',
    yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', lease: 'one', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded', outcome: 'success' } } } },
      { kind: 'next', saveAs: 'two', expect: { data: { lease: { step: 'two' } } } },
      {
        kind: 'report',
        lease: 'two',
        body: { outcome: 'success', outputs: { ok: true }, tool: 'claude', model: 'claude-sonnet', session: 'session-1', tokens: { input: 3, output: 2, cachedInput: 1 } },
        expect: { data: { step: { status: 'succeeded', outcome: 'success' } } },
      },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
  },
  {
    name: 'output mismatch fails the step',
    workflowName: 'build',
    yaml: TWO_STEPS.replace('  - id: one\n    command: echo one\n', ''),
    operations: [
      { kind: 'next', saveAs: 'step', expect: { data: { lease: { step: 'two' } } } },
      {
        kind: 'report',
        lease: 'step',
        body: { outcome: 'success', outputs: { ok: 'yes' } },
        expect: { data: { step: { status: 'failed', outcome: 'failed' } } },
      },
    ],
  },
  {
    name: 'repeated report',
    workflowName: 'build',
    yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'step', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', lease: 'step', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'report', lease: 'step', body: { outcome: 'success' }, expect: { error: { code: 'repeated_report' } } },
    ],
  },
  {
    name: 'wrong attempt',
    workflowName: 'build',
    yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'step', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', attempt: 'a00000000', revision: 1, body: { outcome: 'success' }, expect: { error: { code: 'wrong_attempt' } } },
    ],
  },
];
