import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { RunScorers } from '../scorers/run-scorers.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import * as cliPaths from '@teamai/shared/cli-path';
import { compileBundle, trialsOf, type BenchmarkPlan } from '../benchmark/plan.js';
import type { PinnedArmWorkflow } from '../benchmark/arm-workflow.js';
import { decideCheckReport } from '../benchmark/trial.js';
import { planBenchmark } from '../benchmark/start.js';
import { ScoreVerbs } from '../score-verbs.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { benchmarkRecord, uncheckedChecks, unmeasuredTrials, type BenchmarkRecord } from '../benchmark/result.js';
import { planOfRun } from '../benchmark/run-plan.js';
import { TrialVerdicts } from '../benchmark/verdicts.js';
import { LabelStore } from '../scorers/label-store.js';
import type { BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import { leaseNext, reconcileRun, reportAttempt } from '../workflow/engine.js';
import { stepDefinitions } from '../workflow/scope.js';
import type { DriverCan } from '../workflow/requirements.js';
import { ClonePlaceSchema } from '../workflow/clone.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun, runScratchDir } from '../workflow/store.js';
import { inProcessClient } from '../workflow/protocol.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { benchmarkTable, formatBenchmarkTable } from '../benchmark/table.js';
import { comparePair, type PairSide } from '../benchmark/pairing.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import { benchmarkRunConfig, frozenBenchmark, PLANNED_BENCHMARK, RUN_START, RUN_TEAM, settleBaselines, startBenchmarkRun, trialCheckOutput } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], end_turn: true };
const dirs: string[] = [];
const HeldSchema = z.object({ data: z.object({ wait: z.object({ held: z.array(z.unknown()) }) }) });
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }) });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Retried: on Windows another process, such as a virus scanner, can briefly hold a file just written (EBUSY).
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A check suite of `tasks` tasks t01.. and `arms` arms a01.., arm i on `tools[i]`, and on claude past them; an arm after
 * the first with no tool or team (`teams[i]`) of its own runs model m<i>, as each arm changes one of the defaults.
 * `trial` is the suite's `trial` value, and `prompt` every task's.
 */
function suiteOf({ tasks = 1, arms = 1, repetitions = 1, tools = [] as string[], teams = [] as string[], trial = '', parallel = 1, prompt = 'Make the test pass.', armsYaml = '' } = {}): BenchmarkSuiteFiles {
  const names = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
  const listed = armsYaml || names('a', arms).map((name, index) => `{ name: ${name}${tools[index] ? `, tool: ${tools[index]}` : teams[index] ? `, team: ${teams[index]}` : index > 0 ? `, model: m${index + 1}` : ''} }`).join(', ');
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [${listed}]\nrepetitions: ${repetitions}\nparallel: ${parallel}\ntimeout: 10m\n${trial ? `trial: ${trial}\n` : ''}`,
    tasks: Object.fromEntries(names('t', tasks).map((name) => [name,
      `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: ${JSON.stringify(prompt)}\nstartingCommit: '{{startingCommit}}'\ncheck: { run: node test.js, protect: [test.js] }\n`])),
  };
}

async function startFix(shape?: Parameters<typeof suiteOf>[0]): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, suiteOf(shape));
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

/** A run of suite `fix`, of `body` when given, whose plan step printed the plan as a teamai of plan schemaVersion 2 froze it. */
async function outdatedRun(body?: string): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, suiteOf(), { ...(body !== undefined && { body }), outputsOf: (bundle, plan) => ({ definition: { ...bundle, workflows: {} }, plan: { ...plan, schemaVersion: 2 } }) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

/** The checks of `run` the run's report names as having not run. */
function uncheckedOf(run: RunState): string[] {
  const planned = planOfRun(run);
  if ('failure' in planned) throw new Error(planned.failure.message);
  return uncheckedChecks(run, planned.found);
}

/** The trials of `run` the run's report names as having ended in an error when no trial produced a result. */
function unmeasuredOf(run: RunState): string[] {
  return unmeasuredTrials(run, recordOf(run).trials);
}

/** The benchmark record the run's report would write, from the plan its plan step printed and no verdict. */
function recordOf(run: RunState): BenchmarkRecord {
  const planned = planOfRun(run);
  if ('failure' in planned) throw new Error(planned.failure.message);
  return benchmarkRecord(run, planned.found, []);
}

/** The benchmark block of ended run `run`, with the verdicts its check and score steps left on this machine. */
async function judgedRecordOf(config: LocalConfig, run: RunState): Promise<BenchmarkRecord> {
  const planned = planOfRun(run);
  if ('failure' in planned) throw new Error(planned.failure.message);
  return benchmarkRecord(run, planned.found, await TrialVerdicts.of(config, run, planned.found));
}

/** The first trial prompt's lease, once every baseline failed on its starting commit, as the tasks expect. */
async function leasePrompt(config: LocalConfig, runId: string): Promise<{ attempt: string; revision: number }> {
  await settleBaselines(config, runId, driver, can);
  const { attempt, revision } = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  return { attempt, revision };
}

describe('benchmark plan run', () => {
  it.each([
    ['isolation', { ...can, isolation: 'none' as const }, true],
    ['prepare', can, false],
  ])('holds a task baseline, which runs before any trial, for a driver that lacks %s', async (missing, offered, prepare) => {
    const { config, runId } = await startFix();

    const next = await leaseNext(config, runId, driver, { can: offered, prepare });

    expect(next).toEqual({ data: { wait: { reason: expect.any(String), held: [{ step: 'trials.baselines.t01', reason: expect.any(String), missing: [missing] }] }, cancelled: [] } });
  });

  it('holds a task baseline, and so every trial, from a driver that declares nothing', async () => {
    const { config, runId } = await startFix();

    const next = await leaseNext(config, runId, driver, { can: {}, prepare: true });

    expect(next).toEqual({ data: { wait: { reason: expect.any(String), held: [{ step: 'trials.baselines.t01', reason: expect.any(String), missing: expect.arrayContaining(['workspace.clone']) }] }, cancelled: [] } });
  });

  it('leases a task baseline, a clone of the starting commit with no team resources, before any trial', async () => {
    const { config, runId } = await startFix();

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: {
      step: 'trials.baselines.t01', command: 'node test.js',
      workspace: { mode: 'new', base: { commit: RUN_START }, clone: { commit: RUN_START, team: { treatment: 'none' } } },
    } } });
  });

  it('refuses a driver every step of a run whose plan a teamai before an upgrade froze, as resume refuses it, and leases none', async () => {
    const { config, runId } = await outdatedRun();

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toEqual({ error: {
      code: 'benchmark_plan_outdated',
      message: `Run ${runId} measures a benchmark plan of schemaVersion 2, which the teamai that started it froze, and this teamai reads only schemaVersion 3, so the run cannot go on here. Run it with the teamai that started it, or start the suite again with teamai benchmark run fix.`,
    } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.filter((step) => step.status === 'leased').map((step) => step.id)).toEqual([]);
  });

  it('ends a run whose plan a teamai before an upgrade froze at its timeout, on the next of any driver', async () => {
    const { config, runId } = await outdatedRun();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } });
  });

  it('ends a run whose plan a teamai before an upgrade froze at one cancel, running none of its finally steps', async () => {
    const { config, runId } = await outdatedRun(`${PLANNED_BENCHMARK}finally:\n  - id: report\n    command: teamai benchmark report\n`);

    await cancelRun(config, runId, {});

    const run = await readRun(config, runId);
    expect(typeof run === 'object' && { status: run.status, report: run.steps.find((step) => step.id === 'report') }).toEqual({ status: 'cancelled', report: undefined });
  });

  it('leases a trial prompt in a clone of the starting commit with the arm\'s team once its task baseline fails there', async () => {
    const { config, runId } = await startFix();
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: {
      step: 'trials.r1.t01.a01.prompt',
      prompt: 'Make the test pass.',
      tool: 'claude',
      workspace: { base: { commit: RUN_START }, configCommit: RUN_START, clone: { commit: RUN_START, team: { revision: RUN_TEAM, treatment: 'pulled' } } },
    } } });
  });

  it.each([
    'Fix the literal {{ inputs.customer }} placeholder.',
    'Keep \\{{ steps.build.outputs.text }} and ${{ inputs.ref }} as they are.',
  ])('leases a trial prompt as its task wrote it, a workflow read in it included: %s', async (prompt) => {
    const { config, runId } = await startFix({ prompt });
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: { step: 'trials.r1.t01.a01.prompt', prompt } } });
  });

  it.each([
    ['none', { treatment: 'none' }],
    ['{ without: [skills/fixer, rules/commits.md] }', { revision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [], enabledAgents: ['claude'] }, treatment: { without: ['rules/commits.md', 'skills/fixer'] } }],
    ['main', { revision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [], enabledAgents: ['claude'] }, treatment: 'main' }],
  ])('opens each trial of an arm with team %s in a clone with that team', async (team, expected) => {
    const { config, runId } = await startFix({ arms: 2, teams: ['', team] });

    const run = await readRun(config, runId);

    const arm = typeof run === 'object' ? stepDefinitions(run)('trials.r1.t01.a02') : undefined;
    expect(arm?.workspace).toEqual({ clone: { commit: RUN_START, repo: 'https://github.com/fixture/app.git', team: expected } });
  });

  it('gives a trial clone the recall setting its arm asks for, and leaves it off when the arm asks nothing', async () => {
    // A suite that measures declared relations needs recall on in both arms: that is the
    // only path a relation takes to a session (#1564). A workflow clone keeps it off.
    const recallOf = (run: Awaited<ReturnType<typeof readRun>>): boolean | undefined => {
      const place = stepDefinitions(run as RunState)('trials.r1.t01.a01')?.workspace;
      if (typeof place !== 'object' || !('clone' in place)) return undefined;
      const team = ClonePlaceSchema.parse(place.clone).team;

      return 'recall' in team ? team.recall : undefined;
    };

    const on = await startFix({ armsYaml: '{ name: a01, recall: true }' });
    expect(recallOf(await readRun(on.config, on.runId))).toBe(true);

    const off = await startFix();
    expect(recallOf(await readRun(off.config, off.runId))).toBeUndefined();
  });

  it.each([
    ['the limits its suite sets', '{ timeout: 5m, budget: { tokens: 1000 }, max_turns: 3 }',
      { timeoutMs: 300_000, maxTurns: 3, budget: { tokens: 1000 }, onLimit: 'end_turn' }, { timeoutMs: 300_000, tokens: 1000, maxTurns: 3 }],
    ['no limits when its suite sets none', '', undefined, undefined],
  ])('leases each trial prompt %s, and records them', async (_, trial, leased, recorded) => {
    const { config, runId } = await startFix({ trial });
    await settleBaselines(config, runId, driver, can);

    const next = LeaseSchema.extend({ data: z.object({ lease: z.object({ limits: z.unknown().optional() }).passthrough() }) })
      .parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next.data.lease.limits).toEqual(leased);
    expect(next.data.lease).not.toHaveProperty('trial');
    expect(recordOf(run).limits).toEqual(recorded);
  });

  it("keeps the limit that ended a trial's prompt on its step, and records it", async () => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, limit: 'timeout', durationMs: 300_000 });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'succeeded', limit: 'timeout' });
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ step: 'trials.r1.t01.a01.prompt', limit: 'timeout' })]);
  });

  it("records the suite limits a trial's driver did not enforce", async () => {
    const { config, runId } = await startFix({ trial: '{ budget: { tokens: 1000 }, max_turns: 3 }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, tokens: { input: 10, output: 10 }, durationMs: 1000, unenforced: ['budget', 'max_turns'] });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({
      status: 'succeeded', unenforced: expect.arrayContaining([{ requirement: 'budget' }, { requirement: 'max_turns', asked: 3 }]),
    });
    // max_turns at lease, as this driver declares no can.max_turns; budget from its report.
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ unenforced: ['max_turns', 'budget'] })]);
  });

  it('leases a driver that cannot end the turn a trial prompt under on_limit: fail, and records on_limit as not enforced', async () => {
    const { config, runId } = await startFix({ trial: '{ timeout: 10s }' });
    const noEndTurn: DriverCan = { ...can, end_turn: false };
    await settleBaselines(config, runId, driver, noEndTurn);
    const leased = await leaseNext(config, runId, driver, { can: noEndTurn, prepare: true });
    const prompt = LeaseSchema.parse(leased).data.lease;
    const terms = z.object({ data: z.object({ lease: z.object({ unenforced: z.unknown(), limits: z.unknown().optional() }) }) }).parse(leased).data.lease;
    await reportAttempt(config, runId, { attempt: prompt.attempt, revision: prompt.revision, outcome: 'success', driver });
    const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can: noEndTurn, prepare: true })).data.lease;

    await reportAttempt(config, runId, { attempt: check.attempt, revision: check.revision, outcome: 'success', exitCode: 0, outputs: await trialCheckOutput(config, runId, { checkStep: check.step, result: 'passed' }), driver });
    await leaseNext(config, runId, driver, { can: noEndTurn, prepare: true });
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    // Under on_limit: fail the trial's timeout is the lease's deadline, which fails it, so the lease carries no limits.
    expect(terms).toEqual({ unenforced: [{ requirement: 'on_limit' }] });
    expect((await judgedRecordOf(config, run)).trials).toEqual([expect.objectContaining({ result: 'passed', unenforced: ['on_limit'] })]);
  });

  it('refuses a trial report that names an unenforced budget its suite does not set', async () => {
    const { config, runId } = await startFix();
    const lease = await leasePrompt(config, runId);

    const answer = await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, unenforced: ['budget'] });

    expect(answer).toEqual({ error: { code: 'invalid_report', message: `Attempt ${lease.attempt} of step "trials.r1.t01.a01.prompt": unenforced names budget, which the step does not set` } });
  });

  it('fails a trial prompt under a budget whose report has no tokens, so the trial is an error', async () => {
    const { config, runId } = await startFix({ trial: '{ budget: { tokens: 1000 } }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, durationMs: 1000 });
    await leaseNext(config, runId, driver, { can, prepare: true });
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'failed', failure: {
      code: 'budget_unmeasured',
      message: 'Step "trials.r1.t01.a01.prompt" ends its turn at a token budget, and its report has no tokens, so the budget cannot count what it spent. Run its tool with a driver that reports its tokens, then retry the step.',
    } });
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ result: 'error' })]);
  });

  it.each<[string, Array<'budget'> | undefined]>([
    ['', undefined],
    [', once when its report also lists it, as a driver that cannot hold the tool to it does', ['budget']],
  ])('records the budget as unenforced when another limit stopped a trial prompt before its tool stated tokens%s, and lets its check decide', async (_, listed) => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m, budget: { tokens: 1000 } }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, limit: 'timeout', durationMs: 300_000, ...(listed ? { unenforced: listed } : {}) });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'succeeded', limit: 'timeout', unenforced: expect.arrayContaining([{ requirement: 'budget' }]) });
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ limit: 'timeout', unenforced: ['budget'] })]);
  });

  it('refuses a trial report whose limit comes with an outcome other than success, and keeps the trial leased', async () => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m }' });
    const lease = await leasePrompt(config, runId);

    const answer = await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver, limit: 'timeout' });
    const run = await readRun(config, runId);

    expect(answer).toEqual({ error: { code: 'invalid_report', message: `Attempt ${lease.attempt} of step "trials.r1.t01.a01.prompt": limit goes with outcome success, since a limit ends the agent's turn and the step succeeds; send outcome success, or omit limit` } });
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'leased' });
  });

  it('ends the run succeeded when a trial fails', async () => {
    const { config, runId } = await startFix();
    const lease = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded' } } });
  });

  it.each([
    ['passed', { result: 'passed', verdicts: [{ scorer: 'teamai:correctness:t01', outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true }, decider: { by: 'check', task: 'TASK' } }] }, []],
    ['failed', { result: 'failed', verdicts: [{ scorer: 'teamai:correctness:t01', outcome: { kind: 'labelled', label: 'incorrect', score: 0, passed: false }, decider: { by: 'check', task: 'TASK' } }] }, []],
    ['could_not_run', { result: 'error', failure: { cause: 'not_found' }, verdicts: [{ scorer: 'teamai:correctness:t01', outcome: { kind: 'unscored', because: 'check_could_not_run' } }] }, ['Trial 1/1 t01 a01: not_found']],
  ] as const)('records a trial whose check outputs %s by the correctness label that check stored, launching no judge', async (output, recorded, unchecked) => {
    const { config, runId } = await startFix();
    const prompt = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...prompt, outcome: 'success', driver });
    const check = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), command: z.string() }) }) })
      .parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;

    await reportAttempt(config, runId, { attempt: check.attempt, revision: check.revision, outcome: 'success', exitCode: 0, outputs: await trialCheckOutput(config, runId, { checkStep: check.step, result: output }), driver });
    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const planned = planOfRun(run);
    if ('failure' in planned) throw new Error(planned.failure.message);
    const task = planned.found.plan.tasks[0]?.sourceHash;
    const record = await judgedRecordOf(config, run);
    expect(check).toMatchObject({ step: 'trials.r1.t01.a01.check', command: 'node test.js' });
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(record.trials).toEqual([expect.objectContaining(JSON.parse(JSON.stringify(recorded).replaceAll('TASK', task ?? '')))]);
    expect(record.scorers).toEqual([{ name: 'teamai:correctness:t01', rubric: { sourceHash: expect.any(String) }, labels: [{ value: 'correct', score: 1 }, { value: 'incorrect', score: 0 }], passingScore: 1 }]);
    expect(run.steps.map((step) => step.id).filter((id) => id.includes('score'))).toEqual([]);
    expect(uncheckedOf(run)).toEqual(unchecked);
  });

  it('fails a check step reported without its exit code, whatever outputs the report carries', async () => {
    const { config, runId } = await startFix();
    const prompt = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...prompt, outcome: 'success', driver });
    const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);

    const decided = await decideCheckReport({ config, run, report: { ...check, outcome: 'success', driver, outputs: { result: 'passed', cause: '', label: '' } } });

    expect(decided).toMatchObject({ outcome: 'failed', failure: { code: 'invalid_report', message: expect.stringContaining('report its exitCode') } });
    expect(decided).not.toHaveProperty('outputs');
  });

  it.each([
    ['passed', 'invalid', []],
    ['could_not_run', 'could_not_run', ['Baseline t01: not_found']],
  ] as const)('runs no trial of a task whose baseline %s, and ends the run with its baseline in the record', async (baseline, recorded, unchecked) => {
    const { config, runId } = await startFix({ arms: 2, repetitions: 2 });
    await settleBaselines(config, runId, driver, can, { t01: baseline });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(recordOf(run)).toMatchObject({
      tasks: [{ id: 't01', baseline: recorded }],
      trials: Array(4).fill(expect.objectContaining({ result: 'not_run' })),
    });
    expect(uncheckedOf(run)).toEqual(unchecked);
  });

  it('records that the check could not run for a baseline the run stopped while it ran', async () => {
    const { config, runId } = await startFix();
    LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    await cancelRun(config, runId, {});

    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(recordOf(run)).toMatchObject({ tasks: [{ id: 't01', baseline: 'could_not_run' }], trials: [{ result: 'not_run' }] });
  });

  it('records that the check could not run for a baseline whose step failed without a result, as when its setup fails', async () => {
    const { config, runId } = await startFix();
    const baseline = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { attempt: baseline.attempt, revision: baseline.revision, outcome: 'failed', driver });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(recordOf(run)).toMatchObject({ tasks: [{ id: 't01', baseline: 'could_not_run' }], trials: [{ result: 'not_run' }] });
    expect(uncheckedOf(run)).toEqual(['Baseline t01: its step failed']);
  });

  it("ends the run failed at its timeout while a trial's check runs, and records the trial an error", async () => {
    const { config, runId } = await startFix();
    const prompt = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...prompt, outcome: 'success', driver });
    LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } });
    expect(recordOf(run)).toMatchObject({ tasks: [{ id: 't01', baseline: 'valid' }], trials: [{ step: 'trials.r1.t01.a01.prompt', result: 'error', failure: { cause: 'timeout' } }] });
  });

  it("runs a task's trials whatever another task's baseline did, and ends the run succeeded with both scopes failed", async () => {
    const { config, runId } = await startFix({ tasks: 2 });
    await settleBaselines(config, runId, driver, can, { t01: 'could_not_run' });
    const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(lease.step).toBe('trials.r1.t02.a01.prompt');
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(recordOf(run)).toMatchObject({
      tasks: [{ id: 't01', baseline: 'could_not_run' }, { id: 't02', baseline: 'valid' }],
      trials: [{ task: 't01', result: 'not_run' }, { task: 't02', result: 'error' }],
    });
  });

  it('names each trial whose work ended in an error, with why, when no trial produced a result', async () => {
    const { config, runId } = await startFix({ tasks: 2 });
    await settleBaselines(config, runId, driver, can, { t01: 'passed' });
    const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver, failure: { code: 'sandbox_failed', message: 'The attempt socket is too long.' } });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ task: 't01', result: 'not_run' }), expect.objectContaining({ task: 't02', result: 'error' })]);
    expect(unmeasuredOf(run)).toEqual(['Trial 2/2 t02 a01: sandbox_failed: The attempt socket is too long.']);
  });

  it('names no errored trial once another trial produced a result', async () => {
    const { config, runId } = await startFix({ arms: 2 });
    const failed = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...failed, outcome: 'failed', driver, failure: { code: 'sandbox_failed', message: 'The attempt socket is too long.' } });
    const prompt = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...prompt, outcome: 'success', driver });
    const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...check, outcome: 'success', exitCode: 0, outputs: await trialCheckOutput(config, runId, { checkStep: check.step, result: 'failed' }), driver });

    await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(recordOf(run).trials.map(({ result }) => result)).toEqual(['error', 'unscored']);
    expect(unmeasuredOf(run)).toEqual([]);
  });

  it('names a trial that broke, and none that the cancel of the run stopped', async () => {
    const { config, runId } = await startFix({ arms: 2 });
    const failed = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...failed, outcome: 'failed', driver, failure: { code: 'sandbox_failed', message: 'The attempt socket is too long.' } });
    LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true }));

    await cancelRun(config, runId, {});

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(recordOf(run).trials.map(({ result }) => result)).toEqual(['error', 'error']);
    expect(unmeasuredOf(run)).toEqual(['Trial 1/2 t01 a01: sandbox_failed: The attempt socket is too long.']);
  });

  it('names the step of a workflow arm that failed, not a sibling cancelled beside it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
    dirs.push(root);
    const config = benchmarkRunConfig(root);
    const files = suiteOf({ armsYaml: '{ name: flow }' });
    const frozen = await frozenBenchmark(config, files);
    if (!('plan' in frozen)) throw new Error(JSON.stringify(frozen));
    // fix runs after explore whatever explore did, as the plan chains its own steps, so cancelling explore leaves fix to run and fail.
    const key = 'two-ways.0123456789ab';
    const pinned: PinnedArmWorkflow = {
      name: 'two-ways', sourceHash: 'c'.repeat(64), key,
      files: { [key]: { schemaVersion: 'v1alpha1', name: key, description: 'Two ways.', inputs: { task: 'string' }, steps: [
        { id: 'explore', prompt: 'Explore: {{ inputs.task }}', tool: 'claude' },
        { id: 'fix', needs: ['explore'], if: 'steps.explore.outcome != null', prompt: 'Fix it.', tool: 'claude' },
      ] } },
    };
    const arms = frozen.plan.arms.map((arm) => ({ ...arm, workflow: { name: pinned.name, sourceHash: pinned.sourceHash } }));
    const plan: BenchmarkPlan = { ...frozen.plan, arms, trials: trialsOf(frozen.committed.suite.tasks, arms, 1) };
    const { scorers: _generated, ...bundle } = compileBundle(plan, frozen.committed, { armWorkflows: new Map([['flow', pinned]]), unattended: false, correctnessRubric: frozen.correctnessRubric });
    const started = await startBenchmarkRun(config, files, { outputsOf: () => ({ definition: bundle, plan }) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    await settleBaselines(config, runId, driver, can);
    const explore = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await cancelRun(config, runId, {}, explore.step);
    const fix = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;

    await reportAttempt(config, runId, { ...fix, outcome: 'failed', driver, failure: { code: 'tool_failed', message: 'The tool exited 1.' } });

    await leaseNext(config, runId, driver, { can, prepare: true });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect([explore.step, fix.step]).toEqual(['trials.r1.t01.flow.workflow.explore', 'trials.r1.t01.flow.workflow.fix']);
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(unmeasuredOf(run)).toEqual(['Trial 1/1 t01 flow: tool_failed: The tool exited 1.']);
  });

  it('leaves a trial whose work succeeded and whose check could not run to the unchecked checks, though no trial produced a result', async () => {
    const { config, runId } = await startFix();
    const prompt = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...prompt, outcome: 'success', driver });
    const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...check, outcome: 'success', exitCode: 0, outputs: await trialCheckOutput(config, runId, { checkStep: check.step, result: 'could_not_run' }), driver });

    await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(recordOf(run).trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(uncheckedOf(run)).toEqual(['Trial 1/1 t01 a01: not_found']);
    expect(unmeasuredOf(run)).toEqual([]);
  });

  it('holds every baseline and trial from its only driver when that driver is not a sandbox, rather than settling them', async () => {
    const { config, runId } = await startFix({ tasks: 2, parallel: 2 });

    const next = await leaseNext(config, runId, driver, { can: { ...can, isolation: 'none' }, prepare: true, alone: { driver: 'local', offers: [{ runtime: 'local', can: { ...can, isolation: 'none' } }] } });

    expect(next).toMatchObject({ data: { wait: { held: [{ step: 'trials.baselines.t01', missing: ['isolation'] }, { step: 'trials.baselines.t02', missing: ['isolation'] }] } } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: expect.arrayContaining([expect.objectContaining({ id: 'trials.baselines', status: 'running' })]) });
  });

  it('runs a suite that allows more lanes than it has trials, its one trial in the first lane', async () => {
    const { config, runId } = await startFix({ parallel: 2 });
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: { step: 'trials.lane1.r1.t01.a01.prompt' } } });
  });

  it('leases its only driver the trials it can take, and settles the others at once', async () => {
    const { config, runId } = await startFix({ arms: 2, tools: ['codex'] });
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true, alone: { driver: 'local', offers: [{ runtime: 'local', can }] } });

    const run = await readRun(config, runId);
    expect(next).toMatchObject({ data: { lease: { step: 'trials.r1.t01.a02.prompt' } } });
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
  });

  it('rotates the arms by one place per repetition', () => {
    const arms = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];

    const trials = trialsOf([{ id: 'task' }], arms, 3);

    expect(trials.map((trial) => `${trial.repetition}${trial.arm}`)).toEqual(['1A', '1B', '1C', '2B', '2C', '2A', '3C', '3A', '3B']);
    expect(trials.map((trial) => trial.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // Retried, so a busy machine's one slow round does not fail it; a regression is slow every time. A second leaves room for
  // a CI runner several times slower than a laptop, where each takes tens of milliseconds. The test's own timeout bounds
  // building the 1,200-trial run, about 5 s on a laptop, not the calls it measures.
  it('reconciles a new run of 20 tasks, 6 arms and 10 repetitions in 32 lanes, and answers a poll on it, in under a second each', { retry: 2, timeout: 60_000 }, async () => {
    const { config, runId } = await startFix({ tasks: 20, arms: 6, repetitions: 10, parallel: 32 });
    await settleBaselines(config, runId, driver, can);
    const unsandboxed = { ...can, isolation: 'none' as const };
    const reconciled: number[] = [];
    const polled: number[] = [];
    const reconcileMs: number[] = [];
    const pollMs: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const run = await readRun(config, runId);
      if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
      const started = performance.now();
      const result = reconcileRun(run, new Date().toISOString());
      reconcileMs.push(performance.now() - started);
      reconciled.push('ready' in result ? result.ready.length : 0);
    }
    await leaseNext(config, runId, driver, { can: unsandboxed, prepare: true });
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      const next = await leaseNext(config, runId, driver, { can: unsandboxed, prepare: true });
      pollMs.push(performance.now() - started);
      polled.push(HeldSchema.parse(next).data.wait.held.length);
    }

    // The first trial of each lane is ready; the other 1168 wait on the one before them.
    expect(reconciled).toEqual([32, 32, 32]);
    expect(polled).toEqual([32, 32, 32]);
    // The fastest of three is the least noisy estimate of what one call costs.
    expect(Math.min(...reconcileMs)).toBeLessThan(1000);
    expect(Math.min(...pollMs)).toBeLessThan(1000);
  });
});

/** One task judged by success criteria, one arm: a run whose only trial is judged by its generated correctness scorer. */
const CRITERIA_SUITE: BenchmarkSuiteFiles = {
  name: 'fix',
  suite: 'schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [{ name: a01 }]\nrepetitions: 1\ntimeout: 10m\n',
  tasks: { t01: "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\nsuccessCriteria: The test passes.\n" },
};
const CORRECTNESS = 'teamai:correctness:t01';
const PROMPT = 'trials.r1.t01.a01.prompt';
const RUN_NOW = '2026-11-08T10:00:00.000Z';

/** A criteria run whose one trial prompt has succeeded. */
async function judgedTrial(): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, CRITERIA_SUITE);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude' });
  return { config, runId };
}

describe('benchmark run judges', () => {
  it("ends once its trial prompt succeeded, without waiting for a judge, and a trial no scorer labelled is unscored", async () => {
    const { config, runId } = await judgedTrial();

    const done = await leaseNext(config, runId, driver, { can, prepare: true });

    const ended = await readRun(config, runId);
    if (typeof ended !== 'object') throw new Error(`run ${runId} is ${ended}`);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(ended).not.toHaveProperty('verdicts');
    expect(recordOf(ended).trials).toMatchObject([{ step: PROMPT, result: 'unscored' }]);
  });

  it("pins a generated correctness scorer per task, by its rubric's hash, and leaves judging each trial to the workflow's own steps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
    dirs.push(root);
    const config = benchmarkRunConfig(root);
    const t02 = (CRITERIA_SUITE.tasks.t01 ?? '').replace('The test passes.', 'Both tests pass.');
    const started = await startBenchmarkRun(config, { ...CRITERIA_SUITE, tasks: { ...CRITERIA_SUITE.tasks, t02 } });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    for (let trial = 0; trial < 2; trial += 1) {
      const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
      await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude' });
    }

    const done = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const read = await RunScorers.of(config, run);
    const pins = read.ok ? read.pins : {};
    expect(Object.keys(pins).sort()).toEqual([CORRECTNESS, 'teamai:correctness:t02']);
    expect(Object.values(pins).map((pin) => pin.generated)).toEqual([true, true]);
    expect(pins[CORRECTNESS]?.sourceHash).not.toBe(pins['teamai:correctness:t02']?.sourceHash);
    expect(stepDefinitions(run)(PROMPT)?.scorers).toEqual({ names: [CORRECTNESS], sampling: 'all', start: 'workflow' });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });
});

/** The planned benchmark with the shipped workflow's steps that list each trial pass and label it with teamai-score. */
const SCORED_BENCHMARK = `${PLANNED_BENCHMARK}  - id: subjects
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
`;

/** The judge of a stored label, as a confined run of `tool` records it. */
type LabelJudge = { tool: string; model?: { alias?: string; requested?: string; reported?: string }; effort?: { requested?: string }; batched?: true };

/**
 * The verdicts recorded for the one trial of the criteria suite, once its score step labelled its correctness `correct`
 * with a judge of `judge`, its plan pinning `judges` over those it froze.
 */
async function judgedVerdicts(judge: LabelJudge, judges: Record<string, { tool: string; model: string }> = {}): Promise<BenchmarkRecord['trials'][number]['verdicts']> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, CRITERIA_SUITE, {
    body: SCORED_BENCHMARK,
    outputsOf: (bundle, plan) => ({ definition: { ...bundle, workflows: {} }, plan: { ...plan, judges: { ...plan.judges, ...judges } } }),
  });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const subject = `run:${runId}:${PROMPT}:1`;
  const written = await LabelStore.append(config, [{ label: {
    scorer: CORRECTNESS, rubric: { sourceHash: 'rubric-1' }, label: 'correct', score: 1, passed: true, scoredAt: '2026-11-08T10:12:03.000Z', source: 'workflow',
    subject: { runId, step: PROMPT, pass: 1 }, judge: { kind: 'model', isolation: 'verified', access: 'read', ...judge },
  }, reasoning: 'The test passes.' }], { outbox: false });
  if (written.status === 'busy') throw new Error('the label store is busy');
  const outputs: Record<string, unknown> = {
    subjects: { list: [subject] },
    plan: { groups: [{ subject, hand: '', scorers: CORRECTNESS, model: '', ci: false, protected: false }] },
    evidence: { dir: root, rubric: 'Judge it.', schema: path.join(root, 'answer.schema.json'), delivers: false },
    judge: { answer: { label: 'correct', reasoning: 'The test passes.' } },
    label: { labels: [{ scorer: CORRECTNESS, label: 'correct', code: '' }] },
    write: { written: 1, labels: written.kept.map(({ version }) => version) },
  };
  const judging: DriverCan = { ...can, confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: [...can.workspace ?? [], 'team'] };
  for (;;) {
    const answer = await leaseNext(config, runId, driver, { can: judging, prepare: true });
    const lease = LeaseSchema.safeParse(answer);
    if (!lease.success) break;
    const { step, attempt, revision } = lease.data.data.lease;
    await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs: outputs[step.split('.').at(-1) ?? step] ?? {} });
  }

  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  return (await judgedRecordOf(config, run)).trials[0]?.verdicts;
}

/** The criteria suite's task with a check too, as both decide it. */
const MIXED_SUITE: BenchmarkSuiteFiles = { ...CRITERIA_SUITE, tasks: { t01: `${CRITERIA_SUITE.tasks.t01 ?? ''}check: { run: node test.js, protect: [test.js] }\n` } };

/**
 * The record of the one trial of the mixed suite, once its check said `checked` and the score step ran: a failed check
 * stored its label, so `teamai score plan` planned no judge; a passed one stored none, and a judge labelled it `correct`.
 */
async function mixedTrial(checked: 'passed' | 'failed'): Promise<{ trial: BenchmarkRecord['trials'][number] | undefined; task: string | undefined }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, MIXED_SUITE, { body: SCORED_BENCHMARK });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const subject = `run:${runId}:${PROMPT}:1`;
  await settleBaselines(config, runId, driver, can);
  const judging: DriverCan = { ...can, confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: [...can.workspace ?? [], 'team'] };
  for (;;) {
    const lease = LeaseSchema.safeParse(await leaseNext(config, runId, driver, { can: judging, prepare: true }));
    if (!lease.success) break;
    const { step, attempt, revision } = lease.data.data.lease;
    const id = step.split('.').at(-1) ?? step;
    let outputs: unknown = {};
    if (id === 'check') outputs = checked === 'failed' ? await trialCheckOutput(config, runId, { checkStep: step, result: 'failed' }) : { result: 'passed', cause: '', label: '' };
    if (id === 'subjects') outputs = { list: [subject] };
    if (id === 'plan') outputs = { groups: checked === 'failed' ? [] : [{ subject, hand: '', scorers: CORRECTNESS, model: '', ci: false, protected: false }] };
    if (id === 'evidence') outputs = { dir: root, rubric: 'Judge it.', schema: path.join(root, 'answer.schema.json'), delivers: false };
    if (id === 'label') outputs = { labels: [{ scorer: CORRECTNESS, label: 'correct', code: '' }] };
    if (id === 'write') {
      const written = await LabelStore.append(config, [{ label: {
        scorer: CORRECTNESS, rubric: { sourceHash: 'rubric-1' }, label: 'correct', score: 1, passed: true, scoredAt: RUN_NOW, source: 'workflow',
        subject: { runId, step: PROMPT, pass: 1 }, judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-x' }, isolation: 'verified', access: 'read' },
      } }], { outbox: false });
      outputs = { written: 1, labels: written.status === 'busy' ? [] : written.kept.map(({ version }) => version) };
    }
    await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs });
  }

  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  const record = await judgedRecordOf(config, run);
  return { trial: record.trials[0], task: record.tasks[0]?.sourceHash };
}

describe('benchmark run verdicts of a task with a check and success criteria', () => {
  it('decide a trial whose check failed by the label its check stored, with no judge', async () => {
    const { trial, task } = await mixedTrial('failed');

    expect(trial).toMatchObject({
      result: 'failed',
      verdicts: [{ scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'incorrect', score: 0, passed: false }, decider: { by: 'check', task } }],
    });
  });

  it("decide a trial whose check passed by its judge's label", async () => {
    const { trial } = await mixedTrial('passed');

    expect(trial).toMatchObject({
      result: 'passed',
      verdicts: [{ scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true }, decider: { by: 'judge', tool: 'claude', model: 'claude-x' } }],
    });
    expect(trial?.verdicts).toHaveLength(1);
  });
});

describe('benchmark run verdicts', () => {
  it("record a judged label with the judge that decided it: its rubric, tool, the model and effort its tool reported or was launched with, and whether it batched", async () => {
    const verdicts = await judgedVerdicts(
      { tool: 'claude', model: { requested: 'claude-opus-5-5', reported: 'claude-opus-5-5-20261101', alias: 'opus' }, effort: { requested: 'high' }, batched: true },
      { [CORRECTNESS]: { tool: 'claude', model: 'opus' } },
    );

    expect(verdicts).toEqual([{
      scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true },
      decider: { by: 'judge', rubric: 'rubric-1', tool: 'claude', model: 'claude-opus-5-5-20261101', effort: 'high', batched: true },
      asPlanned: 'match',
    }]);
  });

  it.each([
    ['another tool than the plan pins', { tool: 'codex', model: { reported: 'gpt-6-sol' } }, { tool: 'claude', model: '' }, 'deviation'],
    ['the alias the plan pins, whatever model it resolved to', { tool: 'claude', model: { alias: 'judge', requested: 'claude-sonnet-5-5', reported: 'claude-sonnet-5-5' } }, { tool: 'claude', model: 'judge' }, 'match'],
    ['another alias than the plan pins', { tool: 'claude', model: { alias: 'strong', requested: 'opus', reported: 'claude-opus-5-5' } }, { tool: 'claude', model: 'judge' }, 'deviation'],
    ['the model name the plan pins, which is no alias', { tool: 'claude', model: { requested: 'opus', reported: 'claude-opus-5-5' } }, { tool: 'claude', model: 'opus' }, 'match'],
    ['another model than the tool default the plan pins', { tool: 'claude', model: { requested: 'opus', reported: 'claude-opus-5-5' } }, { tool: 'claude', model: '' }, 'deviation'],
    ['no model its tool reported', { tool: 'claude', model: { alias: 'judge', requested: 'opus' } }, { tool: 'claude', model: 'judge' }, 'not_verified'],
    ['another tool, and no model its tool reported', { tool: 'codex' }, { tool: 'claude', model: '' }, 'deviation'],
  ] as const)('compare a label judged with %s with the plan', async (_, judge, planned, asPlanned) => {
    expect(await judgedVerdicts(judge, { [CORRECTNESS]: planned })).toEqual([expect.objectContaining({ scorer: CORRECTNESS, asPlanned })]);
  });

  it.each([
    ['no offer has the judge tool its plan requires', 'confined', 'judge_tool_unavailable'],
    ['no offered tool resolves its model', 'model', 'run_ended'],
  ] as const)("leave a trial unscored when the skill driver gives its judge up because %s, and say judge_tool_unavailable only for the tool", async (_, missing, because) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
    dirs.push(root);
    const config = benchmarkRunConfig(root);
    const started = await startBenchmarkRun(config, CRITERIA_SUITE, { body: SCORED_BENCHMARK });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const subject = `run:${runId}:${PROMPT}:1`;
    const evidence = path.join(runScratchDir(config, runId), 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    // As teamai score evidence writes it for a scorer the plan pins to claude.
    fs.writeFileSync(path.join(evidence, 'confined.json'), '{"level":"best-effort","require":"claude"}');
    const outputs: Record<string, unknown> = {
      subjects: { list: [subject] },
      plan: { groups: [{ subject, hand: '', scorers: CORRECTNESS, model: '', ci: false, protected: false }] },
      evidence: { dir: evidence, rubric: 'Judge it.', schema: path.join(evidence, 'answer.schema.json'), delivers: false },
    };
    const codexOnly: DriverCan = { ...can, confined: [{ level: 'best-effort', access: 'read', tools: ['codex'] }], workspace: [...can.workspace ?? [], 'team'] };
    let waited: unknown;
    for (;;) {
      const answer = await leaseNext(config, runId, driver, { can: codexOnly, prepare: true });
      const lease = LeaseSchema.safeParse(answer);
      if (!lease.success) {
        waited = answer;
        break;
      }
      const { step, attempt, revision } = lease.data.data.lease;
      await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs: outputs[step.split('.').at(-1) ?? step] ?? {} });
    }
    const held = HeldSchema.parse(waited).data.wait.held.map((entry) => ({ step: z.object({ step: z.string() }).parse(entry).step, missing: [missing] }));
    await inProcessClient({ config, env: await resolveWorkflowEnv(config) }).giveUp(runId, held);

    const done = await leaseNext(config, runId, driver, { can: codexOnly, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const record = await judgedRecordOf(config, run);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(record.trials).toEqual([expect.objectContaining({ result: 'unscored', verdicts: [{ scorer: CORRECTNESS, outcome: { kind: 'unscored', because } }] })]);
    const unoffered = 'No driver of the run offered judge claude, so 1 trial went unscored; drive the run where claude is installed, or set tool in the scorer.';
    expect(formatBenchmarkTable(benchmarkTable({ benchmark: record })).includes(unoffered)).toBe(because === 'judge_tool_unavailable');
  });

  it('leave a trial unscored when its score step labelled it and the write failed, though an earlier write stored that label', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
    dirs.push(root);
    const config = benchmarkRunConfig(root);
    const started = await startBenchmarkRun(config, CRITERIA_SUITE, { body: SCORED_BENCHMARK });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const subject = `run:${runId}:${PROMPT}:1`;
    const outputs: Record<string, unknown> = {
      subjects: { list: [subject] },
      plan: { groups: [{ subject, hand: '', scorers: CORRECTNESS, model: '', ci: false, protected: false }] },
      evidence: { dir: root, rubric: 'Judge it.', schema: path.join(root, 'answer.schema.json'), delivers: false },
      judge: { answer: { label: 'correct', reasoning: 'The test passes.' } },
      label: { labels: [{ scorer: CORRECTNESS, label: 'correct', code: '' }] },
    };
    const judging: DriverCan = { ...can, confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: [...can.workspace ?? [], 'team'] };
    for (;;) {
      const answer = await leaseNext(config, runId, driver, { can: judging, prepare: true });
      const lease = LeaseSchema.safeParse(answer);
      if (!lease.success) break;
      const { step, attempt, revision } = lease.data.data.lease;
      const id = step.split('.').at(-1) ?? step;
      await reportAttempt(config, runId, id === 'write'
        ? { attempt, revision, outcome: 'failed', driver, failure: { code: 'command_failed', message: 'Another teamai process is writing the score labels.' } }
        : { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs: outputs[id] ?? {} });
    }
    await LabelStore.append(config, [{ label: {
      scorer: CORRECTNESS, rubric: { sourceHash: 'rubric-1' }, label: 'correct', score: 1, passed: true, scoredAt: '2026-11-03T10:00:00.000Z', source: 'workflow',
      subject: { runId, step: PROMPT, pass: 1 }, judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-x' }, isolation: 'verified', access: 'read' },
    }, reasoning: 'The test passes.' }]);

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const planned = planOfRun(run);
    if ('failure' in planned) throw new Error(planned.failure.message);
    expect(await TrialVerdicts.of(config, run, planned.found)).toEqual([{ scorer: CORRECTNESS, step: PROMPT, pass: 1, outcome: { kind: 'unscored', because: 'run_ended' } }]);
  });
});

describe('benchmark judge calls', () => {
  /**
   * The groups `teamai score plan` gives the one trial of a criteria suite judged by `scorers` too, its plan pinning
   * `judges`, for the scorers `named` (none: those the trial pinned), once `labelled` gives its correctness scorer a label
   * of that judge kind on that pass.
   */
  async function plannedGroups(judges: Record<string, { tool: string; model: string }>, { named = [], labelled }: { named?: string[]; labelled?: { judge: 'stage' | 'model'; pass: number } } = {}): Promise<unknown> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
    dirs.push(root);
    const config = benchmarkRunConfig(root);
    for (const scorer of ['quality', 'tidy']) {
      fs.mkdirSync(path.join(config.repo.localPath, 'scorers'), { recursive: true });
      fs.writeFileSync(path.join(config.repo.localPath, 'scorers', `${scorer}.md`), '---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 1\nsamplingRate: 100\n---\nJudge the change.\n');
    }
    const suite = { ...CRITERIA_SUITE, suite: `${CRITERIA_SUITE.suite}scorers: [quality, tidy]\n` };
    const started = await startBenchmarkRun(config, suite, {
      body: SCORED_BENCHMARK,
      outputsOf: (bundle, plan) => ({ definition: { ...bundle, workflows: {} }, plan: { ...plan, judges: { ...plan.judges, ...judges } } }),
    });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const subject = `run:${runId}:${PROMPT}:1`;
    const judging: DriverCan = { ...can, confined: [{ level: 'verified', access: 'read', tools: ['claude'] }], workspace: [...can.workspace ?? [], 'team'] };
    for (;;) {
      const { step, attempt, revision } = LeaseSchema.parse(await leaseNext(config, runId, driver, { can: judging, prepare: true })).data.lease;
      if (step.endsWith('.plan')) {
        if (labelled) {
          const judge = labelled.judge === 'stage' ? { judge: { kind: 'stage' as const }, decidedBy: 'check' as const } : { judge: { kind: 'model' as const, tool: 'claude', model: { reported: 'claude-x' }, isolation: 'verified' as const, access: 'read' as const } };
          await LabelStore.append(config, [{ label: {
            scorer: CORRECTNESS, rubric: { sourceHash: 'rubric-1' }, label: 'incorrect', score: 0, passed: false, scoredAt: RUN_NOW, source: 'workflow', subject: { runId, step: PROMPT, pass: labelled.pass }, ...judge,
          } }], { outbox: false });
        }
        return ScoreVerbs.plan({ subject, scorers: JSON.stringify(named), batch: 'true', demand: 'named' }, { env: attemptEnv(config, runId, attempt, 'unattended'), current: config, now: RUN_NOW });
      }
      await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver, tool: 'claude', outputs: step === 'subjects' ? { list: [subject] } : {} });
    }
  }

  it("judges a trial's correctness scorer in a call of its own, and batches the suite's scorers that share a judge", async () => {
    const judges = { quality: { tool: 'claude', model: '' }, tidy: { tool: 'claude', model: '' } };

    expect(await plannedGroups(judges)).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality,tidy' }, { scorers: CORRECTNESS }] } });
  });

  it.each([
    ['a label a stage decided on its pass, as a failed check writes it, leaves it out of the pinned scorers', { labelled: { judge: 'stage', pass: 1 } }, ['quality,tidy']],
    ['a label a stage decided on another pass keeps it', { labelled: { judge: 'stage', pass: 2 } }, ['quality,tidy', CORRECTNESS]],
    ["a judge's label on its pass keeps it, so the pinned scorers judge it again", { labelled: { judge: 'model', pass: 1 } }, ['quality,tidy', CORRECTNESS]],
    ['a label a stage decided on its pass keeps it when it is named', { labelled: { judge: 'stage', pass: 1 }, named: [CORRECTNESS] }, [CORRECTNESS]],
  ] as const)("plans a trial's correctness scorer: %s", async (_, options, groups) => {
    const judges = { quality: { tool: 'claude', model: '' }, tidy: { tool: 'claude', model: '' } };

    expect(await plannedGroups(judges, { ...options, named: 'named' in options ? [...options.named] : [] })).toMatchObject({ ok: true, output: { groups: groups.map((scorers) => ({ scorers })) } });
  });

  it('keeps a scorer whose judge tool the plan requires apart from one any judge tool may label', async () => {
    expect(await plannedGroups({ quality: { tool: 'claude', model: '' } })).toMatchObject({ ok: true, output: { groups: [{ scorers: 'quality' }, { scorers: 'tidy' }, { scorers: CORRECTNESS }] } });
  });
});

describe('benchmark plan on a machine that cannot pin the team a trial gets', () => {
  it('refuses a team served over HTTP in benchmark words, before it reads the suite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-http-'));
    dirs.push(root);
    const config: LocalConfig = { ...benchmarkRunConfig(root), repo: { localPath: path.join(root, 'team'), remote: 'https://teamai.example.com/acme', kind: 'http' } };

    const planned = await planBenchmark(config, 'fix', { checkout: root, memberAliases: false, unattended: false, chosen: { tasks: [], arms: [] } });

    expect(planned).toEqual({ refused: { error: { code: 'team_ref_blocked', message: 'A benchmark installs each trial\'s team resources from a commit of the team repo, and this team is served over HTTP, which has no commits to install from. Run the benchmark from a workspace whose team is a git repo.' } } });
  });
});

/** Suite `fix` on the project, every arm on claude unless `arms` says otherwise, with `arms` after its defaults. */
const startSuite = (arms: string): string => `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults:\n  tool: claude\n${arms}repetitions: 1\ntimeout: 10m\n`;
const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const ROLES = 'version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [frontend], skills: [frontend] }\n  - id: review\n    resources: { knowledge: [review], skills: [review] }\n';

/**
 * A member who pulled a git team at its main, which the team remote has: suite `fix` of `arms` with task `fix`, which
 * starts from the project checkout's commit, over `team`, where `{{startingCommit}}` is that commit, and each branch of `branches` on the remote, main with its
 * files. `delivered` are files pull wrote into the checkout, as its record hashes them.
 */
async function pulledMember({ arms, team = {}, branches = {}, delivered = {}, config: overrides = {} }: {
  arms: string; team?: Record<string, string>; branches?: Record<string, Record<string, string>>; delivered?: Record<string, string>; config?: Partial<LocalConfig>;
}) {
  const { git, recordDelivery } = await import('./helpers/delivered-checkout.js');
  const { syncTeamDefinitions } = await import('../benchmark/suite-cache.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-start-'));
  dirs.push(root);
  const write = (repo: string, files: Record<string, string>): void => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
  };
  const commit = (repo: string, files: Record<string, string>): string => {
    write(repo, files);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'commit');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const [repo, project] = [path.join(root, 'team'), path.join(root, 'project')];
  for (const dir of [repo, project]) git(root, 'init', '-q', '-b', 'main', dir);
  const startingCommit = commit(project, { 'test.js': 'process.exit(1);\n' });
  const pulled = commit(repo, {
    'teamai.yaml': 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: git\n',
    'benchmarks/fix/suite.yaml': startSuite(arms),
    'benchmarks/fix/tasks/fix.yaml': `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Fix.\nstartingCommit: ${startingCommit}\ncheck: { run: node test.js, protect: [test.js] }\n`,
    ...Object.fromEntries(Object.entries(team).map(([file, text]) => [file, text.replaceAll('{{startingCommit}}', startingCommit)])),
  });
  git(repo, 'update-ref', 'refs/remotes/origin/main', pulled);
  for (const [branch, files] of Object.entries(branches)) {
    git(repo, 'checkout', '-qb', branch);
    git(repo, 'update-ref', `refs/remotes/origin/${branch}`, commit(repo, files));
    git(repo, 'checkout', '-q', 'main');
  }
  write(project, delivered);
  const config: LocalConfig = {
    repo: { localPath: repo, remote: 'https://github.com/acme/team.git', kind: 'git' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: project, dataHome: path.join(root, 'data'), usageReportEnabled: false, ...overrides,
  };
  const recordPull = (rev: string) => recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'], files: Object.keys(delivered).map((file) => path.join(project, file)) });
  await recordPull(pulled);
  await syncTeamDefinitions(config);
  return {
    config, project, pulled, recordPull, commit: (files: Record<string, string>) => commit(repo, files),
    plan: (memberAliases = false) => planBenchmark(config, 'fix', { checkout: project, memberAliases, unattended: false, chosen: { tasks: [], arms: [] } }),
  };
}

describe('benchmark plan refusals at start', () => {
  it.each<{ refused: string; arms: string; code: string; message: string; team?: Record<string, string>; config?: Partial<LocalConfig> }>([
    {
      refused: 'an arm on a team ref the team repo does not have', arms: 'arms:\n  - name: now\n  - name: gone\n    team: no-such-branch\n', code: 'arm_team_unresolved',
      message: 'Arm "gone" runs on team ref "no-such-branch", which is no branch, tag or commit of this checkout\'s team repo that holds teamai.yaml. Its branches: main. Fetch it, or fix the arm\'s team, push it, run teamai pull, and start again.',
    },
    {
      refused: 'an arm without a path the pulled revision does not have', arms: 'arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/nope] }\n', code: 'arm_team_unresolved',
      message: 'Arm "ablated" runs without skills/nope, which team revision {pulled} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.',
    },
    {
      refused: 'an arm whose role the team revision it runs on does not declare', arms: 'arms:\n  - name: now\n  - name: audit\n    role: audit\n', code: 'role_unavailable',
      team: { 'manifest/roles.yaml': ROLES }, config: { primaryRole: 'frontend' },
      message: 'Arm "audit" runs with role audit, which manifest/roles.yaml at team revision {pulled} does not declare; it declares frontend, review. Add the role to manifest/roles.yaml, or fix the arm\'s role, push it, run teamai pull, and start again.',
    },
    {
      refused: 'a task that lists a scorer the member receives no valid scorer of', arms: 'arms:\n  - name: now\nscorers: [quality, missing]\n', code: 'scorer_not_found',
      team: { 'scorers/quality.md': '---\nlabels:\n  - { value: tidy, score: 1, description: Small }\n  - { value: messy, score: 0, description: Not }\npassingScore: 1\nsamplingRate: 0\n---\nJudge how tidy the change is.\n' },
      message: 'Suite "fix" lists scorer "missing", which has no valid scorers/missing.md for this member. Add the scorer, or remove it from benchmarks/fix/suite.yaml, push it, run teamai pull, and start again.',
    },
    {
      refused: 'an arm whose model alias names no model for its tool', arms: '  model: strong\narms:\n  - name: strong\n  - name: codex\n    tool: codex\n', code: 'arm_model_missing',
      team: { 'models/aliases.yaml': 'aliases:\n  strong:\n    claude: claude-strong-1\n' },
      message: 'Arm "codex" uses model alias "strong", which has no model for codex in models/aliases.yaml. Add one and start again.',
    },
    {
      refused: 'a scorer whose model alias has no model for the tool it judges every arm on', arms: 'arms:\n  - name: claude\n  - name: codex\n    tool: codex\nscorers: [quality]\n', code: 'judge_model_unavailable',
      team: {
        'models/aliases.yaml': 'aliases:\n  judge:\n    codex: gpt-6-sol\n',
        'scorers/quality.md': '---\nlabels:\n  - { value: tidy, score: 1, description: Small }\n  - { value: messy, score: 0, description: Not }\npassingScore: 1\nsamplingRate: 100\nmodel: judge\n---\nJudge how tidy the change is.\n',
      },
      message: 'Suite "fix" judges scorer "quality" on claude for every arm: the scorer\'s tool, else the suite\'s defaults.tool. Scorer "quality" asks for model alias "judge", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
    },
    {
      refused: 'an arm whose model is a local path, which a record would publish', arms: '  model: /home/member/models/private.gguf\narms:\n  - name: strong\n', code: 'arm_unpublishable',
      message: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix the suite or the team\'s models/aliases.yaml, push it, run teamai pull, and start again.',
    },
    {
      refused: 'in self mode, where the project commit decides the team resources', arms: 'arms:\n  - name: now\n  - name: ablated\n    team: { without: [skills/fixer] }\n', code: 'team_ref_blocked',
      config: { repo: { localPath: '', remote: 'local', kind: 'self' } },
      message: 'Benchmarks do not run in self mode: the project\'s own commit decides which team resources a checkout has, so no arm can run on a team revision of its own. Start the benchmark from a checkout whose team has a team repo of its own.',
    },
  ])('refuses $refused', async ({ arms, code, message, team = {}, config = {} }) => {
    const member = await pulledMember({ arms, team, config });

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: { code, message: message.replace('{pulled}', member.pulled.slice(0, 7)) } } });
  });

  it('refuses an arm whose team branch has a manifest/roles.yaml that cannot be read', async () => {
    const member = await pulledMember({
      arms: '  role: review\narms:\n  - name: now\n  - name: broken\n    team: broken-roles\n', team: { 'manifest/roles.yaml': ROLES }, config: { primaryRole: 'frontend' },
      branches: { 'broken-roles': { 'manifest/roles.yaml': 'version: 1\nroles:\n  - id: review\n    resources: { skills: [review] }\n' } },
    });
    const { git } = await import('./helpers/delivered-checkout.js');
    const broken = git(member.config.repo.localPath, 'rev-parse', '--short=7', 'refs/remotes/origin/broken-roles');

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'role_unavailable',
      message: `Arm "broken" runs with role review, and manifest/roles.yaml at team revision ${broken} cannot be read: Invalid roles manifest: roles.0.resources.knowledge: Invalid input: expected array, received undefined. Fix manifest/roles.yaml on that revision, or run the arm on another team revision, push it, run teamai pull, and start again.`,
    } } });
  });

  it('refuses an arm without team resources on a machine whose user-scope install delivers to its tool', async () => {
    const member = await pulledMember({ arms: 'arms:\n  - name: now\n  - name: bare\n    team: none\n' });
    // Another team's user-scope install: one of this team would refuse every arm first, as the team could not be pinned.
    const { getUserConfigPath } = await import('../types.js');
    fs.mkdirSync(path.dirname(getUserConfigPath()), { recursive: true });
    fs.writeFileSync(getUserConfigPath(), `repo:\n  localPath: ${JSON.stringify(path.join(member.project, '..', 'other-team'))}\n  remote: https://example.com/acme/other-team.git\n  kind: git\nusername: tester\nscope: user\nadditionalRoles: []\n`);
    onTestFinished(() => fs.rmSync(getUserConfigPath(), { force: true }));

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'arm_team_unclean',
      message: 'Arm "bare" runs without team resources, and this machine\'s user-scope teamai install delivers team resources to claude in your home, where its trials would read them. Start the benchmark on a machine where teamai is installed only in workspace scope.',
    } } });
  });

  it.each([
    ['its delivered team resources were edited', async (member: Awaited<ReturnType<typeof pulledMember>>) => {
      fs.appendFileSync(path.join(member.project, '.claude', 'skills', 'fixer', 'SKILL.md'), 'A local edit.\n');
    }],
    ['its team revision is on no branch of the team remote', async (member: Awaited<ReturnType<typeof pulledMember>>) => {
      await member.recordPull(member.commit({ 'local.md': 'Not pushed.\n' }));
    }],
  ])('refuses to plan when the checkout\'s pull, as %s, has no team revision another machine can pull', async (_, change) => {
    const member = await pulledMember({ arms: 'arms:\n  - name: now\n', team: { 'skills/fixer/SKILL.md': SKILL('fixer') }, delivered: { '.claude/skills/fixer/SKILL.md': SKILL('fixer') } });
    await change(member);

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'team_revision_unpullable',
      message: 'Benchmarks start from the team revision this checkout last pulled, and it has none that another machine can pull. Push any team changes, run teamai pull, and start again.',
    } } });
  });

  it('refuses a task that starts from a commit neither the checkout nor the suite repo has', async () => {
    const member = await pulledMember({ arms: 'arms:\n  - name: now\n' });
    const missing = 'f'.repeat(40);
    member.commit({ 'benchmarks/fix/tasks/fix.yaml': `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Fix.\nstartingCommit: ${missing}\ncheck: { run: node test.js, protect: [test.js] }\n` });
    const { git } = await import('./helpers/delivered-checkout.js');
    const head = git(member.config.repo.localPath, 'rev-parse', 'HEAD');
    git(member.config.repo.localPath, 'update-ref', 'refs/remotes/origin/main', head);
    await member.recordPull(head);
    const { syncTeamDefinitions } = await import('../benchmark/suite-cache.js');
    await syncTeamDefinitions(member.config);
    // The suite repo is a directory that is not there, so the fetch fails here and never reaches the network.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${path.join(member.project, '..', 'no-such-origin')}/.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/fixture/');

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'commit_unreachable',
      message: 'Task "fix" starts from fffffff, which neither this checkout nor https://github.com/fixture/app.git has. Push it, or fix startingCommit, and start again.',
    } } });
  });

  it('refuses a task whose check.add comes from a solution commit neither the checkout nor the suite repo has, naming that commit', async () => {
    const member = await pulledMember({ arms: 'arms:\n  - name: now\n' });
    const { git } = await import('./helpers/delivered-checkout.js');
    const start = git(member.project, 'rev-parse', 'HEAD');
    const missing = 'e'.repeat(40);
    member.commit({ 'benchmarks/fix/tasks/fix.yaml': `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Fix.\nstartingCommit: ${start}\nsolutionCommit: ${missing}\ncheck: { run: node test.js, protect: ['test/**'], add: [test/fix.test.js] }\n` });
    const head = git(member.config.repo.localPath, 'rev-parse', 'HEAD');
    git(member.config.repo.localPath, 'update-ref', 'refs/remotes/origin/main', head);
    await member.recordPull(head);
    const { syncTeamDefinitions } = await import('../benchmark/suite-cache.js');
    await syncTeamDefinitions(member.config);
    // The suite repo is a directory that is not there, so the fetch fails here and never reaches the network.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${path.join(member.project, '..', 'no-such-origin')}/.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/fixture/');

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'commit_unreachable',
      message: 'Task "fix" writes check.add from its solutionCommit eeeeeee, which neither this checkout nor https://github.com/fixture/app.git has. Push it, or fix solutionCommit, and start again.',
    } } });
  });

  it("plans each arm's model with the member's aliases under --member-aliases, and names member as the source of each model they decided", async () => {
    const member = await pulledMember({
      arms: '  model: strong\narms:\n  - name: strong\n  - name: fast\n    model: fast\n  - name: codex\n    tool: codex\n',
      team: { 'models/aliases.yaml': 'aliases:\n  strong:\n    claude: { model: claude-strong-1, effort: high }\n    codex: { model: gpt-strong-1, effort: high }\n  fast:\n    claude: claude-fast-1\n' },
    });
    const { localAliasesPath } = await import('../models/aliases.js');
    fs.mkdirSync(path.dirname(localAliasesPath()), { recursive: true });
    fs.writeFileSync(localAliasesPath(), 'aliases:\n  strong:\n    claude: claude-member-1\n');
    onTestFinished(() => fs.rmSync(localAliasesPath(), { force: true }));

    const planned = await member.plan(true);

    expect('planned' in planned && planned.planned.plan.arms).toMatchObject([
      { name: 'strong', model: 'claude-member-1', source: 'member' },
      { name: 'fast', model: 'claude-fast-1', source: 'team' },
      { name: 'codex', model: 'gpt-strong-1', source: 'team' },
    ]);
  });
});

/** A scorer file of `frontmatter` over two labels. */
const SCORER = (frontmatter = ''): string => `---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 1\nsamplingRate: 100\n${frontmatter}---\nJudge the change.\n`;

/** Claude and Codex on PATH, as judge tools that run best-effort. */
function judgeTools(): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-judges-'));
  dirs.push(bin);
  for (const [tool, version] of [['claude', '1.0.0 (Claude Code)'], ['codex', 'codex-cli 0.1.0']]) {
    fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
  }
  const resolved = vi.spyOn(cliPaths, 'resolveCliPath').mockImplementation((cmd) => (fs.existsSync(path.join(bin, cmd)) ? path.join(bin, cmd) : null));
  onTestFinished(() => resolved.mockRestore());
}

describe('benchmark plan judges at start', () => {
  const COPY_TASK = "schemaVersion: v1alpha1\ntitle: Copy\nprompt: Fix the login copy.\nstartingCommit: '{{startingCommit}}'\nsuccessCriteria: The login page says Sign in.\n";

  it("pins each judged scorer to its tool, else the suite's defaults.tool, and its model string, for every arm", async () => {
    judgeTools();
    const member = await pulledMember({
      arms: 'arms:\n  - name: claude\n  - name: codex\n    tool: codex\nscorers: [quality, strict]\n',
      team: {
        'benchmarks/fix/tasks/copy.yaml': COPY_TASK,
        'models/aliases.yaml': 'aliases:\n  judge:\n    claude: { model: opus, effort: high }\n    codex: { model: gpt-6-sol, effort: high }\n',
        'scorers/quality.md': SCORER('model: judge\n'),
        'scorers/strict.md': SCORER('tool: codex\n'),
      },
    });

    const planned = await member.plan();

    expect('planned' in planned && planned.planned.plan.judges).toEqual({
      quality: { tool: 'claude', model: 'judge' },
      strict: { tool: 'codex', model: '' },
      'teamai:correctness:copy': { tool: 'claude', model: '' },
    });
  });
});

describe('benchmark plan scorers a task lists', () => {
  const LISTING = "schemaVersion: v1alpha1\ntitle: Rotate\nprompt: Rotate the session id at login.\nstartingCommit: '{{startingCommit}}'\ncheck: { run: node test.js, protect: [test.js] }\nscorers: [security]\n";

  it("pins a scorer a task lists as the suite's are, its judge the same for every arm", async () => {
    judgeTools();
    const member = await pulledMember({
      arms: 'arms:\n  - name: claude\n  - name: codex\n    tool: codex\nscorers: [quality]\n',
      team: { 'benchmarks/fix/tasks/rotate.yaml': LISTING, 'scorers/quality.md': SCORER(), 'scorers/security.md': SCORER('tool: codex\n') },
    });

    const planned = await member.plan();

    expect('planned' in planned && planned.planned.plan.judges).toEqual({ quality: { tool: 'claude', model: '' }, security: { tool: 'codex', model: '' } });
    expect('planned' in planned && planned.planned.plan.scorers.map(({ name }) => name)).toEqual(['quality', 'security', 'teamai:correctness:fix', 'teamai:correctness:rotate']);
  });

  it('refuses a task that lists a scorer this member has no valid file of, naming the task file', async () => {
    judgeTools();
    const member = await pulledMember({ arms: 'arms:\n  - name: claude\n', team: { 'benchmarks/fix/tasks/rotate.yaml': LISTING } });

    const planned = await member.plan();

    expect(planned).toEqual({ refused: { error: {
      code: 'scorer_not_found',
      message: 'Task "rotate" of suite "fix" lists scorer "security", which has no valid scorers/security.md for this member. Add the scorer, or remove it from benchmarks/fix/tasks/rotate.yaml, push it, run teamai pull, and start again.',
    } } });
  });

  it('refuses a check-only suite whose task lists a scorer on a machine with no judge tool', async () => {
    vi.spyOn(cliPaths, 'resolveCliPath').mockReturnValue(null);
    const member = await pulledMember({ arms: 'arms:\n  - name: claude\n', team: { 'benchmarks/fix/tasks/rotate.yaml': LISTING, 'scorers/security.md': SCORER() } });

    const planned = await member.plan();

    expect(planned).toMatchObject({ refused: { error: { code: 'scoring_unavailable', message: expect.stringMatching(/^This suite needs a judge \(task "rotate" lists scorers security\), and this machine cannot judge: /) } } });
  });
});

describe('benchmark plan correctness rubric', () => {
  const COPY_TASK = "schemaVersion: v1alpha1\ntitle: Copy\nprompt: Fix the login copy.\nstartingCommit: '{{startingCommit}}'\nsuccessCriteria: The login page says Sign in.\n";
  const TEAM_RUBRIC = `---
labels:
  - { value: correct, score: 1, description: Meets every criterion. }
  - { value: partial, score: 0.5, description: Meets the main criterion only. }
  - { value: incorrect, score: 0, description: Misses the main criterion. }
passingScore: 1
samplingRate: 100
model: fast
---
Judge the diff of {{ task.prompt }} against {{ task.successCriteria }}.
`;
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

  async function plannedOf(member: Awaited<ReturnType<typeof pulledMember>>) {
    const planned = await member.plan();
    if (!('planned' in planned)) throw new Error(planned.refused.error.message);
    return planned;
  }

  it("judges each task with teamai's scorers/teamai-correctness.md, filled in with its prompt and success criteria, while the team has no file of its name", async () => {
    judgeTools();
    const member = await pulledMember({ arms: 'arms:\n  - name: claude\n', team: { 'benchmarks/fix/tasks/copy.yaml': COPY_TASK } });

    const { generated } = await plannedOf(member);

    expect(generated['teamai:correctness:copy']?.content).toBe(`---
labels:
  - { value: correct, score: 1, description: The change meets every success criterion. }
  - { value: incorrect, score: 0, description: The change misses at least one success criterion. }
passingScore: 1
samplingRate: 100
---
Judge whether the change made from the starting commit, commits included, meets the success criteria.
Read the task to understand the intent, then the diff. Do not read the transcript. Decide only on the success criteria.

## Task

Fix the login copy.

## Success criteria

The login page says Sign in.
`);
  });

  it("judges every arm with the team's scorers/teamai-correctness.md, filled in with each task, its model and labels pinned, and fills a check-only task's success criteria with nothing", async () => {
    judgeTools();
    const member = await pulledMember({
      arms: 'arms:\n  - name: claude\n  - name: codex\n    tool: codex\n',
      team: { 'benchmarks/fix/tasks/copy.yaml': COPY_TASK, 'models/aliases.yaml': 'aliases:\n  fast:\n    claude: { model: haiku }\n', 'scorers/teamai-correctness.md': TEAM_RUBRIC },
    });
    const copy = TEAM_RUBRIC.replace('{{ task.prompt }}', 'Fix the login copy.').replace('{{ task.successCriteria }}', 'The login page says Sign in.');
    const fix = TEAM_RUBRIC.replace('{{ task.prompt }}', 'Fix.').replace('{{ task.successCriteria }}', '');
    const labels = [{ value: 'correct', score: 1 }, { value: 'partial', score: 0.5 }, { value: 'incorrect', score: 0 }];

    const { planned: { plan }, generated } = await plannedOf(member);

    expect(plan.judges).toEqual({ 'teamai:correctness:copy': { tool: 'claude', model: 'fast' } });
    expect(plan.scorers).toEqual([
      { name: 'teamai:correctness:copy', rubric: { sourceHash: sha256(copy) }, labels, passingScore: 1 },
      { name: 'teamai:correctness:fix', rubric: { sourceHash: sha256(fix) }, labels, passingScore: 1 },
    ]);
    expect(generated['teamai:correctness:copy']).toMatchObject({ sourceHash: sha256(copy), content: copy, generated: true });
    expect(generated['teamai:correctness:fix']).toMatchObject({ sourceHash: sha256(fix), content: fix, generated: true });
  });

  it("excludes a pair judged before the team replaced the correctness rubric from one judged after, as its judge changed", async () => {
    judgeTools();
    const member = await pulledMember({ arms: 'arms:\n  - name: claude\n', team: { 'benchmarks/fix/tasks/copy.yaml': COPY_TASK } });
    const before = await plannedOf(member);
    const { git } = await import('./helpers/delivered-checkout.js');
    const { syncTeamDefinitions } = await import('../benchmark/suite-cache.js');
    const head = member.commit({ 'scorers/teamai-correctness.md': TEAM_RUBRIC.replace('model: fast\n', '') });
    git(member.config.repo.localPath, 'update-ref', 'refs/remotes/origin/main', head);
    await member.recordPull(head);
    await syncTeamDefinitions(member.config);
    const after = await plannedOf(member);
    const sideOf = ({ planned: { plan } }: typeof before): PairSide => ({
      taskHash: plan.tasks.find(({ id }) => id === 'copy')?.sourceHash ?? '',
      decider: { by: 'judge', rubric: plan.scorers.find(({ name }) => name === 'teamai:correctness:copy')?.rubric.sourceHash ?? '', tool: 'claude', model: 'claude-opus-5-5', batched: false },
    });

    const comparison = comparePair(sideOf(before), sideOf(after));

    expect(sideOf(before).taskHash).toBe(sideOf(after).taskHash);
    expect(comparison).toEqual({ kind: 'excluded', because: { kind: 'judge_changed', from: sideOf(before).decider, to: sideOf(after).decider } });
  });
});
