import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowRunDetail } from '../dashboard/workflow-runs.js';
import { knownSecrets } from '../env-resolution.js';
import { LabelStore } from '../scorers/label-store.js';
import type { ScoreLabel } from '../scorers/label.js';
import { Marks, type MarkKey, type MarkOutcome } from '../scorers/marks.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity, WorkflowEnvelope } from '../workflow/types.js';

const external: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };
const SCORE_RUN = 'r00000000000000aa';

const scorer = (rate = 100) => `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 1
samplingRate: ${rate}
---
Judge the work.
`;

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-judging-')));
  vi.stubEnv('HOME', path.join(root, 'home'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

/** A team whose `review` step lists `scorers`, each a scorer sampled at `rates[name]` percent, 100 by default. */
async function team(scorers: string[], rates: Record<string, number> = {}): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), [
    'schemaVersion: v1alpha1', 'name: review', 'description: Review a change.', 'steps:',
    '  - id: review', '    prompt: Review the change.', `    scorers: [${scorers.join(', ')}]`,
  ].join('\n'));
  for (const name of scorers) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), scorer(rates[name]));
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
  expect((await syncWorkflowDefinitions(config)).invalid).toEqual([]);
  return config;
}

/** A run of `review` whose one pass succeeded on this machine. */
async function reviewedRun(config: LocalConfig): Promise<string> {
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
  const lease = data(await leaseNext(config, runId, external)).lease as { attempt: string; revision: number };
  data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: external, tool: 'claude' }));
  return runId;
}

async function sourceHash(config: LocalConfig, runId: string, name: string): Promise<string> {
  const run = await readRun(config, runId);
  if (run === 'missing' || run === 'corrupt') throw new Error(`run ${runId} is ${run}`);
  const pin = run.scorers?.[name];
  if (!pin) throw new Error(`run ${runId} pinned no ${name}`);
  return pin.sourceHash;
}

/** A label of pass 1 of `review` in `runId`, as `teamai score write` appends one. */
async function label(config: LocalConfig, runId: string, fields: { scorer: string; label: 'good' | 'bad'; decidedBy: 'judge' | 'ci' | 'check' | 'protected' } & Partial<Pick<ScoreLabel, 'judge' | 'scoredAt'>>): Promise<void> {
  const { scorer: name, label: value, decidedBy, ...rest } = fields;
  await LabelStore.append(config, {
    source: 'workflow', scorer: name, rubric: { sourceHash: await sourceHash(config, runId, name) }, label: value, score: value === 'good' ? 1 : 0, passed: value === 'good',
    judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }, scoredAt: new Date().toISOString(),
    subject: { runId, step: 'review', pass: 1 }, decidedBy, ...rest,
  }, undefined);
}

const keyOf = (runId: string, name: string): MarkKey => ({ scorer: name, subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } });

/** Opens `names` on pass 1 of `runId` for the score run `SCORE_RUN`, then records `outcome` for them, as plan and write do. */
async function marked(config: LocalConfig, runId: string, names: string[], outcome?: MarkOutcome): Promise<void> {
  const now = new Date().toISOString();
  const facts = { now, readRun: async () => ({ ended: false, changedAt: now }) };
  const keys = names.map((name) => keyOf(runId, name));
  expect(await Marks.open(config, { run: SCORE_RUN, demand: 'auto', groups: [{ group: names.join(','), keys }] }, facts)).toMatchObject({ status: 'done' });
  if (outcome) expect(await Marks.close(config, keys, outcome, facts)).toEqual({ status: 'done' });
}

describe('what judging a run cost', () => {
  it('counts each judge call from the labels and the failed marks, a batch\'s tokens once, and no stage decision', async () => {
    const config = await team(['quality', 'coverage', 'delivered', 'checked', 'style']);
    const runId = await reviewedRun(config);
    await marked(config, runId, ['quality', 'coverage'], { kind: 'labelled' });
    await label(config, runId, { scorer: 'quality', label: 'good', decidedBy: 'judge', judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read', batched: true, usage: { inputTokens: 900, outputTokens: 120 } } });
    await label(config, runId, { scorer: 'coverage', label: 'bad', decidedBy: 'judge', judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read', batched: true } });
    await marked(config, runId, ['delivered'], { kind: 'labelled' });
    await label(config, runId, { scorer: 'delivered', label: 'bad', decidedBy: 'ci' });
    await marked(config, runId, ['checked'], { kind: 'failed', code: 'check_could_not_run' });
    await marked(config, runId, ['style'], { kind: 'failed', code: 'judge_answer_invalid' });

    expect((await workflowRunDetail(config, 'local', runId))?.scoring).toEqual({ judged: 3, inputTokens: 900, outputTokens: 120 });
  });
});
