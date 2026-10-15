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
  /** Other workflow files the scenario runs, by name. */
  workflows?: Record<string, string>;
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
    needs: [one]
    command: echo two
    output:
      ok: boolean
`;

const FAILED_DEPENDENCY = `schemaVersion: v1alpha1
name: build
description: A step whose dependency failed is skipped.
steps:
  - id: build
    command: echo build
  - id: test
    needs: [build]
    command: echo test
  - id: docs
    needs: []
    command: echo docs
`;

const RECOVERY = `schemaVersion: v1alpha1
name: build
description: A recovery step runs after the check it reads fails.
steps:
  - id: check
    command: echo check
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: echo label
  - id: ship
    needs: [check]
    command: echo ship
`;

const RENDERED_ENV = `schemaVersion: v1alpha1
name: build
description: A command receives an earlier output through env.
steps:
  - id: plan
    command: echo plan
    output:
      title: string
      files: [string]
  - id: label
    needs: [plan]
    command: node label.js
    env:
      TITLE: "{{ steps.plan.outputs.title }}"
      FILES: "{{ steps.plan.outputs.files }}"
      COUNT: 2
`;

const SUB_WORKFLOW = `schemaVersion: v1alpha1
name: build
description: A step runs another workflow.
steps:
  - id: check
    workflow: check
  - id: ship
    needs: [check]
    command: echo ship
`;

const CHECK = `schemaVersion: v1alpha1
name: check
description: The workflow build runs.
steps:
  - id: classify
    command: echo classify
`;

const PROMPT_WITH = `schemaVersion: v1alpha1
name: prompt-with
description: A prompt step reads its with values and keeps GitHub Actions text.
steps:
  - id: plan
    command: echo plan
    output:
      task: string
  - id: fix
    needs: [plan]
    prompt: "Fix {{ with.task }}; keep \${{ inputs.version }}."
    with:
      task: "{{ steps.plan.outputs.task }}"
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
    yaml: TWO_STEPS.replace('  - id: one\n    command: echo one\n', '').replace('    needs: [one]\n', ''),
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
  {
    name: 'skipped step is never leased',
    workflowName: 'build',
    yaml: FAILED_DEPENDENCY,
    operations: [
      { kind: 'next', saveAs: 'build', expect: { data: { lease: { step: 'build' } } } },
      { kind: 'report', lease: 'build', body: { outcome: 'failed' }, expect: { data: { step: { status: 'failed' } } } },
      { kind: 'next', saveAs: 'docs', expect: { data: { lease: { step: 'docs' } } } },
      { kind: 'report', lease: 'docs', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
  },
  {
    name: 'recovery runs after a failure',
    workflowName: 'build',
    yaml: RECOVERY,
    operations: [
      { kind: 'next', saveAs: 'check', expect: { data: { lease: { step: 'check' } } } },
      { kind: 'report', lease: 'check', body: { outcome: 'failed' }, expect: { data: { step: { status: 'failed' } } } },
      { kind: 'next', saveAs: 'label', expect: { data: { lease: { step: 'label' } } } },
      { kind: 'report', lease: 'label', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
  },
  {
    name: 'the lease carries a rendered env',
    workflowName: 'build',
    yaml: RENDERED_ENV,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      {
        kind: 'report',
        lease: 'plan',
        body: { outcome: 'success', outputs: { title: '$(touch pwned)', files: ['a.ts'] } },
        expect: { data: { step: { status: 'succeeded' } } },
      },
      {
        kind: 'next',
        saveAs: 'label',
        expect: { data: { lease: { step: 'label', command: 'node label.js', env: { TITLE: '$(touch pwned)', FILES: '["a.ts"]', COUNT: '2' } } } },
      },
    ],
  },
  {
    name: 'a sub-workflow step is leased by its path',
    workflowName: 'build',
    yaml: SUB_WORKFLOW,
    workflows: { check: CHECK },
    operations: [
      { kind: 'next', saveAs: 'classify', expect: { data: { lease: { step: 'check.classify', command: 'echo classify' } } } },
      { kind: 'report', lease: 'classify', body: { outcome: 'success' }, expect: { data: { step: { id: 'check.classify', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'ship', expect: { data: { lease: { step: 'ship' } } } },
      { kind: 'report', lease: 'ship', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
  },
  {
    name: 'a prompt step renders its with values',
    workflowName: 'prompt-with',
    yaml: PROMPT_WITH,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { task: 'the crash' } }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'fix', expect: { data: { lease: { step: 'fix', prompt: 'Fix the crash; keep ${{ inputs.version }}.' } } } },
    ],
  },
];
