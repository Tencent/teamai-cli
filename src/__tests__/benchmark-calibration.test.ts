import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isCalibrationSampled } from '../benchmark/calibration.js';
import { benchmarkRecord, type BenchmarkRecord } from '../benchmark/result.js';
import { planOfRun } from '../benchmark/run-plan.js';
import { TrialVerdicts } from '../benchmark/verdicts.js';
import { ScoreVerbs } from '../score-verbs.js';
import type { LocalConfig } from '../types.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import type { BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import type { DriverCan } from '../workflow/requirements.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun, runScratchDir } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { benchmarkRunConfig, PLANNED_BENCHMARK, settleBaselines, startBenchmarkRun, trialCheckOutput } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], end_turn: true };
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }) });
const NOW = '2026-11-08T10:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CHECK = 'check: { run: node test.js, protect: [test.js] }\n';
const CRITERIA = 'successCriteria: The test passes and the message names the field.\n';

/** A suite of t01 and t02, each with a check and success criteria, and t03 with a check only; `calibration` its key. */
function mixedSuite(calibration = ''): BenchmarkSuiteFiles {
  const task = (judge: string) => `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\n${judge}`;
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [{ name: a01 }]\nrepetitions: 1\ntimeout: 10m\n${calibration}`,
    tasks: { t01: task(`${CHECK}${CRITERIA}`), t02: task(`${CHECK}${CRITERIA}`), t03: task(CHECK) },
  };
}

/**
 * A run of `files` whose trials ran and whose checks said `checks`, by task; then its trials step ended. Its baselines
 * failed on the starting commit, as the tasks expect.
 */
async function checkedRun(files: BenchmarkSuiteFiles, checks: Record<string, 'passed' | 'failed'>): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-calibration-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, files);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  await settleBaselines(config, runId, driver, can);
  for (;;) {
    const lease = LeaseSchema.safeParse(await leaseNext(config, runId, driver, { can, prepare: true }));
    if (!lease.success) break;
    const { step, attempt, revision } = lease.data.data.lease;
    const task = step.split('.')[2] ?? '';
    const outputs = step.endsWith('.check') ? await trialCheckOutput(config, runId, { checkStep: step, result: checks[task] ?? 'failed' }) : {};
    await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs });
  }
  return { config, runId };
}

describe('judge calibration sampling', () => {
  it('samples a trial by its run id and step alone, the same on every read, none at 0 and every one at 100', () => {
    const steps = Array.from({ length: 2000 }, (_, index) => `trials.r${index + 1}.t01.a01.prompt`);
    const sampled = (rate: number) => steps.filter((step) => isCalibrationSampled({ runId: 'r0123456789abcdef', step }, rate));

    expect(sampled(20)).toEqual(sampled(20));
    expect(sampled(0)).toEqual([]);
    expect(sampled(100)).toEqual(steps);
    expect(sampled(20).length / steps.length).toBeGreaterThan(0.17);
    expect(sampled(20).length / steps.length).toBeLessThan(0.23);
    expect(sampled(20)).not.toEqual(steps.filter((step) => isCalibrationSampled({ runId: 'r1111111111111111', step }, 20)));
  });
});

describe('teamai score subjects --calibration', () => {
  it("lists each sampled trial of a task with a check and success criteria whose check failed, with the task's correctness scorer", async () => {
    const { config, runId } = await checkedRun(mixedSuite('calibration: { rate: 100 }\n'), { t01: 'failed', t02: 'passed', t03: 'failed' });

    const listed = { ok: true, output: { list: [{ subject: `run:${runId}:trials.r1.t01.a01.prompt:1`, scorer: 'teamai:correctness:t01' }] } };

    expect(await ScoreVerbs.subjects({ run: runId, step: 'trials', calibration: true }, { env: {}, current: config, now: NOW })).toEqual(listed);
    expect(await ScoreVerbs.subjects({ run: runId, calibration: true }, { env: {}, current: config, now: NOW })).toEqual(listed);
    expect(await ScoreVerbs.subjects({ run: runId, step: 'other', calibration: true }, { env: {}, current: config, now: NOW })).toEqual({ ok: true, output: { list: [] } });
  });

  it('lists nothing for a suite that sets no calibration rate', async () => {
    const { config, runId } = await checkedRun(mixedSuite(), { t01: 'failed', t02: 'failed', t03: 'failed' });

    expect(await ScoreVerbs.subjects({ run: runId, step: 'trials', calibration: true }, { env: {}, current: config, now: NOW })).toEqual({ ok: true, output: { list: [] } });
  });

  it.each([
    ['--lapsed', { lapsed: true, calibration: true }, '--calibration lists the trials of a benchmark run to calibrate its judges and takes no --lapsed.'],
    ['no --run', { calibration: true }, 'Pass --run <id>, the benchmark run whose trials to calibrate, with --calibration.'],
  ])('refuses --calibration with %s', async (_, options, message) => {
    expect(await ScoreVerbs.subjects(options, { env: {}, current: undefined, now: NOW })).toEqual({ ok: false, code: 'invalid_arguments', message });
  });
});

/** The planned benchmark with the shipped workflow's score and calibration steps. */
const CALIBRATED_BENCHMARK = `${PLANNED_BENCHMARK}  - id: subjects
    needs: [trials]
    command: teamai score subjects --run "$RUN" --step trials
    env: { RUN: "{{ run.id }}" }
    output: { list: [string] }
  - id: score
    needs: [subjects]
    for_each: steps.subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item }}", scorers: [], label: "", batch: true, demand: named }
    continue_on_failure: true
  - id: calibration-subjects
    needs: [score]
    if: steps.score.outcome != 'skipped'
    command: teamai score subjects --calibration --run "$RUN" --step trials
    env: { RUN: "{{ run.id }}" }
    output: { list: [{ subject: string, scorer: string }] }
  - id: calibrate
    needs: [calibration-subjects]
    for_each: steps.calibration-subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item.subject }}", scorers: ["{{ item.scorer }}"], label: "", store: false, batch: false, demand: named }
    continue_on_failure: true
`;

const CORRECTNESS = 'teamai:correctness:t01';
const PROMPT = 'trials.r1.t01.a01.prompt';

/**
 * The record of the one trial of a mixed task whose check failed, in a suite that calibrates every such trial: its
 * calibration judge labelled it `label`, or gave the code `code` and no label, storing nothing, or the run was cancelled
 * while the judge ran (`isJudgeCancelled`). Also the groups `teamai score plan` gave the calibrate instance.
 */
async function calibratedRecord({ label = 'correct', code = '', isJudgeCancelled = false }: { label?: string; code?: string; isJudgeCancelled?: boolean } = {}): Promise<{ record: BenchmarkRecord; groups: unknown; task: string | undefined }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-calibration-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const files: BenchmarkSuiteFiles = { ...mixedSuite('calibration: { rate: 100 }\n'), tasks: { t01: mixedSuite().tasks.t01 ?? '' } };
  const started = await startBenchmarkRun(config, files, { body: CALIBRATED_BENCHMARK });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const subject = `run:${runId}:${PROMPT}:1`;
  await settleBaselines(config, runId, driver, can);
  const judging: DriverCan = { ...can, confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: [...can.workspace ?? [], 'team'] };
  let groups: unknown;
  for (;;) {
    const lease = LeaseSchema.safeParse(await leaseNext(config, runId, driver, { can: judging, prepare: true }));
    if (!lease.success) break;
    const { step, attempt, revision } = lease.data.data.lease;
    const id = step.split('.').at(-1) ?? step;
    const calibrating = step.startsWith('calibrate[');
    let outputs: unknown = {};
    if (id === 'check') outputs = await trialCheckOutput(config, runId, { checkStep: step, result: 'failed' });
    if (id === 'subjects') outputs = { list: [subject] };
    if (id === 'plan' && !calibrating) outputs = { groups: [] };
    if (id === 'calibration-subjects') {
      const listed = await ScoreVerbs.subjects({ run: runId, step: 'trials', calibration: true }, { env: {}, current: config, now: NOW });
      outputs = listed.ok ? listed.output : {};
    }
    if (id === 'plan' && calibrating) {
      const planned = await ScoreVerbs.plan({ subject, scorers: JSON.stringify([CORRECTNESS]), batch: 'false', demand: 'named' }, { env: attemptEnv(config, runId, attempt, 'unattended'), current: config, now: NOW });
      groups = planned.ok ? planned.output.groups : planned;
      outputs = planned.ok ? planned.output : {};
    }
    if (id === 'evidence') {
      // As teamai score evidence writes it for the correctness scorer, whose judge the plan pins to claude.
      const dir = path.join(runScratchDir(config, runId), attempt);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'confined.json'), '{"level":"verified","require":"claude"}');
      outputs = { dir, rubric: 'Judge it.', schema: path.join(dir, 'answer.schema.json'), delivers: false };
    }
    if (id === 'label') outputs = { labels: [{ scorer: CORRECTNESS, label: code === '' ? label : '', code }] };
    if (id === 'write') outputs = { written: 0, labels: [] };
    if (id === 'judge' && isJudgeCancelled) {
      await cancelRun(config, runId, {});
      break;
    }
    if (id === 'judge') {
      const confined = { tool: 'claude', model: { requested: 'haiku', reported: 'claude-haiku-4-5' }, isolation: 'verified', access: 'read', usage: { cost: { amount: 0.002, unit: 'USD' } } } as const;
      await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs: { answer: { label, reasoning: 'The message names the field.' } }, confined });
      continue;
    }
    await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs });
  }

  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  const planned = planOfRun(run);
  if ('failure' in planned) throw new Error(planned.failure.message);
  const record = benchmarkRecord(run, planned.found, await TrialVerdicts.of(config, run, planned.found), TrialVerdicts.calibrations(run, planned.found));
  return { record, groups, task: record.tasks[0]?.sourceHash };
}

describe('benchmark run calibration', () => {
  it("records the calibration judge's label and what judging it cost on a trial whose check failed, read from the labels its teamai-score run gave, and keeps the check's result", async () => {
    const { record, groups, task } = await calibratedRecord();
    const rubric = record.scorers.find(({ name }) => name === CORRECTNESS)?.rubric.sourceHash;

    // Named, the correctness scorer is planned though its check's stage label decided the trial.
    expect(groups).toEqual([expect.objectContaining({ subject: expect.stringContaining(PROMPT), scorers: CORRECTNESS })]);
    expect(record.trials).toEqual([expect.objectContaining({
      result: 'failed',
      verdicts: [{ scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'incorrect', score: 0, passed: false }, decider: { by: 'check', task } }],
      calibration: { label: 'correct', passed: true, decider: { by: 'judge', rubric, tool: 'claude', model: 'claude-haiku-4-5', batched: false }, scoringCost: { amount: 0.002, unit: 'USD', complete: true } },
    })]);
  });

  it('records the suite\'s calibration rate and that its task has both a check and success criteria, so a reader need not infer them', async () => {
    const { record } = await calibratedRecord();

    expect(record.calibration).toEqual({ rate: 100 });
    expect(record.tasks.map(({ judge }) => judge)).toEqual(['both']);
  });

  it('records the judging cost of a trial as unknown when the run was cancelled while its calibration judge ran', async () => {
    const { record } = await calibratedRecord({ isJudgeCancelled: true });

    expect(record.trials[0]).not.toHaveProperty('calibration');
    expect(record.trials[0]?.scoringCost).toEqual({ complete: false });
  });

  it('records no calibration on a trial whose calibration judge gave no label', async () => {
    const { record } = await calibratedRecord({ code: 'judge_failed' });

    expect(record.trials[0]).not.toHaveProperty('calibration');
    expect(record.trials[0]?.result).toBe('failed');
  });
});
