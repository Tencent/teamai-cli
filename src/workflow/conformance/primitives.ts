/** Scenarios for the generic keys any workflow uses, such as `continue_on_failure`: none is a branch for one feature. */
import { controlsYaml, type ConformanceScenario, type ScenarioJson } from '../conformance-interpreter.js';

const JUDGE_EACH = `schemaVersion: v1alpha1
name: build
description: Judge each target; a judge that fails does not fail the run.
outputs:
  verdicts: steps.judge.results
steps:
  - id: plan
    command: echo plan
    output:
      targets: [string]
  - id: judge
    needs: [plan]
    for_each: steps.plan.outputs.targets
    continue_on_failure: true
    command: echo judge
    output:
      label: string
  - id: ship
    needs: [judge]
    command: echo ship
  - id: note
    needs: [judge]
    if: steps.judge.outcome != 'success'
    command: echo note
`;

// Long enough that the CLI calls before the second item's lease never outlast it on a loaded machine; `advance` passes it.
const JUDGE_EACH_TIMED = JUDGE_EACH.replace('    continue_on_failure: true\n', '    continue_on_failure: true\n    timeout: 6s\n');

/** What a for_each step that kept the results of its items returns: the first item judged, the second stopped while leased. */
const KEPT_VERDICTS: ScenarioJson[] = [{ item: 'a', outcome: 'success', outputs: { label: 'good' } }, { item: 'b', outcome: 'cancelled' }];

const MODEL_EACH = `schemaVersion: v1alpha1
name: build
description: Label each group with the model its scorer names.
defaults:
  model: fast
steps:
  - id: plan
    command: echo plan
    output:
      groups: [{ name: string, model: string }]
  - id: label
    needs: [plan]
    for_each: steps.plan.outputs.groups
    prompt: Label {{ item.name }}.
    model: "{{ item.model }}"
`;

export const primitiveConformanceScenarios: ConformanceScenario[] = [
  {
    name: 'continue_on_failure: a for_each step whose item failed reads failed, its dependents follow the usual rules, and the run succeeds with its results',
    workflowName: 'build',
    yaml: JUDGE_EACH,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { targets: ['a', 'b'] } }, expect: { data: { step: { id: 'plan', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'judge[0]' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'failed' }, expect: { data: { step: { id: 'judge[0]', status: 'failed' } } } },
      { kind: 'next', saveAs: 'b', expect: { data: { lease: { step: 'judge[1]' } } } },
      { kind: 'report', lease: 'b', body: { outcome: 'success', outputs: { label: 'good' } }, expect: { data: { step: { id: 'judge[1]', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'note', expect: { data: { lease: { step: 'note' } } } },
      { kind: 'report', lease: 'note', body: { outcome: 'success' }, expect: { data: { step: { id: 'note', status: 'succeeded' } } } },
      {
        kind: 'next', saveAs: 'done',
        expect: { data: { done: { outcome: 'succeeded', outputs: { verdicts: [{ item: 'a', outcome: 'failed' }, { item: 'b', outcome: 'success', outputs: { label: 'good' } }] } } } },
      },
    ],
    expectState: { status: 'succeeded', steps: [{ id: 'plan', status: 'succeeded' }, { id: 'judge', status: 'failed' }, { id: 'judge[0]' }, { id: 'judge[1]' }, { id: 'ship', status: 'skipped' }, { id: 'note', status: 'succeeded' }] },
  },
  {
    name: 'continue_on_failure: a for_each step that times out keeps the results of the items that settled, and the run succeeds with them',
    workflowName: 'build',
    yaml: JUDGE_EACH_TIMED,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { targets: ['a', 'b'] } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'judge[0]' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success', outputs: { label: 'good' } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'b', expect: { data: { lease: { step: 'judge[1]' } } } },
      { kind: 'advance', ms: 7000 },
      { kind: 'next', saveAs: 'note', running: ['b'], cancelled: ['b'], expect: { data: { lease: { step: 'note' } } } },
      { kind: 'report', lease: 'note', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded', outputs: { verdicts: KEPT_VERDICTS } } } } },
    ],
    expectState: {
      status: 'succeeded',
      steps: [{ id: 'plan' }, { id: 'judge', status: 'failed', failure: { code: 'timeout' }, results: KEPT_VERDICTS }, { id: 'judge[0]' }, { id: 'judge[1]' }, { id: 'ship', status: 'skipped' }, { id: 'note', status: 'succeeded' }],
    },
  },
  {
    name: 'continue_on_failure: a for_each step cancelled by hand keeps the results of the items that settled, and the run succeeds with them',
    workflowName: 'build',
    yaml: JUDGE_EACH,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { targets: ['a', 'b'] } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'a', expect: { data: { lease: { step: 'judge[0]' } } } },
      { kind: 'report', lease: 'a', body: { outcome: 'success', outputs: { label: 'good' } }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'b', expect: { data: { lease: { step: 'judge[1]' } } } },
      { kind: 'cancel', step: 'judge', expect: { data: { cancelled: { steps: ['judge[1]', 'judge'] } } } },
      { kind: 'next', saveAs: 'note', expect: { data: { lease: { step: 'note' } } } },
      { kind: 'report', lease: 'note', body: { outcome: 'success' }, expect: { data: { accepted: true } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded', outputs: { verdicts: KEPT_VERDICTS } } } } },
    ],
    expectState: { status: 'succeeded', steps: [{ id: 'plan' }, { id: 'judge', status: 'cancelled', results: KEPT_VERDICTS }, { id: 'judge[0]' }, { id: 'judge[1]' }, { id: 'ship', status: 'skipped' }, { id: 'note', status: 'succeeded' }] },
  },
  {
    name: 'model template: each item\'s lease carries the model its template rendered, and an empty one carries no model, so the tool runs its default',
    workflowName: 'build',
    yaml: MODEL_EACH,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      {
        kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { groups: [{ name: 'tests', model: 'strong' }, { name: 'docs', model: '' }] } },
        expect: { data: { accepted: true } },
      },
      { kind: 'next', saveAs: 'tests', expect: { data: { lease: { step: 'label[0]', prompt: 'Label tests.', model: 'strong', defaultModel: 'fast' } } } },
      { kind: 'next', saveAs: 'docs', running: ['tests'], absent: ['model', 'defaultModel'], expect: { data: { lease: { step: 'label[1]', prompt: 'Label docs.' } } } },
    ],
  },
  {
    name: 'startedBy: a run started from a process without agent evidence records that a person started it',
    workflowName: 'build',
    yaml: controlsYaml('  - id: work\n    command: echo work'),
    operations: [],
    expectState: { startedBy: 'person' },
  },
  {
    name: 'startedBy: a run an agent session started records that an agent started it',
    workflowName: 'build',
    yaml: controlsYaml('  - id: work\n    command: echo work').replace('steps:\n', 'invoke: allow\nsteps:\n'),
    env: { CLAUDE_CODE_SESSION_ID: 'agent-1670' },
    operations: [],
    expectState: { startedBy: 'agent' },
  },
];
