/** Scenarios for a prompt step confined to a directory, `workspace: { confined }`, and the `can.confined` offers that take it. */
import type { ConformanceOperation, ConformanceScenario } from '../conformance-interpreter.js';
import type { DriverCan } from '../requirements.js';

const JUDGE = `schemaVersion: v1alpha1
name: judge
description: Judge a change from the evidence an earlier step wrote.
steps:
  - id: evidence
    command: ./evidence.sh
  - id: judge
    needs: [evidence]
    workspace: { confined: evidence }
    model: confined-judge
    prompt: Judge the change from the files here.
    output:
      verdict: pass | fail
`;

/** Each item writes its own evidence directory and judges from it, the directory read from the evidence step's output. */
const JUDGE_EACH = `schemaVersion: v1alpha1
name: judge
description: Judge each change from the evidence an earlier step of its item wrote.
steps:
  - id: plan
    command: ./plan.sh
    output:
      changes: [string]
  - id: score
    needs: [plan]
    for_each: steps.plan.outputs.changes
    workflow:
      steps:
        - id: evidence
          command: ./evidence.sh
          output: { dir: string }
        - id: judge
          needs: [evidence]
          workspace: { confined: "{{ steps.evidence.outputs.dir }}" }
          prompt: Judge {{ item }} from the files here.
          output:
            verdict: pass | fail
`;

/** A team alias only Codex runs, so a driver whose confined tools are Claude's has no model for the step. */
const ALIASES = { 'models/aliases.yaml': 'aliases:\n  confined-judge:\n    codex: gpt-6-astra\n' };

const VERIFIED_CLAUDE: NonNullable<DriverCan['confined']>[number] = { level: 'verified', access: 'read', tools: ['claude'] };

/** The evidence step's lease, the files it leaves under `$TEAMAI_RUN_DIR`, and its report. */
function evidence(confined: string): ConformanceOperation[] {
  return [
    { kind: 'next', saveAs: 'evidence', expect: { data: { lease: { step: 'evidence' } } } },
    { kind: 'runFiles', files: { 'evidence/confined.json': confined, 'evidence/diff.txt': '- retries: 0\n+ retries: 3\n', 'evidence/reply.schema.json': '{"type":"object"}' } },
    { kind: 'report', lease: 'evidence', body: { outcome: 'success' }, expect: { data: { step: { id: 'evidence', status: 'succeeded' } } } },
  ];
}

/** `JUDGE` whose evidence step builds its directory from files an earlier step left under `$TEAMAI_RUN_DIR`. */
const JUDGE_PREPARED = JUDGE.replace('    model: confined-judge\n', '').replace('  - id: evidence\n    command: ./evidence.sh\n', '  - id: prepare\n    command: ./prepare.sh\n  - id: evidence\n    needs: [prepare]\n    command: ./evidence.sh\n');

/** Runs JUDGE_PREPARED until `step` fails and the run ends, then retries `step` and expects `prepare` to run again. */
function retriedAfterEnd(step: 'evidence' | 'judge'): ConformanceOperation[] {
  const failed: ConformanceOperation = { kind: 'report', lease: step, body: { outcome: 'failed' }, expect: { data: { step: { id: step, status: 'failed' } } } };

  return [
    { kind: 'next', saveAs: 'prepare', expect: { data: { lease: { step: 'prepare' } } } },
    { kind: 'report', lease: 'prepare', body: { outcome: 'success' }, expect: { data: { step: { id: 'prepare', status: 'succeeded' } } } },
    ...step === 'evidence'
      ? [{ kind: 'next', saveAs: 'evidence', expect: { data: { lease: { step: 'evidence' } } } } satisfies ConformanceOperation, failed]
      : [...evidence('{"level":"verified"}'), { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge' } } } } satisfies ConformanceOperation, failed],
    { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
    { kind: 'retry', step, expect: { data: { retried: { step }, reopened: true } } },
    { kind: 'next', saveAs: 'prepare2', expect: { data: { lease: { step: 'prepare', pass: 2 } } } },
  ];
}

export const confinedConformanceScenarios: ConformanceScenario[] = [
  {
    name: 'workspace confined: a prepared lease runs in its directory, and no place of the checkout is made for it',
    workflowName: 'judge',
    yaml: JUDGE.replace('    model: confined-judge\n', ''),
    operations: [
      ...evidence('{"level":"verified"}'),
      { kind: 'next', saveAs: 'judge', prepare: true, can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge', confined: { level: 'verified' } } } } },
      { kind: 'files', lease: 'judge', expect: { 'diff.txt': '- retries: 0\n+ retries: 3\n', 'confined.json': '{"level":"verified"}' } },
    ],
    expectState: { status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'leased' }] },
  },
  {
    name: 'workspace confined: a retry of the step after its run ended runs again the step that writes its directory',
    workflowName: 'judge',
    yaml: JUDGE.replace('    model: confined-judge\n', ''),
    operations: [
      ...evidence('{"level":"verified"}'),
      { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge' } } } },
      { kind: 'report', lease: 'judge', body: { outcome: 'failed' }, expect: { data: { step: { id: 'judge', status: 'failed' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
      { kind: 'retry', step: 'judge', expect: { data: { retried: { step: 'judge', pass: 2 }, reopened: true } } },
      { kind: 'next', saveAs: 'evidence2', expect: { data: { lease: { step: 'evidence', pass: 2 } } } },
      { kind: 'runFiles', files: { 'evidence/confined.json': '{"level":"verified"}', 'evidence/diff.txt': '- retries: 0\n+ retries: 3\n' } },
      { kind: 'report', lease: 'evidence2', body: { outcome: 'success' }, expect: { data: { step: { id: 'evidence', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'judge2', prepare: true, can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge', pass: 2, confined: { level: 'verified' } } } } },
      { kind: 'files', lease: 'judge2', expect: { 'diff.txt': '- retries: 0\n+ retries: 3\n', 'confined.json': '{"level":"verified"}' } },
    ],
    expectState: { status: 'running', steps: [{ id: 'evidence', status: 'succeeded', pass: 2 }, { id: 'judge', status: 'leased', pass: 2 }] },
  },
  {
    name: 'workspace confined: a retry of the step in a for_each item after its run ended runs again the item\'s step that writes its directory',
    workflowName: 'judge',
    yaml: JUDGE_EACH,
    operations: [
      { kind: 'next', saveAs: 'plan', expect: { data: { lease: { step: 'plan' } } } },
      { kind: 'report', lease: 'plan', body: { outcome: 'success', outputs: { changes: ['retries'] } }, expect: { data: { step: { id: 'plan', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'evidence', expect: { data: { lease: { step: 'score[0].evidence' } } } },
      { kind: 'runFiles', files: { 'retries/confined.json': '{"level":"verified"}', 'retries/diff.txt': '+ retries: 3\n' } },
      { kind: 'report', lease: 'evidence', body: { outcome: 'success', outputs: { dir: 'retries' } }, expect: { data: { step: { id: 'score[0].evidence', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'score[0].judge' } } } },
      { kind: 'report', lease: 'judge', body: { outcome: 'failed' }, expect: { data: { step: { id: 'score[0].judge', status: 'failed' } } } },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'failed' } } } },
      { kind: 'retry', step: 'score[0].judge', expect: { data: { retried: { step: 'score[0].judge', pass: 2 }, reopened: true } } },
      { kind: 'next', saveAs: 'evidence2', expect: { data: { lease: { step: 'score[0].evidence', pass: 2 } } } },
      { kind: 'runFiles', files: { 'retries/confined.json': '{"level":"verified"}', 'retries/diff.txt': '+ retries: 3\n' } },
      { kind: 'report', lease: 'evidence2', body: { outcome: 'success', outputs: { dir: 'retries' } }, expect: { data: { step: { id: 'score[0].evidence', status: 'succeeded' } } } },
      { kind: 'next', saveAs: 'judge2', prepare: true, can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'score[0].judge', pass: 2, confined: { level: 'verified' } } } } },
      { kind: 'files', lease: 'judge2', expect: { 'diff.txt': '+ retries: 3\n', 'confined.json': '{"level":"verified"}' } },
    ],
    expectState: {
      status: 'running',
      steps: [{ id: 'plan', status: 'succeeded' }, { id: 'score' }, { id: 'score[0]' }, { id: 'score[0].evidence', status: 'succeeded', pass: 2 }, { id: 'score[0].judge', status: 'leased', pass: 2 }],
    },
  },
  {
    name: 'workspace confined: a retry of the step after its run ended runs again the steps its directory\'s writer needs too',
    workflowName: 'judge',
    yaml: JUDGE_PREPARED,
    operations: retriedAfterEnd('judge'),
    expectState: { status: 'running', steps: [{ id: 'prepare', status: 'leased', pass: 2 }, { id: 'evidence', status: 'pending' }, { id: 'judge', status: 'pending' }] },
  },
  {
    name: 'workspace confined: a retry of the directory\'s writer after its run ended runs again the steps it needs too',
    workflowName: 'judge',
    yaml: JUDGE_PREPARED,
    operations: retriedAfterEnd('evidence'),
    expectState: { status: 'running', steps: [{ id: 'prepare', status: 'leased', pass: 2 }, { id: 'evidence', status: 'pending' }, { id: 'judge', status: 'pending' }] },
  },
  {
    name: 'workspace confined: a retry of the step while its run runs keeps the directory, and runs again only the step',
    workflowName: 'judge',
    yaml: JUDGE.replace('    model: confined-judge\n', ''),
    operations: [
      ...evidence('{"level":"verified"}'),
      { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge' } } } },
      { kind: 'retry', step: 'judge', expect: { data: { retried: { step: 'judge', pass: 2 }, reopened: false } } },
      { kind: 'next', saveAs: 'judge2', prepare: true, running: ['judge'], cancelled: ['judge'], can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge', pass: 2 } } } },
      { kind: 'files', lease: 'judge2', expect: { 'diff.txt': '- retries: 0\n+ retries: 3\n' } },
    ],
    expectState: { status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'leased', pass: 2 }] },
  },
  {
    name: 'workspace confined: a directory outside the run\'s $TEAMAI_RUN_DIR fails the step confined_invalid',
    workflowName: 'judge',
    yaml: JUDGE.replace('{ confined: evidence }', '{ confined: .. }'),
    teamFiles: ALIASES,
    operations: [
      ...evidence('{"level":"best-effort"}'),
      { kind: 'next', saveAs: 'done', can: { confined: [{ level: 'best-effort', tools: ['codex'] }] }, expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { status: 'failed', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'failed', failure: { code: 'confined_invalid' } }] },
  },
  {
    name: 'workspace confined: a directory without confined.json fails the step confined_invalid',
    workflowName: 'judge',
    yaml: JUDGE.replace('{ confined: evidence }', '{ confined: elsewhere }'),
    teamFiles: ALIASES,
    operations: [
      ...evidence('{"level":"best-effort"}'),
      { kind: 'runFiles', files: { 'elsewhere/diff.txt': '+ retries: 3\n' } },
      { kind: 'next', saveAs: 'done', can: { confined: [{ level: 'best-effort', tools: ['codex'] }] }, expect: { data: { done: { outcome: 'failed' } } } },
    ],
    expectState: { status: 'failed', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'failed', failure: { code: 'confined_invalid' } }] },
  },
  {
    name: 'workspace confined: a verified confined.json is held from a driver whose only offer is best-effort, and leased to one that offers verified',
    workflowName: 'judge',
    yaml: JUDGE.replace('    model: confined-judge\n', ''),
    operations: [
      ...evidence('{"level":"verified"}'),
      {
        kind: 'next', saveAs: 'held', can: { confined: [{ level: 'best-effort', access: 'full', tools: ['cursor'] }] },
        expect: { data: { wait: { held: [{ step: 'judge', missing: ['confined'] }] } } },
      },
      { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { lease: { step: 'judge', confined: { level: 'verified', tools: ['claude'] } } } } },
    ],
    expectState: { status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'leased' }] },
  },
  {
    name: 'workspace confined: a model no candidate tool resolves leaves the step pending, and a driver whose tool resolves it takes it',
    workflowName: 'judge',
    yaml: JUDGE,
    teamFiles: ALIASES,
    operations: [
      ...evidence('{"level":"best-effort"}'),
      { kind: 'next', saveAs: 'held', can: { confined: [VERIFIED_CLAUDE] }, expect: { data: { wait: { held: [{ step: 'judge', missing: ['model'] }] } } } },
      // oxlint-disable-next-line teamai/tool-facts -- the offers a driver declares and the order a lease lists them in, not facts about a tool
      { kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE, { level: 'best-effort', tools: ['codex'] }] }, expect: { data: { lease: { step: 'judge', model: 'confined-judge', confined: { level: 'best-effort', tools: ['claude', 'codex'] } } } } },
    ],
    expectState: { status: 'running', steps: [{ id: 'evidence', status: 'succeeded' }, { id: 'judge', status: 'leased' }] },
  },
  {
    name: 'workspace confined: the lease lists the tools of every offer that meets the level, the preferred one first, and the pass keeps what the confined run measured',
    workflowName: 'judge',
    yaml: JUDGE.replace('    model: confined-judge\n', ''),
    operations: [
      ...evidence('{"level":"best-effort","prefer":"codex","schema":"reply.schema.json"}'),
      {
        // oxlint-disable-next-line teamai/tool-facts -- the offers a driver declares and the order a lease lists them in, not facts about a tool
        kind: 'next', saveAs: 'judge', can: { confined: [VERIFIED_CLAUDE, { level: 'best-effort', access: 'full', tools: ['cursor', 'codex'] }] },
        // oxlint-disable-next-line teamai/tool-facts -- the offers a driver declares and the order a lease lists them in, not facts about a tool
        expect: { data: { lease: { step: 'judge', prompt: 'Judge the change from the files here.', confined: { level: 'best-effort', tools: ['codex', 'claude', 'cursor'] } } } },
        absent: ['workspace', 'session'],
      },
      {
        kind: 'report', lease: 'judge',
        body: {
          outcome: 'success', outputs: { verdict: 'pass' }, tool: 'codex',
          confined: { tool: 'codex', model: { requested: 'gpt-6-astra', reported: 'gpt-6-astra' }, isolation: 'best-effort', access: 'full', usage: { inputTokens: 1200, outputTokens: 40 } },
        },
        expect: { data: { step: { id: 'judge', status: 'succeeded' } } },
      },
      { kind: 'next', saveAs: 'done', expect: { data: { done: { outcome: 'succeeded' } } } },
    ],
    expectState: {
      status: 'succeeded',
      steps: [
        { id: 'evidence', status: 'succeeded' },
        {
          id: 'judge', status: 'succeeded', outputs: { verdict: 'pass' }, tool: 'codex',
          confined: { tool: 'codex', model: { requested: 'gpt-6-astra', reported: 'gpt-6-astra' }, isolation: 'best-effort', access: 'full', usage: { inputTokens: 1200, outputTokens: 40 } },
        },
      ],
    },
  },
];
