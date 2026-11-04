import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { scoresDir } from '../scorers/home.js';
import { PassScoring } from '../scorers/pass-scoring.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { inProcessClient } from '../workflow/protocol.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun, runFilePath, RunIdSchema, runsDir } from '../workflow/store.js';
import type { DriverIdentity, WorkflowEnvelope } from '../workflow/types.js';

const skill: DriverIdentity = { kind: 'skill', machine: 'm1', workspace: '/w' };

const QUALITY = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 1
samplingRate: 100
---
Judge the work.
`;

const review = (scorers: string) => `schemaVersion: v1alpha1
name: review
description: Review a change.
steps:
  - id: review
    prompt: Review the change.
    scorers: ${scorers}
`;

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pass-scoring-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(mocks.home, { recursive: true });
  vi.stubEnv('HOME', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function team(workflow: string): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), workflow);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), QUALITY);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  await syncScorersThenWorkflows(config);
  return config;
}

/** A run of `review` whose one pass the skill driver reported succeeded. */
async function reviewedRun(config: LocalConfig): Promise<string> {
  const runId = String(data(await startRun(config, 'review', {}, { secrets: await knownSecrets(config) })).run);
  const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, skill)).lease);
  data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: skill }));
  return runId;
}

async function scoreRuns(config: LocalConfig) {
  const ids = fs.readdirSync(runsDir(config)).flatMap((name) => /^(r[0-9a-f]+)\.json$/.exec(name)?.[1] ?? []);
  const runs = await Promise.all(ids.map((id) => readRun(config, id)));
  return runs.flatMap((run) => (run !== 'missing' && run !== 'corrupt' && run.name === 'teamai-score' ? [run] : []));
}

async function start(config: LocalConfig, runId: string) {
  return PassScoring.start(config, runId, { client: inProcessClient({ config, env: await resolveWorkflowEnv(config) }), mode: 'attended' });
}

describe('PassScoring.start', () => {
  it('starts one root teamai-score run for a settled scored pass, as the CLI\'s own start, for the scored run\'s driver', async () => {
    const config = await team(review('[quality]'));
    const runId = await reviewedRun(config);

    const started = await start(config, runId);

    const [scored] = await scoreRuns(config);
    expect(started).toEqual({ runs: [{ subject: { runId, step: 'review', pass: 1 }, scorers: ['quality'], run: scored?.id }], refused: [] });
    expect(scored).toMatchObject({
      inputs: { subject: `run:${runId}:review:1`, scorers: [], label: '', batch: false, demand: 'auto' },
      startedBy: 'cli', runMode: 'attended', driver: skill,
    });
  });

  it('starts nothing for a pass of a step whose workflow starts its scoring itself', async () => {
    const config = await team(review('{ names: [quality], start: workflow }'));
    const runId = await reviewedRun(config);

    expect(await start(config, runId)).toEqual({ runs: [], refused: [] });
    expect(await scoreRuns(config)).toEqual([]);
  });

  it('starts a pass once when two processes see it settle at the same time, and answers that run again while it runs', async () => {
    const config = await team(review('[quality]'));
    const runId = await reviewedRun(config);

    const [first, second] = await Promise.all([start(config, runId), start(config, runId)]);
    const again = await start(config, runId);

    const runs = await scoreRuns(config);
    expect(runs).toHaveLength(1);
    expect([...first.runs, ...second.runs].map(({ run }) => run)).toEqual([runs[0]?.id]);
    expect(again.runs.map(({ run }) => run)).toEqual([runs[0]?.id]);
  });

  it('answers no run for a pass whose teamai-score run already ended', async () => {
    const config = await team(review('[quality]'));
    const runId = await reviewedRun(config);
    const [first] = (await start(config, runId)).runs;

    data(await cancelRun(config, String(first?.run), await knownSecrets(config)));

    expect(await start(config, runId)).toEqual({ runs: [], refused: [] });
    expect(await scoreRuns(config)).toHaveLength(1);
  });

  it('fails, rather than skips the pass, when it cannot record that it starts it', async () => {
    const config = await team(review('[quality]'));
    const runId = await reviewedRun(config);
    const started = path.join(scoresDir(config), 'started', runId);
    fs.mkdirSync(started, { recursive: true });
    fs.chmodSync(started, 0o500);

    try {
      await expect(start(config, runId)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(started, 0o700);
    }
    expect(await scoreRuns(config)).toEqual([]);
  });
});

/** Ends run `runId` and dates its last change, and its start keys, 15 days ago: past the 14 days a mark lasts. */
async function agedRun(config: LocalConfig, runId: string): Promise<void> {
  data(await leaseNext(config, runId, skill));
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const file = runFilePath(config, runId);
  fs.writeFileSync(file, JSON.stringify({ ...z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(file, 'utf8'))), updatedAt: old.toISOString() }));
  const keys = path.join(scoresDir(config), 'started', runId);
  if (fs.existsSync(keys)) fs.utimesSync(keys, old, old);
}

describe('PassScoring.start past the 14 days a mark lasts', () => {
  it('starts nothing for a run that ended more than 14 days ago', async () => {
    const config = await team(review('[quality]'));
    const runId = await reviewedRun(config);
    await agedRun(config, runId);

    expect(await start(config, runId)).toEqual({ runs: [], refused: [] });
    expect(await scoreRuns(config)).toEqual([]);
  });

  it('removes the start keys of a run that ended more than 14 days ago, and of a run that is gone, and keeps those of a run that ended since, or has not ended', async () => {
    const config = await team(review('[quality]'));
    const [ended, gone, running, recent] = [await reviewedRun(config), await reviewedRun(config), await reviewedRun(config), await reviewedRun(config)];
    for (const runId of [ended, gone, running]) await start(config, runId);
    await agedRun(config, ended);
    await agedRun(config, gone);
    fs.rmSync(runFilePath(config, gone));
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(scoresDir(config), 'started', running), old, old);
    data(await leaseNext(config, recent, skill));

    await start(config, recent);

    const started = (runId: string) => PassScoring.started(config, { runId, step: 'review', pass: 1 });
    expect([await started(ended), await started(gone), await started(running), await started(recent)]).toEqual([false, false, true, true]);
  });
});

describe('a step whose workflow scores its passes itself', () => {
  it('holds no run for the judges of its sampling: all scorers', async () => {
    const config = await team(review('{ names: [quality], sampling: all, start: workflow }'));
    const runId = await reviewedRun(config);

    expect(data(await leaseNext(config, runId, skill))).toMatchObject({ done: { outcome: 'succeeded' } });
  });
});

describe('PassScoring.said', () => {
  const run = RunIdSchema.parse('r5df4606a3a55cb41');
  const done = (labels: unknown[]): WorkflowEnvelope => ({ data: { done: { run, outcome: 'succeeded', outputs: { labels } } } });

  it('names the label or the code of each scorer of each group the run labelled', () => {
    const groups = [
      { item: { scorers: 'quality' }, outcome: 'success', outputs: { labels: [{ scorer: 'quality', label: 'good', code: '' }], written: ['v1'] } },
      { item: { scorers: 'depth,clarity' }, outcome: 'success', outputs: { labels: [{ scorer: 'depth', label: '', code: 'judge_failed' }, { scorer: 'clarity', label: 'bad', code: '' }], written: ['v2'] } },
    ];

    expect(PassScoring.said('run:r1:review:1', run, done(groups))).toEqual({
      kind: 'scored', line: `run:r1:review:1: quality good, depth judge_failed, clarity bad (teamai-score run ${run}).`,
    });
  });

  it('says score_step_failed for a label or a wait for CI that the write step did not store, and keeps a judge\'s own failure code', () => {
    const groups = [
      { item: { scorers: 'quality,delivered,depth' }, outcome: 'failed', outputs: { labels: [{ scorer: 'quality', label: 'good', code: '' }, { scorer: 'delivered', label: '', code: 'ci_pending' }, { scorer: 'depth', label: '', code: 'judge_failed' }], written: null } },
    ];

    expect(PassScoring.said('run:r1:review:1', run, done(groups))).toEqual({
      kind: 'scored', line: `run:r1:review:1: quality score_step_failed, delivered score_step_failed, depth judge_failed (teamai-score run ${run}).`,
    });
  });

  it('says no scorer sampled a pass whose run planned no group, or whose group broke before it labelled', () => {
    expect(PassScoring.said('run:r1:review:1', run, done([]))).toEqual({ kind: 'scored', line: `run:r1:review:1: no scorer sampled it (teamai-score run ${run}).` });
    expect(PassScoring.said('run:r1:review:1', run, done([{ item: {}, outcome: 'failed' }])).line).toContain('no scorer sampled it');
  });

  it('says it cannot read a done whose labels are not the shape teamai-score gives, rather than that no scorer sampled it', () => {
    const renamed = [{ item: {}, outcome: 'success', outputs: { labels: [{ scorer: 'quality', verdict: 'good' }] } }];

    expect(PassScoring.said('run:r1:review:1', run, done(renamed))).toEqual({
      kind: 'pending', line: expect.stringMatching(new RegExp(`^run:r1:review:1 is not labelled: teamai-score run ${run} answered outputs this teamai cannot read \\(.+\\)\\. Update teamai\\.$`)),
    });
  });

  it('says a run that failed or was cancelled labelled nothing', () => {
    const failed: WorkflowEnvelope = { data: { done: { run, outcome: 'failed' } } };

    expect(PassScoring.said('run:r1:review:1', run, failed)).toEqual({ kind: 'pending', line: `run:r1:review:1 is not labelled: teamai-score run ${run} ended failed.` });
  });

  it('says why a run that has not ended has no label yet', () => {
    const held: WorkflowEnvelope = { error: { code: 'confined_pending', message: 'Run r5 waits for a confined tool.' } };

    expect(PassScoring.said('run:r1:review:1', run, held)).toEqual({ kind: 'pending', line: 'run:r1:review:1 is not labelled yet (confined_pending): Run r5 waits for a confined tool.' });
  });
});
