import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { judgingHealth } from '../dashboard/judging-health.js';
import { workflowRunDetail } from '../dashboard/workflow-runs.js';
import { knownSecrets } from '../env-resolution.js';
import { LabelStore } from '../scorers/label-store.js';
import type { ScoreLabel } from '../scorers/label.js';
import { Marks, type MarkKey, type MarkOutcome } from '../scorers/marks.js';
import { markFacts } from '../scorers/score-plan.js';
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

/** A label of pass 1 of `review` in `runId`, as `teamai score write` appends one; a hand label has no `decidedBy`. */
async function label(config: LocalConfig, runId: string, fields: { scorer: string; label: 'good' | 'bad'; decidedBy?: 'judge' | 'ci' | 'check' | 'protected' } & Partial<Pick<ScoreLabel, 'judge' | 'scoredAt'>>): Promise<void> {
  const { scorer: name, label: value, ...rest } = fields;
  await LabelStore.append(config, {
    source: 'workflow', scorer: name, rubric: { sourceHash: await sourceHash(config, runId, name) }, label: value, score: value === 'good' ? 1 : 0, passed: value === 'good',
    judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }, scoredAt: new Date().toISOString(),
    subject: { runId, step: 'review', pass: 1 }, ...rest,
  }, undefined);
}

const keyOf = (runId: string, name: string): MarkKey => ({ scorer: name, subject: { kind: 'run', subject: { runId, step: 'review', pass: 1 } } });

/** Opens `names` on pass 1 of `runId` for the score run `scoreRun`, then records `outcome` for them, as plan and write do; a run that is not on this machine has ended. */
async function marked(config: LocalConfig, runId: string, names: string[], outcome?: MarkOutcome, scoreRun = SCORE_RUN): Promise<void> {
  const facts = markFacts(config, new Date().toISOString());
  const keys = names.map((name) => keyOf(runId, name));
  expect(await Marks.open(config, { run: scoreRun, demand: 'auto', groups: [{ group: names.join(','), keys }] }, facts)).toMatchObject({ status: 'done' });
  if (outcome) expect(await Marks.close(config, keys, outcome, facts)).toEqual({ status: 'done' });
}

/** A teamai-score run of pass 1 of `review` in `runId` that has not ended. */
async function scoreRunOf(config: LocalConfig, runId: string): Promise<string> {
  const inputs = { subject: `run:${runId}:review:1`, scorers: [], label: '', batch: false, demand: 'auto' };
  return String(data(await startRun(config, 'teamai-score', inputs, { secrets: await knownSecrets(config), startedBy: 'cli' })).run);
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * A pass of `review` with a scorer in each state: labelled by the judge, by hand and by CI, waiting for CI, judging in a
 * live score run, lapsed three times, failed, not sampled, and not started.
 */
async function judgedPass(config: LocalConfig): Promise<{ runId: string; scoreRun: string }> {
  const runId = await reviewedRun(config);
  await label(config, runId, { scorer: 'quality', label: 'good', decidedBy: 'judge', judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read', usage: { inputTokens: 900, outputTokens: 120 } } });
  await label(config, runId, { scorer: 'coverage', label: 'bad', judge: { kind: 'human' } });
  await label(config, runId, { scorer: 'delivered', label: 'bad', decidedBy: 'ci' });
  await marked(config, runId, ['waiting'], { kind: 'waiting' });
  const scoreRun = await scoreRunOf(config, runId);
  await marked(config, runId, ['judging'], undefined, scoreRun);
  for (const gone of ['r00000000000000b1', 'r00000000000000b2', 'r00000000000000b3']) await marked(config, runId, ['lapsed'], undefined, gone);
  await marked(config, runId, ['style'], { kind: 'failed', code: 'judge_answer_invalid' });
  return { runId, scoreRun };
}

const EVERY_STATE = ['quality', 'coverage', 'delivered', 'waiting', 'judging', 'lapsed', 'style', 'rare', 'queued'];

describe("a pass's scorers on the run page", () => {
  it('shows each scorer labelled, waiting for CI, judging in its score run, lapsed, failed, not sampled or not started', async () => {
    const config = await team(EVERY_STATE, { rare: 0 });
    const { runId, scoreRun } = await judgedPass(config);
    const run = await readRun(config, runId);
    if (run === 'missing' || run === 'corrupt') throw new Error(`run ${runId} is ${run}`);

    const pass = (await workflowRunDetail(config, 'local', runId))?.steps.find((step) => step.step === 'review' && step.pass === 1);

    expect(pass?.scores).toEqual([
      { scorer: 'quality', label: 'good', score: 1, passed: true, decidedBy: 'judge' },
      { scorer: 'coverage', label: 'bad', score: 0, passed: false, decidedBy: 'hand' },
      { scorer: 'delivered', label: 'bad', score: 0, passed: false, decidedBy: 'ci' },
    ]);
    expect(pass?.unlabelled).toEqual([
      { scorer: 'waiting', state: { kind: 'waiting_ci' } },
      { scorer: 'judging', state: { kind: 'judging', run: scoreRun, since: expect.any(String) } },
      { scorer: 'lapsed', state: { kind: 'lapsed', lapses: 3, expiresAt: new Date(Date.parse(run.updatedAt) + 14 * DAY_MS).toISOString() } },
      { scorer: 'style', state: { kind: 'failed', code: 'judge_answer_invalid' } },
      { scorer: 'rare', state: { kind: 'not_sampled', samplingRate: 0 } },
      { scorer: 'queued', state: { kind: 'queued' } },
    ]);
    expect(pass?.scoreRuns).toEqual([{ run: scoreRun, status: 'running' }]);
  });
});

/** `at` as the local day the daily limit counts it in. */
const localDay = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

describe('judging health on Workflow Runs', () => {
  it('counts the week\'s labels and judge tokens, the passes by state and failure, lists each missing label, and the session launches per day', async () => {
    const config = await team([...EVERY_STATE, 'old'], { rare: 0 });
    const { runId, scoreRun } = await judgedPass(config);
    await label(config, runId, { scorer: 'old', label: 'good', decidedBy: 'judge', scoredAt: new Date(Date.now() - 10 * DAY_MS).toISOString() });
    const facts = markFacts(config, new Date().toISOString());
    const session: MarkKey = { scorer: 'quality', sourceHash: 'h1', subject: { kind: 'session', subject: { platform: 'claude-code', sessionId: 's1' } } };
    expect(await Marks.open(config, { run: SCORE_RUN, demand: 'auto', groups: [{ group: 'quality', keys: [session] }] }, facts)).toMatchObject({ status: 'done' });

    const health = await judgingHealth(config, new Date().toISOString());
    const missing = (scorer: string) => expect.objectContaining({ run: runId, workflow: 'review', step: 'review', pass: 1, scorer });

    expect(health.labels).toEqual({ total: 3, passed: 1, byDecider: { judge: 1, hand: 1, ci: 1 }, inputTokens: 900, outputTokens: 120 });
    expect(health.states).toEqual({ queued: 1, not_sampled: 1, judging: 1, waiting_ci: 1, lapsed: 1, failed: 1, expired: 0 });
    expect(health.failures).toEqual([{ code: 'judge_answer_invalid', count: 1 }]);
    expect(health.missing).toEqual([missing('waiting'), missing('judging'), missing('lapsed'), missing('style'), missing('queued')]);
    expect(health.missing[1]?.state).toEqual({ kind: 'judging', run: scoreRun, since: expect.any(String) });
    expect(health.sessions.dailyLimit).toBe(10);
    expect(health.sessions.days).toHaveLength(7);
    expect(health.sessions.days.at(-1)).toEqual({ day: localDay(new Date()), launches: 1 });
    expect(health.sessions.days.slice(0, -1).every(({ launches }) => launches === 0)).toBe(true);
  });
});
