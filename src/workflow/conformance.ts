import type { WorkflowEnvelope } from './types.js';

export interface WorkflowClient {
  start(name: string): Promise<WorkflowEnvelope>;
  next(runId: string, body: unknown): Promise<WorkflowEnvelope>;
  report(runId: string, body: unknown): Promise<WorkflowEnvelope>;
  /** Records an answer through the client's channel. */
  respond(runId: string, step: string, choice: string, options?: { note?: string; pass?: number; json?: unknown }): Promise<WorkflowEnvelope>;
  /** Reopens the target step's dependency cone. */
  retry(runId: string, step: string): Promise<WorkflowEnvelope>;
  /** Stops the run or the named step. */
  cancel(runId: string, step?: string): Promise<WorkflowEnvelope>;
}

export interface ConformanceScenario {
  name: string;
  workflowName: string;
  yaml: string;
  /** Other workflow files the scenario runs, by name. */
  workflows?: Record<string, string>;
  operations: ConformanceOperation[];
  /** Expected fields in the persisted run after all operations. */
  expectState?: Record<string, unknown>;
}

/**
 * `running` and `cancelled` name leases that earlier operations saved; `cancelled` must match exactly.
 * `absent` lists fields the lease must not carry.
 */
export type ConformanceOperation =
  | { kind: 'next'; saveAs: string; running?: string[]; canTakeLease?: boolean; hitl?: boolean; cancelled?: string[]; absent?: string[]; expect: Record<string, unknown> }
  | { kind: 'respond'; step: string; choice: string; note?: string; pass?: number; json?: unknown; expect: Record<string, unknown> }
  | { kind: 'retry'; step: string; expect: Record<string, unknown> }
  | { kind: 'cancel'; step?: string; expect: Record<string, unknown> }
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

const PROMPT_MODEL = `schemaVersion: v1alpha1
name: build
description: A prompt step lease carries its model and the default model as written.
defaults:
  model: fast
steps:
  - id: compile
    command: echo compile
  - id: plan
    needs: [compile]
    prompt: Plan it.
    model: strong
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

const PARALLEL_ROOTS = `schemaVersion: v1alpha1
name: build
description: Two roots a driver runs in parallel, then a join.
steps:
  - id: a
    command: echo a
  - id: b
    needs: []
    command: echo b
  - id: join
    needs: [a, b]
    command: echo join
`;

const END_WHILE_RUNNING = `schemaVersion: v1alpha1
name: build
description: A step reaches the end while another one runs.
ends:
  done: succeeded
steps:
  - id: slow
    command: echo slow
  - id: finish
    needs: []
    command: echo finish
    end: done
`;

const STEP_LOOP = `schemaVersion: v1alpha1
name: build
description: A fix sends the work back to review.
steps:
  - id: review
    command: echo review
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: echo fix
    loop: { back_to: review, max_iterations: 2 }
`;

const BREAK_LOOP = `schemaVersion: v1alpha1
name: build
description: Probe until ready while a slow check runs beside it.
loop: { max_iterations: 3 }
steps:
  - id: slow
    command: echo slow
  - id: probe
    needs: []
    command: echo probe
    output:
      ready: boolean
    break: steps.probe.outputs.ready
`;

const FAN_OUT = `schemaVersion: v1alpha1
name: build
description: Build each target the plan lists, two at a time.
steps:
  - id: plan
    command: echo plan
    output:
      targets: [string]
  - id: build
    needs: [plan]
    for_each: { items: steps.plan.outputs.targets, max_parallel: 2 }
    command: echo build
    env:
      TARGET: "{{ item }}"
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
    name: 'report with an unread payload field lists it in ignored',
    workflowName: 'build',
    yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      {
        kind: 'report',
        lease: 'one',
        body: { outcome: 'success', tokenz: {} },
        expect: { data: { accepted: true, ignored: ['tokenz'] } },
      },
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
  {
    name: 'a prompt step lease carries model and defaultModel as written, and a command step lease neither',
    workflowName: 'build',
    yaml: PROMPT_MODEL,
    operations: [
      { kind: 'next', saveAs: 'compile', absent: ['model', 'defaultModel'], expect: { data: { lease: { step: 'compile' } } } },
      { kind: 'report', lease: 'compile', body: { outcome: 'success' }, expect: { data: { step: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan', model: 'strong', defaultModel: 'fast' } } } },
    ],
  },
  {
    name: 'a driver that lists its running attempts gets parallel leases',
    workflowName: 'build',
    yaml: PARALLEL_ROOTS,
    operations: [
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'a' }, cancelled: [] } } },
      { kind: 'next', saveAs: 'b', running: ['a'], expect: { data: { lease: { step: 'b' }, cancelled: [] } } },
      { kind: 'next', saveAs: 'wait', running: ['a', 'b'], expect: { data: { wait: { reason: 'a is leased' }, cancelled: [] } } },
      { kind: 'next', saveAs: 'reconcile', running: ['a', 'b'], canTakeLease: false, expect: { data: { wait: { reason: 'a is leased' } } } },
      { kind: 'next', saveAs: 'again', running: ['b'], expect: { data: { lease: { step: 'a' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success' }, expect: { data: { step: { id: 'a', status: 'succeeded' } } } },
    ],
  },
  {
    name: 'a report of a sibling does not make a parallel attempt stale',
    workflowName: 'build',
    yaml: PARALLEL_ROOTS,
    operations: [
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'a', revision: 1 } } } },
      { kind: 'next', saveAs: 'b', running: ['a'], expect: { data: { lease: { step: 'b', revision: 1 } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success' }, expect: { data: { revision: 2, step: { id: 'a', status: 'succeeded' } } } },
      { kind: 'report', lease: 'b', body: { outcome: 'success' }, expect: { data: { revision: 3, step: { id: 'b', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'join', expect: { data: { lease: { step: 'join', revision: 3 } } } },
    ],
  },
  {
    name: 'an end cancels a running lease, and its report is lease_cancelled',
    workflowName: 'build',
    yaml: END_WHILE_RUNNING,
    operations: [
      { kind: 'next', saveAs: 'slow', expect: { data: { lease: { step: 'slow' } } } },
      { kind: 'next', saveAs: 'finish', running: ['slow'], expect: { data: { lease: { step: 'finish' } } } },
      { kind: 'report', lease: 'finish', body: { outcome: 'success' }, expect: { data: { step: { id: 'finish', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', running: ['slow'], cancelled: ['slow'], expect: { data: { done: { outcome: 'succeeded', end: 'done' } } } },
      { kind: 'next', saveAs: 'again', running: ['slow'], cancelled: ['slow'], expect: { data: { done: { outcome: 'succeeded', end: 'done' } } } },
      { kind: 'report', lease: 'slow', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
  },
  {
    name: 'a report after an earlier end is lease_cancelled before next',
    workflowName: 'build',
    yaml: END_WHILE_RUNNING,
    operations: [
      { kind: 'next', saveAs: 'slow', expect: { data: { lease: { step: 'slow' } } } },
      { kind: 'next', saveAs: 'finish', running: ['slow'], expect: { data: { lease: { step: 'finish' } } } },
      { kind: 'report', lease: 'finish', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'report', lease: 'slow', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded', end: 'done' } } } },
      { kind: 'report', lease: 'slow', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
  },
  {
    name: 'a step loop leases its range again, and each lease names its pass',
    workflowName: 'build',
    yaml: STEP_LOOP,
    operations: [
      { kind: 'next', saveAs: 'review1', cancelled: [], expect: { data: { lease: { step: 'review', pass: 1 } } } },
      { kind: 'report', lease: 'review1', body: { outcome: 'success', outputs: { verdict: 'fix' } }, expect: { data: { step: { id: 'review', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'fix', cancelled: [], expect: { data: { lease: { step: 'fix', pass: 1 } } } },
      { kind: 'report', lease: 'fix', body: { outcome: 'success' }, expect: { data: { step: { id: 'fix', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'review2', cancelled: [], expect: { data: { lease: { step: 'review', pass: 2 } } } },
      { kind: 'report', lease: 'review2', body: { outcome: 'success', outputs: { verdict: 'pass' } }, expect: { data: { step: { id: 'review', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', cancelled: [], expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
  },
  {
    name: 'a looping workflow runs every step again each round, and a break ends it and cancels what still runs',
    workflowName: 'build',
    yaml: BREAK_LOOP,
    operations: [
      { kind: 'next', saveAs: 'slow1', cancelled: [], expect: { data: { lease: { step: 'slow', pass: 1 } } } },
      { kind: 'next', saveAs: 'probe1', running: ['slow1'], cancelled: [], expect: { data: { lease: { step: 'probe', pass: 1 } } } },
      { kind: 'report', lease: 'probe1', body: { outcome: 'success', outputs: { ready: false } }, expect: { data: { step: { id: 'probe', status: 'succeeded' } } } },
      { kind: 'report', lease: 'slow1', body: { outcome: 'success' }, expect: { data: { step: { id: 'slow', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'slow2', cancelled: [], expect: { data: { lease: { step: 'slow', pass: 2 } } } },
      { kind: 'next', saveAs: 'probe2', running: ['slow2'], cancelled: [], expect: { data: { lease: { step: 'probe', pass: 2 } } } },
      { kind: 'report', lease: 'probe2', body: { outcome: 'success', outputs: { ready: true } }, expect: { data: { step: { id: 'probe', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', running: ['slow2'], cancelled: ['slow2'], expect: { data: { done: { outcome: 'succeeded' } } } },
      { kind: 'report', lease: 'slow2', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
  },
  {
    name: 'a for_each leases its items in parallel up to max_parallel, and a failed item cancels none of them',
    workflowName: 'build',
    yaml: FAN_OUT,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { targets: ['a', 'b', 'c'] } }, expect: { data: { step: { id: 'plan', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'a', cancelled: [], expect: { data: { lease: { step: 'build[0]', env: { TARGET: 'a' } } } } },
      { kind: 'next', saveAs: 'b', running: ['a'], cancelled: [], expect: { data: { lease: { step: 'build[1]', env: { TARGET: 'b' } } } } },
      { kind: 'next', saveAs: 'full', running: ['a', 'b'], cancelled: [], expect: { data: { wait: { reason: 'build[0] is leased' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'failed' }, expect: { data: { step: { id: 'build[0]', status: 'failed' } } } },
      { kind: 'next', saveAs: 'c', running: ['b'], cancelled: [], expect: { data: { lease: { step: 'build[2]', env: { TARGET: 'c' } } } } },
      { kind: 'report', lease: 'b', body: { outcome: 'success' }, expect: { data: { step: { id: 'build[1]', status: 'succeeded' } } } },
      { kind: 'report', lease: 'c', body: { outcome: 'success' }, expect: { data: { step: { id: 'build[2]', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', cancelled: [], expect: { data: { done: { outcome: 'failed' } } } },
    ],
  },
];


function controlsYaml(steps: string): string {
  return `schemaVersion: v1alpha1\nname: build\ndescription: Exercise manual controls.\nsteps:\n${steps}\n`;
}
const APPROVE = controlsYaml('  - id: work\n    approve: Build it?\n    command: echo work\n  - id: later\n    needs: [work]\n    command: echo later');
const CHOOSE = controlsYaml(`  - id: decide
    choose: { message: Pick one, options: [build, revise] }
    loop: { back_to: decide, while: "steps.decide.choice == 'revise'", max_iterations: 3 }
  - id: work
    needs: [decide]
    if: steps.decide.choice == 'build'
    command: echo work`);
workflowConformanceScenarios.push(
  {
    name: 'interactive hand-back refuses a driver that no longer has HITL', workflowName: 'build', yaml: controlsYaml('  - id: pair\n    prompt: Work together.\n    interactive: true'),
    operations: [
      { kind: 'next', saveAs: 'pair', hitl: true, expect: { data: { lease: { step: 'pair', interactive: true } } } },
      { kind: 'next', saveAs: 'done', hitl: false, expect: { data: { done: { outcome: 'failed' } } } },
      { kind: 'report', lease: 'pair', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
    ],
    expectState: { steps: [{ id: 'pair', status: 'failed', failure: { code: 'hitl_required' } }] },
  },
  {
    name: 'retry after the final failure does not provisionally finish the run', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', lease: 'one', body: { outcome: 'failed' }, expect: { data: { accepted: true } } },
      { kind: 'retry', step: 'one', expect: { data: { reopened: false, retried: { pass: 2 }, run: { status: 'running' } } } },
      { kind: 'next', saveAs: 'again', expect: { data: { lease: { step: 'one', pass: 2 } } } },
    ],
  },
  {
    name: 'HITL approve then respond and repeated response', workflowName: 'build', yaml: APPROVE + '  - id: parallel\n    needs: []\n    command: echo parallel\n',
    operations: [
      { kind: 'next', saveAs: 'parallel', hitl: true, expect: { data: { lease: { step: 'parallel' } } } },
      { kind: 'next', saveAs: 'hitl', hitl: true, canTakeLease: false, running: ['parallel'], expect: { data: { hitl: { step: 'work', kind: 'approve', pass: 1, options: ['yes', 'no'] } } } },
      { kind: 'next', saveAs: 'busy', canTakeLease: false, running: ['parallel'], expect: { data: { wait: { reason: 'parallel is leased' } } } },
      { kind: 'respond', step: 'work', choice: 'yes', pass: 1, expect: { data: { answered: { step: 'work', choice: 'yes', channel: 'cli' }, run: { revision: 1 } } } },
      { kind: 'respond', step: 'work', choice: 'no', expect: { error: { code: 'repeated_response' } } },
      { kind: 'next', saveAs: 'work', hitl: true, running: ['parallel'], expect: { data: { lease: { step: 'work' } } } },
    ],
  },
  {
    name: 'refused approve skips and can be answered again', workflowName: 'build', yaml: APPROVE,
    operations: [
      { kind: 'next', saveAs: 'hitl', hitl: true, expect: { data: { hitl: { step: 'work' } } } },
      { kind: 'respond', step: 'work', choice: 'no', expect: { data: { run: { status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
      { kind: 'retry', step: 'work', expect: { data: { retried: { pass: 2 }, reopened: true } } },
      { kind: 'next', saveAs: 'hitl2', hitl: true, expect: { data: { hitl: { step: 'work', pass: 2 } } } },
      { kind: 'respond', step: 'work', choice: 'yes', pass: 2, expect: { data: { answered: { choice: 'yes' } } } },
      { kind: 'next', saveAs: 'work', hitl: true, expect: { data: { lease: { step: 'work' } } } },
    ],
  },
  {
    name: 'optional approve without HITL skips', workflowName: 'build', yaml: APPROVE,
    operations: [{ kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } }],
  },
  {
    name: 'required approve refuses drivers without HITL and agent answers', workflowName: 'build', yaml: APPROVE.replace('approve: Build it?', 'approve: { message: Build it?, required: true }'),
    operations: [
      { kind: 'next', saveAs: 'hitl', hitl: true, expect: { data: { hitl: { required: true } } } },
      { kind: 'respond', step: 'work', choice: 'yes', expect: { error: { code: 'agent_in_path' } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [{ id: 'work', status: 'failed', failure: { code: 'hitl_required' } }, { id: 'later', status: 'skipped' }] },
  },
  {
    name: 'choose exposes choice and rejects stale pass', workflowName: 'build', yaml: CHOOSE,
    operations: [
      { kind: 'next', saveAs: 'hitl', hitl: true, expect: { data: { hitl: { step: 'decide', pass: 1 } } } },
      { kind: 'respond', step: 'decide', choice: 'revise', pass: 1, note: 'Again', expect: { data: { answered: { pass: 1, choice: 'revise' } } } },
      { kind: 'next', saveAs: 'hitl2', hitl: true, expect: { data: { hitl: { pass: 2 } } } },
      { kind: 'respond', step: 'decide', choice: 'build', pass: 1, expect: { error: { code: 'stale_response' } } },
      { kind: 'respond', step: 'decide', choice: 'build', pass: 2, expect: { data: { answered: { pass: 2, choice: 'build' } } } },
      { kind: 'next', saveAs: 'work', hitl: true, expect: { data: { lease: { step: 'work' } } } },
      { kind: 'retry', step: 'decide', expect: { data: { retried: { pass: 3 } } } },
      { kind: 'next', saveAs: 'hitl3', hitl: true, expect: { data: { hitl: { pass: 3 } } } },
    ],
  },
  {
    name: 'cancel leased work invalidates its report', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'cancel', step: 'one', expect: { data: { run: { status: 'failed' } } } },
      { kind: 'report', lease: 'one', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'next', saveAs: 'done', running: ['one'], cancelled: ['one'], expect: { data: { done: { outcome: 'failed' } } } },
    ],
  },
  {
    name: 'cancel pending work skips dependents', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'cancel', step: 'two', expect: { data: { run: { status: 'running' } } } },
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', lease: 'one', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
  },
  {
    name: 'retry failed work reopens its run and skipped dependents', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'report', lease: 'one', body: { outcome: 'failed' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
      { kind: 'retry', step: 'one', expect: { data: { retried: { pass: 2 }, reopened: true } } },
      { kind: 'next', saveAs: 'again', expect: { data: { lease: { step: 'one', pass: 2, revision: 3 } } } },
      { kind: 'report', lease: 'again', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'two', expect: { data: { lease: { step: 'two', pass: 1 } } } },
    ],
  },
  {
    name: 'retry stuck lease invalidates its old report', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'one', expect: { data: { lease: { step: 'one' } } } },
      { kind: 'retry', step: 'one', expect: { data: { retried: { pass: 2 }, reopened: false } } },
      { kind: 'report', lease: 'one', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'next', saveAs: 'again', running: ['one'], cancelled: ['one'], expect: { data: { lease: { step: 'one', pass: 2 } } } },
    ],
  },
  {
    name: 'interactive work requires a driver with HITL', workflowName: 'build', yaml: controlsYaml('  - id: pair\n    prompt: Work together.\n    interactive: true'),
    operations: [
      { kind: 'next', saveAs: 'hitl', hitl: true, expect: { data: { lease: { step: 'pair', interactive: true } } } },
      { kind: 'retry', step: 'pair', expect: { data: { retried: { pass: 2 } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { steps: [{ id: 'pair', status: 'failed', failure: { code: 'hitl_required' } }] },
  },
  {
    name: 'whole run cancel has its own outcome', workflowName: 'build', yaml: TWO_STEPS,
    operations: [
      { kind: 'cancel', expect: { data: { run: { status: 'cancelled' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'cancelled' } } } },
    ],
  },
);


workflowConformanceScenarios.push({
  name: 'a driver UI answers a required HITL request',
  workflowName: 'build',
  yaml: APPROVE.replace('approve: Build it?', 'approve: { message: Build it?, required: true }'),
  operations: [
    { kind: 'next', saveAs: 'hitl', hitl: true, expect: { data: { hitl: { required: true } } } },
    { kind: 'respond', step: 'work', choice: 'yes', json: null, expect: { error: { code: 'invalid_json' } } },
    { kind: 'respond', step: 'work', choice: 'yes', json: { driver: { kind: 'ide' } }, expect: { error: { code: 'invalid_json' } } },
    { kind: 'respond', step: 'work', choice: 'yes', json: { driver: { kind: '', machine: 'host', workspace: '/ui' } }, expect: { error: { code: 'invalid_json' } } },
    { kind: 'respond', step: 'work', choice: 'yes', pass: 1, note: 'Person approved in the UI',
      json: { driver: { kind: 'ide', machine: 'host', workspace: '/ui', can: { hitl: true }, extra: 'private' }, extra: 'private' },
      expect: { data: { answered: { choice: 'yes', channel: 'driver' }, ignored: ['extra', 'driver.extra'] } } },
    { kind: 'respond', step: 'work', choice: 'no', json: { driver: { kind: 'ide', machine: 'host', workspace: '/ui' } }, expect: { error: { code: 'repeated_response' } } },
    { kind: 'next', saveAs: 'work', hitl: true, expect: { data: { lease: { step: 'work' } } } },
  ],
  expectState: { steps: [{ id: 'work', status: 'leased', answer: { choice: 'yes', channel: 'driver', agent: false,
    note: 'Person approved in the UI', driver: { kind: 'ide', machine: 'host', workspace: '/ui' } } }, { id: 'later', status: 'pending' }] },
});
