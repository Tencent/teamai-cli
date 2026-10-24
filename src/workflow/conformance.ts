import { PARALLEL_ROOTS, controlsYaml, type ConformanceScenario } from './conformance-interpreter.js';
import { limitsConformanceScenarios } from './limits-conformance.js';

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

const REVIEW_LINK = `schemaVersion: v1alpha1
name: review-link
description: A remote driver reports a review link.
steps:
  - id: work
    workspace: new
    command: echo work
`;

const REPORTED_PR = `schemaVersion: v1alpha1
name: reported-pr
description: A remote driver opens the pull request of the branch it worked on and reports it.
steps:
  - id: work
    workspace: new
    command: echo work
    deliver: pr
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

const SESSION_FROM = `schemaVersion: v1alpha1
name: build
description: Steps that resume the plan's session.
steps:
  - id: plan
    prompt: Plan.
  - id: build
    needs: [plan]
    prompt: Build.
    session: { from: plan }
  - id: check
    needs: [build]
    prompt: Check.
    session: { from: plan }
`;

/** Every protocol scenario a driver must pass, the ones each concern keeps in its own file included. */
export const workflowConformanceScenarios: ConformanceScenario[] = [
  {
    name: 'a pull request a driver reports is kept, without its query or fragment, for the step to deliver',
    workflowName: 'reported-pr', yaml: REPORTED_PR,
    operations: [
      { kind: 'next', saveAs: 'work', base: { ref: 'main', commit: 'a'.repeat(40) }, expect: { data: { lease: { step: 'work' } } } },
      { kind: 'report', lease: 'work', changes: { pr_url: 'https://review.example/changes/1?session=private#note', unknown: 'private' }, body: { outcome: 'success' }, expect: { data: { accepted: true, step: { id: 'work', status: 'delivering', outcome: 'success' }, ignored: ['changes.unknown'] } } },
    ],
    expectState: { steps: [{ id: 'work', status: 'delivering', delivery: { reported: 'https://review.example/changes/1' } }] },
  },
  {
    name: 'an unsafe review URL is dropped without rejecting the report', workflowName: 'review-link', yaml: REVIEW_LINK,
    operations: [
      { kind: 'next', saveAs: 'work', base: { ref: 'main', commit: 'a'.repeat(40) }, expect: { data: { lease: { step: 'work' } } } },
      { kind: 'report', lease: 'work', changes: { pr_url: 'https://user:token@review.example/changes/1' }, body: { outcome: 'success' }, expect: { data: { accepted: true, dropped: [{ field: 'changes.pr_url', reason: 'contains credentials' }] } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
  },
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
    expectState: { steps: [{ id: 'one', status: 'succeeded' }, {
      id: 'two', status: 'succeeded', outcome: 'success', outputs: { ok: true }, tool: 'claude', model: 'claude-sonnet', session: 'session-1',
      tokens: { input: 3, output: 2, cachedInput: 1 },
    }] },
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
    expectState: { steps: [{ id: 'two', status: 'failed', failure: { code: 'invalid_output', message: 'stdout JSON does not match output: output.ok must be a boolean' } }] },
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
    // A claim refused here is refused for any driver: the run was started on this install and never published.
    name: 'a claim of a run nobody published is refused each time and leaves the run as it was',
    workflowName: 'build',
    yaml: TWO_STEPS,
    operations: [
      { kind: 'next', saveAs: 'claim', claim: true, expect: { error: {} } },
      { kind: 'next', saveAs: 'again', claim: true, expect: { error: {} } },
      { kind: 'next', saveAs: 'step', expect: { data: { lease: { step: 'one' } } } },
    ],
    expectState: { steps: [{ id: 'one', status: 'leased' }, { id: 'two', status: 'pending' }] },
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
  {
    name: 'a step that resumed a session in a copy hands the copy to the next step that resumes it',
    workflowName: 'build',
    yaml: SESSION_FROM,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', tool: 'claude', session: 'plan-1' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'build', absent: ['session.earlier'], expect: { data: { lease: { step: 'build', session: { tool: 'claude', id: 'plan-1' } } } } },
      {
        kind: 'report',
        lease: 'build',
        body: { outcome: 'success', tool: 'codex', session: 'copy-1', resumed: { tool: 'claude', id: 'plan-1' } },
        expect: { data: { accepted: true } },
      },
      {
        kind: 'next',
        saveAs: 'check',
        expect: { data: { lease: { step: 'check', session: { tool: 'codex', id: 'copy-1', earlier: [{ tool: 'claude', id: 'plan-1' }] } } } },
      },
    ],
  },
  {
    name: 'a report that resumed a session the run does not know is refused',
    workflowName: 'build',
    yaml: SESSION_FROM,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', tool: 'claude', session: 'plan-1' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'build', expect: { data: { lease: { step: 'build' } } } },
      {
        kind: 'report',
        lease: 'build',
        body: { outcome: 'success', tool: 'codex', session: 'copy-1', resumed: { tool: 'claude', id: 'plan-0' } },
        expect: { error: { code: 'invalid_report' } },
      },
      {
        kind: 'report',
        lease: 'build',
        body: { outcome: 'success', tool: 'codex', session: 'copy-1', resumed: { tool: 'codex', id: 'plan-1' } },
        expect: { error: { code: 'invalid_report' } },
      },
    ],
  },
  {
    name: 'a report that resumed a session for a step that resumes none is refused',
    workflowName: 'build',
    yaml: SESSION_FROM,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      {
        kind: 'report',
        lease: 'plan',
        body: { outcome: 'success', tool: 'claude', session: 'plan-1', resumed: { tool: 'claude', id: 'plan-1' } },
        expect: { error: { code: 'invalid_report' } },
      },
    ],
  },
  {
    name: 'a step that started a new session leaves the next step resuming the session it was leased',
    workflowName: 'build',
    yaml: SESSION_FROM,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', tool: 'claude', session: 'plan-1' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'build', expect: { data: { lease: { step: 'build', session: { tool: 'claude', id: 'plan-1' } } } } },
      { kind: 'report', lease: 'build', body: { outcome: 'success', tool: 'opencode', session: 'ses_new' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'check', expect: { data: { lease: { step: 'check', session: { tool: 'claude', id: 'plan-1' } } } } },
    ],
  },
];

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
    name: 'interactive hand-back to a driver that no longer has HITL releases the lease and waits', workflowName: 'build', yaml: controlsYaml('  - id: pair\n    prompt: Work together.\n    interactive: true'),
    operations: [
      { kind: 'next', saveAs: 'pair', hitl: true, expect: { data: { lease: { step: 'pair', interactive: true } } } },
      { kind: 'next', saveAs: 'held', hitl: false, expect: { data: { wait: { held: [{ step: 'pair', missing: ['hitl'] }] } } } },
      { kind: 'report', lease: 'pair', body: { outcome: 'success' }, expect: { error: { code: 'lease_cancelled' } } },
      { kind: 'next', saveAs: 'again', hitl: true, expect: { data: { lease: { step: 'pair', interactive: true } } } },
    ],
    expectState: { status: 'running', steps: [{ id: 'pair', status: 'leased' }] },
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
      { kind: 'next', saveAs: 'busy', canTakeLease: false, running: ['parallel'], expect: { data: { wait: { reason: 'parallel is leased' } } },
        state: { steps: [{ id: 'work', status: 'waiting' }, { id: 'later', status: 'pending' }, { id: 'parallel', status: 'leased' }] } },
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
    name: 'interactive work waits for a driver with HITL', workflowName: 'build', yaml: controlsYaml('  - id: pair\n    prompt: Work together.\n    interactive: true'),
    operations: [
      { kind: 'next', saveAs: 'held', as: 'external', expect: { data: { wait: {
        reason: 'step "pair" needs hitl, which this driver does not declare',
        held: [{ step: 'pair', reason: 'step "pair" needs hitl, which this driver does not declare', missing: ['hitl'] }],
      } } } },
      { kind: 'next', saveAs: 'local', expect: { data: { wait: { held: [{ step: 'pair', missing: ['hitl'] }] } } } },
      { kind: 'next', saveAs: 'pair', as: 'session', expect: { data: { lease: { step: 'pair', interactive: true } } } },
    ],
    expectState: { status: 'running', steps: [{ id: 'pair', status: 'leased', lease: { driver: { kind: 'session' } } }] },
  },
  {
    name: 'a held step does not block a ready sibling', workflowName: 'build',
    yaml: controlsYaml('  - id: pair\n    prompt: Work together.\n    interactive: true\n  - id: build\n    needs: []\n    command: echo build'),
    operations: [
      { kind: 'next', saveAs: 'build', as: 'external', expect: { data: { lease: { step: 'build' } } } },
      { kind: 'report', lease: 'build', as: 'external', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'held', as: 'external', expect: { data: { wait: { held: [{ step: 'pair', missing: ['hitl'] }] } } } },
    ],
    expectState: { status: 'running', steps: [{ id: 'pair', status: 'pending' }, { id: 'build', status: 'succeeded' }] },
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

workflowConformanceScenarios.push(...limitsConformanceScenarios);

/** A value a scenario reads from the run once it is done: its base, or what a step reported in `changes`. */
export type GitConformanceName = 'base.commit' | 'base.ref' | `steps.${string}.commit` | `steps.${string}.branch`;

/**
 * A git-level case for any driver that takes workspace leases. The runner makes a bare `origin` whose `main` has one
 * commit and clones it twice: a checkout of another machine, and the checkout the driver under test runs in. It starts
 * the run with its base on `main`: origin's tip, or with `base: 'elsewhere'` a commit only the other machine has. A
 * driver of that machine then runs the `elsewhere` steps through `next` and `report`, the driver under test drives the
 * run from its checkout until it ends, and the runner checks the persisted run and origin. With `handoff`, the other
 * machine has an install of its own: it starts the run there and publishes it after its steps, and the driver under
 * test claims the run before it drives it.
 */
export interface GitConformanceScenario {
  name: string;
  workflowName: string;
  yaml: string;
  base: 'origin' | 'elsewhere';
  /**
   * Steps the other machine runs first, in this order, each the next step `next` leases it with no merges. It commits
   * `files` on the leased branch from `start`, pushes that branch to origin unless `push` is false, and reports success
   * with that commit as `changes`.
   */
  elsewhere?: Array<{ step: string; files: Record<string, string>; push: boolean }>;
  /** Origin refuses every push once the `elsewhere` steps ran. */
  refusePushes?: true;
  /** The run reaches the driver under test through a publish on the other machine and a claim on its own. */
  handoff?: true;
  /** Expected fields in the persisted run after the driver under test is done. */
  expectState: Record<string, unknown>;
  /** By step id: the step's reported `changes.to` is the tip of `changes.branch` on origin, and that tip holds these files. */
  expectPushed?: Record<string, Record<string, string>>;
  /** The step's `message` contains each named value as a whole word, and its `failure.code` is not `codeIsNot`. */
  expectFailure?: { step: string; names: GitConformanceName[]; codeIsNot?: string };
}

const FAILING_WRITER = `schemaVersion: v1alpha1
name: build
description: A step commits a file and then fails.
steps:
  - id: broken
    workspace: new
    command: node -e "require('fs').writeFileSync('broken.txt', 'B'); process.exit(1)"
`;

const JOIN = `schemaVersion: v1alpha1
name: build
description: A step starts from one branch and merges another.
steps:
  - id: right
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('joined.txt', 'J')"
`;

const CONTINUED = `schemaVersion: v1alpha1
name: build
description: Two changes made one after another in one copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: node -e "require('fs').writeFileSync('write.txt', 'W')"
        - id: more
          needs: [write]
          workspace: continue
          command: node -e "require('fs').writeFileSync('more.txt', 'M')"
`;

/**
 * The git rules every driver keeps: it pushes the commits it reports before it reports them, failed steps included,
 * and it fetches the run's branches for a lease commit its checkout lacks, or fails `workspace_base` naming it. A run
 * it claims carries its base and its copies on those branches.
 */
export const workflowGitConformanceScenarios: GitConformanceScenario[] = [
  {
    name: 'a step that fails pushes the commits it reports',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'origin',
    expectState: { steps: [{ id: 'broken', status: 'failed' }] },
    expectPushed: { broken: { 'broken.txt': 'B' } },
  },
  {
    name: 'a step that fails keeps its own failure when origin refuses the push, and names the branch it could not push',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'origin',
    refusePushes: true,
    expectState: { steps: [{ id: 'broken', status: 'failed', changes: {} }] },
    expectFailure: { step: 'broken', names: ['steps.broken.branch'], codeIsNot: 'push_failed' },
  },
  {
    name: 'a step whose start, merge, and base commits are only on the run branches of origin fetches them',
    workflowName: 'build',
    yaml: JOIN,
    base: 'elsewhere',
    elsewhere: [{ step: 'right', files: { 'right.txt': 'R' }, push: true }, { step: 'left', files: { 'left.txt': 'L' }, push: true }],
    expectState: { steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'succeeded' }] },
    expectPushed: { join: { 'left.txt': 'L', 'right.txt': 'R', 'joined.txt': 'J' } },
  },
  {
    name: 'a step whose merge commit is on no branch of origin fails workspace_base naming the commit and its branch',
    workflowName: 'build',
    yaml: JOIN,
    base: 'origin',
    elsewhere: [{ step: 'right', files: { 'right.txt': 'R' }, push: false }],
    expectState: { steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'failed', failure: { code: 'workspace_base' } }] },
    expectPushed: { left: { 'left.txt': 'L' } },
    expectFailure: { step: 'join', names: ['steps.right.commit', 'steps.right.branch'] },
  },
  {
    name: 'a step whose base commit is on no branch of origin fails workspace_base naming the commit and its branch',
    workflowName: 'build',
    yaml: FAILING_WRITER,
    base: 'elsewhere',
    expectState: { steps: [{ id: 'broken', status: 'failed', failure: { code: 'workspace_base' } }] },
    expectFailure: { step: 'broken', names: ['base.commit', 'base.ref'] },
  },
  {
    name: 'a claimed run whose base only the publishing machine had starts its copies from that base',
    workflowName: 'build',
    yaml: JOIN,
    base: 'elsewhere',
    handoff: true,
    expectState: { status: 'succeeded', steps: [{ id: 'right', status: 'succeeded' }, { id: 'left', status: 'succeeded' }, { id: 'join', status: 'succeeded' }] },
    expectPushed: { join: { 'elsewhere.txt': 'only on the other machine', 'left.txt': 'L', 'right.txt': 'R', 'joined.txt': 'J' } },
  },
  {
    name: 'a claimed run continues a copy from the commit the publishing machine recorded',
    workflowName: 'build',
    yaml: CONTINUED,
    base: 'elsewhere',
    elsewhere: [{ step: 'change.write', files: { 'write.txt': 'W' }, push: true }],
    handoff: true,
    expectState: { status: 'succeeded', steps: [{ id: 'change', status: 'succeeded' }, { id: 'change.write', status: 'succeeded' }, { id: 'change.more', status: 'succeeded' }] },
    expectPushed: { 'change.more': { 'elsewhere.txt': 'only on the other machine', 'write.txt': 'W', 'more.txt': 'M' } },
  },
];

/** What a run holds once a delivery case ends, over every install that drove it. */
export interface DeliveryExpectation {
  /** Pull requests TeamAI asked the host to open. */
  creates: number;
  run: 'succeeded' | 'failed' | 'cancelled';
  work: 'succeeded' | 'failed' | 'cancelled';
  /** The pull requests the run lists in `deliveries` and its end record's `prs`. */
  prs: number;
  /** The failure code of `work`, whose message then names its branch. */
  failure?: string;
}

/**
 * A delivery case for every driver that takes workspace leases, run against `deliveryConformanceWorkflow` with a fake
 * provider every case shares. The runner gives the product an `https://github.com/<owner>/<repo>` origin that git
 * rewrites to a bare repository, and a fake `gh` that records each create and answers lookups from what it recorded.
 * With `hold`, the fake waits inside that call, a create once it recorded the request, until the runner has done
 * `action`: `crash` kills the process the call came from, and the driver calls `next` again; `publish` publishes the
 * run and kills that process, and a driver of a second install with its own checkout claims the run and drives it;
 * `cancel` cancels the run; `poll` holds a delivery that another process of the machine started after `work` reported,
 * while the driver under test calls `next`. A driver whose delivery never reaches `hold` runs to the end untouched.
 * `unreachable` fails every lookup. `opened` is expected of a driver that leaves the pull request to TeamAI, `reported`
 * of one that reports its own as `changes.pr_url`. After every case, `work`'s branch is on origin at its reported commit.
 */
export interface DeliveryConformanceScenario {
  name: string;
  hold?: { call: 'lookup' | 'create'; action: 'crash' | 'publish' | 'cancel' | 'poll' };
  unreachable?: true;
  opened: DeliveryExpectation;
  reported: DeliveryExpectation;
}

/** `ship` copies what the host holds when it runs to `SHIP_SAW`, which the runner sets: the open requests by then. */
export const deliveryConformanceWorkflow = `schemaVersion: v1alpha1
name: deliver
description: A step delivers its branch as a pull request, and the step that needs it runs once it is delivered.
steps:
  - id: work
    workspace: new
    command: node -e "require('fs').writeFileSync('work.txt', 'W')"
    deliver: pr
  - id: ship
    needs: [work]
    command: node -e "require('fs').copyFileSync(process.env.SHIP_OPEN, process.env.SHIP_SAW)"
`;

const DELIVERED: DeliveryExpectation = { creates: 1, run: 'succeeded', work: 'succeeded', prs: 1 };
const REPORTED: DeliveryExpectation = { creates: 0, run: 'succeeded', work: 'succeeded', prs: 1 };

export const workflowDeliveryConformanceScenarios: DeliveryConformanceScenario[] = [
  {
    name: 'a delivered branch opens one pull request into the run base, and the step that needs it runs once it is delivered',
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a delivery whose process stops inside the create finds the pull request on the next call and opens no other',
    hold: { call: 'create', action: 'crash' },
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a run published while it delivers, and claimed by another install with its own checkout, opens one pull request',
    hold: { call: 'create', action: 'publish' },
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a run cancelled while its delivery looks for an open pull request opens none',
    hold: { call: 'lookup', action: 'cancel' },
    opened: { creates: 0, run: 'cancelled', work: 'cancelled', prs: 0 },
    reported: { creates: 0, run: 'cancelled', work: 'cancelled', prs: 0 },
  },
  {
    name: 'a run cancelled while its delivery opens the pull request lists it, and the step stays cancelled',
    hold: { call: 'create', action: 'cancel' },
    opened: { creates: 1, run: 'cancelled', work: 'cancelled', prs: 1 },
    reported: REPORTED,
  },
  {
    name: 'a delivery that cannot reach the host fails naming the branch, which stays on origin',
    unreachable: true,
    opened: { creates: 0, run: 'failed', work: 'failed', prs: 0, failure: 'delivery_failed' },
    reported: { creates: 0, run: 'failed', work: 'failed', prs: 0, failure: 'delivery_failed' },
  },
  {
    name: 'a driver polls while another process of its machine delivers, and gets the step that needs it once delivered',
    hold: { call: 'create', action: 'poll' },
    opened: DELIVERED,
    reported: REPORTED,
  },
];

export const judgeLeaseConformanceScenario = {
  name: 'a judge lease renews through running and settles only through score submission',
  yaml: `schemaVersion: v1alpha1
name: judged
description: A pass with a quality scorer.
steps:
  - id: work
    prompt: Review the change.
    scorers: [quality]
`,
  scorer: `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Missed the work }
passingScore: 0.5
samplingRate: 100
---
Judge the work.
`,
  operations: [
    { kind: 'take', at: '2026-10-22T12:00:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:30:00.000Z' } } } },
    { kind: 'renew', at: '2026-10-22T12:20:00.000Z', expect: { data: { idle: { open: 0, leased: 1 } } } },
    { kind: 'take', at: '2026-10-22T12:45:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:50:00.000Z', handedBack: true } } } },
    { kind: 'report', expect: { error: { code: 'judge_lease' } } },
    { kind: 'submit', expect: { data: { label: { label: 'good', score: 1, passed: true } } } },
    { kind: 'idle', at: '2026-10-22T12:46:00.000Z', expect: { data: { idle: { open: 0, leased: 0 } } } },
  ],
} as const;
