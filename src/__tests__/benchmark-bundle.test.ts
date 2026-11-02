import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BenchmarkPlan } from '../benchmark/plan.js';
import { planOfRun } from '../benchmark/run-plan.js';
import type { LocalConfig } from '../types.js';
import type { BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import { stepDefinitions } from '../workflow/scope.js';
import { readRun } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { benchmarkRunConfig, frozenBenchmark, PLANNED_BENCHMARK, startBenchmarkRun } from './helpers/benchmark-fixture.js';

const dirs: string[] = [];

afterEach(() => {
  // Retried: on Windows another process, such as a virus scanner, can briefly hold a file just written (EBUSY).
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A suite of check tasks t01.. and claude arms a01.., the second and later on model m<i>; `trial` is its `trial` value. */
function suiteOf({ tasks = 1, arms = 1, repetitions = 1, trial = '' } = {}): BenchmarkSuiteFiles {
  const names = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [${names('a', arms).map((name, index) => `{ name: ${name}${index > 0 ? `, model: m${index + 1}` : ''} }`).join(', ')}]\nrepetitions: ${repetitions}\ntimeout: 10m\n${trial ? `trial: ${trial}\n` : ''}`,
    tasks: Object.fromEntries(names('t', tasks).map((name) => [name,
      "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\ncheck: { run: node test.js, protect: [test.js] }\n"])),
  };
}

/** A run of `body`, made as `startBenchmarkRun` makes it, as it stands once its plan steps printed, and the plan they froze. */
async function plannedRun(files: BenchmarkSuiteFiles, options: Parameters<typeof startBenchmarkRun>[2] = {}): Promise<{ run: RunState; plan: BenchmarkPlan }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-bundle-'));
  dirs.push(root);
  const config: LocalConfig = benchmarkRunConfig(root);
  const frozen = await frozenBenchmark(config, files);
  if (!('plan' in frozen)) throw new Error(JSON.stringify(frozen));
  const started = await startBenchmarkRun(config, files, options);
  if ('error' in started) throw new Error(started.error.message);
  const run = await readRun(config, String(started.data.run));
  if (typeof run !== 'object') throw new Error(`run ${String(started.data.run)} cannot be read`);
  return { run, plan: frozen.plan };
}

describe('the workflow a benchmark plan prints', () => {
  it('is admitted for a suite of two tasks and two repetitions, and its plan is read from beneath the step that runs it', async () => {
    const { run, plan } = await plannedRun(suiteOf({ tasks: 2, arms: 2, repetitions: 2 }));

    expect(run.steps.find((step) => step.id === 'plan')).toMatchObject({ status: 'succeeded' });
    expect(planOfRun(run, 'trials.r2.t02.a01.prompt')).toEqual({ found: { plan, prefix: 'trials.', producer: 'plan' } });
    expect(planOfRun(run)).toEqual({ found: { plan, prefix: 'trials.', producer: 'plan' } });
    expect(plan.trials.map((trial) => trial.step)).toContain('r2.t02.a02.prompt');
    for (const step of ['trials.baselines.t01', 'trials.baselines.t02', 'trials.r2.t02.a02.prompt', 'trials.r2.t02.a02.check', 'trials.settled']) {
      expect(stepDefinitions(run)(step), step).toBeDefined();
    }
    // A task's trials run only where its check fails on the starting commit, one after another.
    expect(stepDefinitions(run)('trials.r1.t02.a01')?.if).toBe("steps.baselines.outputs.t02 == 'failed'");
    expect(stepDefinitions(run)('trials.r1.t02.a02')).toMatchObject({ needs: ['a01'], if: "steps.a01.outcome != null && steps.baselines.outputs.t02 == 'failed'" });
    expect(stepDefinitions(run)('trials.r1.t02')?.needs).toEqual(['t01']);
  });

  it("limits each trial prompt's turn by the suite's trial limits, ended rather than failed at one", async () => {
    const { run } = await plannedRun(suiteOf({ arms: 2, trial: '{ timeout: 5m, budget: { tokens: 1000 }, max_turns: 3 }' }));

    expect(stepDefinitions(run)('trials.r1.t01.a02.prompt')).toMatchObject({
      tool: 'claude', model: { name: 'm2' }, timeout: 300_000, maxTurns: 3, budget: { tokens: 1000 }, onLimit: 'end_turn',
    });
  });

  it('runs each trial prompt unattended when the plan says the step that runs it is a strict sandbox, and else as written', async () => {
    const { run } = await plannedRun(suiteOf({ arms: 2 }), { unattended: true });
    const { run: asWritten } = await plannedRun(suiteOf({ arms: 2 }));

    for (const step of ['trials.r1.t01.a01.prompt', 'trials.r1.t01.a02.prompt']) expect(stepDefinitions(run)(step)?.permissions, step).toBe('unattended');
    expect(stepDefinitions(run)('trials.r1.t01.a01.check')).not.toHaveProperty('permissions');
    expect(stepDefinitions(asWritten)('trials.r1.t01.a01.prompt')).not.toHaveProperty('permissions');
  });

  it('runs a suite of criteria tasks with no baselines, each prompt scored by its task\'s correctness scorer', async () => {
    const { run } = await plannedRun({
      name: 'fix',
      suite: 'schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [{ name: a01 }]\nrepetitions: 2\ntimeout: 10m\n',
      tasks: { t01: "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\nsuccessCriteria: The test passes.\n" },
    });

    expect(run.steps.find((step) => step.id === 'plan')).toMatchObject({ status: 'succeeded' });
    expect(stepDefinitions(run)('trials.baselines')).toBeUndefined();
    expect(stepDefinitions(run)('trials.r2.t01.a01.check')).toBeUndefined();
    expect(stepDefinitions(run)('trials.r2.t01.a01.prompt')?.scorers).toEqual({ names: ['teamai:correctness:t01'], sampling: 'all' });
  });

  it('is refused by report and check once its plan is of a schemaVersion this teamai does not read', async () => {
    const { run } = await plannedRun(suiteOf(), { outputsOf: (bundle, plan) => ({ definition: { ...bundle, workflows: {} }, plan: { ...plan, schemaVersion: 2 } }) });

    expect(planOfRun(run, 'trials.r1.t01.a01.check')).toEqual({ failure: {
      code: 'run_unreadable',
      message: `Step "plan" of run ${run.id} printed a benchmark plan of schemaVersion 2, and this teamai reads only schemaVersion 1. Run the benchmark with the teamai that planned it, or start it again.`,
    } });
  });

  it('is refused by report and check once its plan is of schemaVersion 1 but not its shape', async () => {
    const { run } = await plannedRun(suiteOf(), { outputsOf: (bundle) => ({ definition: { ...bundle, workflows: {} }, plan: { schemaVersion: 1 } }) });

    expect(planOfRun(run, 'trials.r1.t01.a01.check')).toMatchObject({ failure: {
      code: 'run_unreadable',
      message: expect.stringMatching(new RegExp(`^Step "plan" of run ${run.id} printed a benchmark plan this teamai cannot read: .*arms: Invalid input: expected array, received undefined.*\\. Update teamai, or start the benchmark again\\.$`)),
    } });
  });

  it('is refused by report and check once its plan holds an arm model a record could not publish', async () => {
    const { run } = await plannedRun(suiteOf(), { outputsOf: (bundle, plan) => ({
      definition: { ...bundle, workflows: {} }, plan: { ...plan, arms: plan.arms.map((arm) => ({ ...arm, model: 'https://user:secret@models.example/m2' })) },
    }) });

    expect(planOfRun(run, 'trials.r1.t01.a01.check')).toMatchObject({ failure: {
      code: 'run_unreadable',
      message: expect.stringMatching(new RegExp(`^Step "plan" of run ${run.id} printed a benchmark plan this teamai cannot read: .*arms\\.0\\.model`)),
    } });
  });

  it('leaves report and check no plan to read once the run refused the workflow its plan step printed', async () => {
    const { run } = await plannedRun(suiteOf(), { outputsOf: (_bundle, plan) => ({ definition: { definition: { schemaVersion: 'v1alpha1', name: 'fix' } }, plan }) });

    expect(run.steps.find((step) => step.id === 'plan')).toMatchObject({ status: 'failed', failure: { code: 'invalid_output' } });
    expect(planOfRun(run, 'trials.r1.t01.a01.check')).toEqual({ failure: {
      code: 'invalid_arguments',
      message: `Run ${run.id} runs no benchmark plan around step "trials.r1.t01.a01.check": no step of it runs the workflow a teamai benchmark plan step printed. Run teamai benchmark only as a step of the benchmark workflow.`,
    } });
  });

  it('cannot tell report which plan to read in a run of two', async () => {
    const twice = `${PLANNED_BENCHMARK}  - id: again
    needs: []
    command: teamai benchmark plan fix
    output: { definition: workflow, plan: json }
  - id: trials-again
    needs: [again]
    workflow: { from: again }
`;
    const { run } = await plannedRun(suiteOf(), { body: twice });

    expect(planOfRun(run)).toEqual({ failure: {
      code: 'invalid_arguments',
      message: `Run ${run.id} runs more than one benchmark plan, in steps "trials", "trials-again", so teamai benchmark report cannot tell which one to report. Run one benchmark plan per run.`,
    } });
    expect(planOfRun(run, 'trials-again.r1.t01.a01.check')).toMatchObject({ found: { prefix: 'trials-again.' } });
  });
});
