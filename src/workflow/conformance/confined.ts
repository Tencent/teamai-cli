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

export const confinedConformanceScenarios: ConformanceScenario[] = [
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
