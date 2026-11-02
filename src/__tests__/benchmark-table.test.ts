import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentObservation } from '../agent-observation.js';
import { benchmarkRecord, type BenchmarkRecord, type TrialResult } from '../benchmark/result.js';
import { planOfRun } from '../benchmark/run-plan.js';
import { benchmarkTable, formatBenchmarkTable } from '../benchmark/table.js';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import type { DriverCan } from '../workflow/requirements.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import type { StepState } from '../workflow/step-state.js';
import { benchmarkRunConfig, fixTask, PRODUCT_URL, RUN_START, RUN_TEAM, settleBaselines, startBenchmarkRun } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], end_turn: true };
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string() }) }) }) });
const dirs: string[] = [];

afterEach(() => {
  // Retried: on Windows a directory can stay busy for a moment after a process in it exits (EBUSY).
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A started run of ten repetitions of one check task `fix` on one arm. */
async function startTen(defaults = '{ tool: claude }') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-table-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const suite = `schemaVersion: v1alpha1\nname: fix\nrepo: ${PRODUCT_URL}\ndefaults: ${defaults}\narms: [{ name: claude }]\nrepetitions: 10\ntimeout: 10m\n`;
  const started = await startBenchmarkRun(config, { name: 'fix', suite, tasks: { fix: fixTask('{{startingCommit}}') } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

/** The benchmark record the run's report would write, from the plan its plan step printed. */
async function endRecord(config: LocalConfig, runId: string): Promise<{ benchmark: BenchmarkRecord }> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  const planned = planOfRun(run);
  if ('failure' in planned) throw new Error(planned.failure.message);
  return { benchmark: benchmarkRecord(run, planned.found) };
}

/** The end record of a run of ten repetitions whose first trial passed its check before the run was cancelled. */
async function onePassedOfTen() {
  const { config, runId } = await startTen();
  await settleBaselines(config, runId, driver, can);
  const prompt = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  await reportAttempt(config, runId, {
    attempt: prompt.attempt, revision: prompt.revision, outcome: 'success', driver,
    changes: { branch: prompt.workspace.branch, base: RUN_START, from: RUN_START, to: 'c'.repeat(40), commits: [] },
  });
  const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  await reportAttempt(config, runId, { attempt: check.attempt, revision: check.revision, outcome: 'success', exitCode: 0, outputs: { result: 'passed' }, driver });
  await cancelRun(config, runId, {});
  return endRecord(config, runId);
}

describe('benchmark results table', () => {
  it('gives one passed trial of ten planned a pass rate of 10%', async () => {
    const table = benchmarkTable(await onePassedOfTen());

    expect(table.results).toEqual([{
      arm: 'claude', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM }, planned: 10, counts: { passed: 1, failed: 0, error: 0, unscored: 0, not_run: 9 },
      stoppedByLimit: 0, deviations: 0, notVerified: 0, passRate: { passed: 1, planned: 10 },
    }]);
    expect(formatBenchmarkTable(table)).toContain('| claude | claude | tool default (team) | 10 | 1 | 0 | 0 | 0 | 9 | 0 | 0 | 0 | 10% (1/10) |');
  });

  it('gives an arm with no planned trials no pass rate', async () => {
    const record = await onePassedOfTen();

    const table = benchmarkTable({ ...record, benchmark: { ...record.benchmark, trials: [] } });

    expect(table.results).toEqual([{ arm: 'claude', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM }, planned: 0, counts: { passed: 0, failed: 0, error: 0, unscored: 0, not_run: 0 }, stoppedByLimit: 0, deviations: 0, notVerified: 0 }]);
    expect(formatBenchmarkTable(table)).toContain('| claude | claude | tool default (team) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |');
  });

  it.each([
    ['passed', 'invalid', '| fix | invalid: check passes without changes |'],
    ['could_not_run', 'could_not_run', '| fix | check could not run |'],
  ] as const)('lists a task whose baseline %s under the results, with no trial of it run', async (baseline, listed, row) => {
    const { config, runId } = await startTen();
    await settleBaselines(config, runId, driver, can, { fix: baseline });
    await leaseNext(config, runId, driver, { can, prepare: true });

    const table = benchmarkTable(await endRecord(config, runId));

    expect(table.invalid).toEqual([{ task: 'fix', baseline: listed }]);
    expect(table.results).toMatchObject([{ counts: { not_run: 10 } }]);
    expect(formatBenchmarkTable(table)).toContain(`\n\n| Task | Baseline |\n| --- | --- |\n${row}\n\n`);
  });

  it('lists no task when every baseline failed as its task expects', async () => {
    const record = await onePassedOfTen();

    const table = benchmarkTable(record);

    expect(table.invalid).toEqual([]);
    expect(formatBenchmarkTable(table)).not.toContain('| Task | Baseline |');
  });
});

const OBSERVED: AgentObservation = { v: 1, tool: { name: 'claude' }, team: { revision: RUN_TEAM, localChanges: false }, teamai: '0.0.0', driver: 'external' };
type TrialSpec = Pick<BenchmarkRecord['trials'][number], 'limit' | 'unenforced' | 'durationMs' | 'tokens' | 'cost' | 'used'> & {
  task?: string;
  arm?: string;
  result?: TrialResult;
  /** What the trial's prompt step ran as; null for a prompt that never launched its tool. */
  agent?: Partial<Pick<AgentObservation, 'tool' | 'model' | 'team'>> | null;
};

/** A benchmark record of valid tasks, `fix` unless a trial names another, whose trials ran as `trials` say, one repetition each. */
function recordOf(arms: BenchmarkRecord['arms'], trials: TrialSpec[]): { benchmark: BenchmarkRecord } {
  const planned = trials.map(({ task = 'fix', arm = arms[0]?.name ?? 'claude', result = 'passed', agent, ...usage }, index) => ({
    task, arm, repetition: index + 1, order: index + 1, step: `trials.r${index + 1}.${task}.${arm}.prompt`, result, ...usage,
    ...(agent === null ? {} : { agent: { ...OBSERVED, ...agent } }),
  }));
  const tasks = [...new Set(['fix', ...planned.map(({ task }) => task)])];
  return {
    benchmark: {
      suite: { name: 'fix', sourceHash: 'h' }, repetitions: trials.length, baselineTeamRevision: RUN_TEAM, scorers: [],
      tasks: tasks.map((id) => ({ id, startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' })), arms, trials: planned,
    },
  };
}

const CLAUDE_ARM = { name: 'opus', tool: 'claude', model: 'claude-opus-4-1', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } } as const;

describe('benchmark deviations', () => {
  it('counts a trial that contradicts its arm on tool, team revision or concrete model as a deviation, and one missing a value as not verified', () => {
    const table = benchmarkTable(recordOf([CLAUDE_ARM], [
      { agent: { model: { reported: 'claude-opus-4-1-20250805' } } },
      { agent: { model: { reported: 'claude-sonnet-4-5-20250929' } } },
      { agent: {} },
      { agent: { tool: { name: 'codex' }, model: { reported: 'claude-opus-4-1' } } },
      { agent: { team: { revision: 'c'.repeat(40), localChanges: false }, model: { reported: 'claude-opus-4-1' } } },
      { agent: { team: undefined, model: { reported: 'claude-opus-4-1' } } },
      { result: 'not_run', agent: null },
    ]));

    expect(table.results).toMatchObject([{ planned: 7, counts: { passed: 6, not_run: 1 }, deviations: 3, notVerified: 2, passRate: { passed: 6, planned: 7 } }]);
    expect(formatBenchmarkTable(table)).toContain('| opus | claude | claude-opus-4-1 (team) | 7 | 6 | 0 | 0 | 0 | 1 | 0 | 3 | 2 | 86% (6/7) |');
  });

  it("does not compare a tool's own model selector, or the tool's default model, with the model the tool reports", () => {
    const table = benchmarkTable(recordOf([{ ...CLAUDE_ARM, model: 'opus', effort: 'high' }, { name: 'plain', tool: 'claude', source: 'member', team: { kind: 'pulled', revision: RUN_TEAM } }], [
      { agent: { model: { reported: 'claude-opus-4-1-20250805' } } },
      { arm: 'plain', agent: { model: { reported: 'claude-sonnet-4-5-20250929' } } },
      { arm: 'plain', agent: {} },
    ]));

    expect(table.results).toMatchObject([{ arm: 'opus', stoppedByLimit: 0, deviations: 0, notVerified: 0 }, { arm: 'plain', stoppedByLimit: 0, deviations: 0, notVerified: 0 }]);
    expect(formatBenchmarkTable(table)).toContain('| opus | claude | opus high (team) |');
    expect(formatBenchmarkTable(table)).toContain('| plain | claude | tool default (member) |');
  });

  it('matches a provider-qualified model reported as requested, with or without its provider, and counts another provider as a deviation', () => {
    const arm = { name: 'gpt', tool: 'opencode', model: 'openai/gpt-5.2', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } } as const;
    const opencode = (reported: string) => ({ agent: { tool: { name: 'opencode' }, model: { reported } } });
    const table = benchmarkTable(recordOf([arm, { ...CLAUDE_ARM, name: 'opus' }], [
      opencode('openai/gpt-5.2'),
      opencode('gpt-5.2'),
      opencode('openai/gpt-5.2-2025-08-05'),
      opencode('azure/gpt-5.2'),
      { arm: 'opus', agent: { model: { reported: 'anthropic/claude-opus-4-1' } } },
    ]));

    expect(table.results).toMatchObject([{ arm: 'gpt', planned: 4, deviations: 1, notVerified: 0 }, { arm: 'opus', planned: 1, stoppedByLimit: 0, deviations: 0, notVerified: 0 }]);
  });
});

describe('benchmark arm team', () => {
  const NONE = { name: 'bare', tool: 'claude', source: 'team', team: { kind: 'none' } } as const;
  const ABLATED: BenchmarkRecord['arms'][number] = { name: 'no-fixer', tool: 'claude', source: 'team', team: { kind: 'without', paths: ['rules/commits.md', 'skills/fixer'], revision: RUN_TEAM } };

  it('counts a trial of an arm without team assets that ran on some, and one of an arm without some paths that ran on another revision, as deviations', () => {
    const table = benchmarkTable(recordOf([NONE, ABLATED], [
      { arm: 'bare', agent: { team: undefined } },
      { arm: 'bare', agent: { team: undefined } },
      { arm: 'bare', agent: { team: { revision: RUN_TEAM, localChanges: false } } },
      { arm: 'no-fixer', agent: { team: { revision: RUN_TEAM, localChanges: false } } },
      { arm: 'no-fixer', agent: { team: { revision: 'c'.repeat(40), localChanges: false } } },
      { arm: 'no-fixer', agent: { team: undefined } },
    ]));

    expect(table.results).toMatchObject([{ arm: 'bare', planned: 3, deviations: 1, notVerified: 0 }, { arm: 'no-fixer', planned: 3, deviations: 1, notVerified: 1 }]);
  });

  it('names each arm\'s team assets in a Team column once an arm runs on other assets than the pulled revision', () => {
    const main = { name: 'main', tool: 'claude', source: 'team', team: { kind: 'ref', ref: 'main', revision: 'c'.repeat(40) } } as const;
    const pulled = { name: 'pulled', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } } as const;

    const text = formatBenchmarkTable(benchmarkTable(recordOf([pulled, NONE, ABLATED, main], [{ arm: 'pulled' }, { arm: 'bare', agent: { team: undefined } }, { arm: 'no-fixer' }, { arm: 'main' }])));
    const pulledOnly = formatBenchmarkTable(benchmarkTable(recordOf([pulled], [{ arm: 'pulled' }])));

    expect(text).toContain('| Arm | Tool | Model (source) | Team | Planned |');
    expect(text).toContain(`| pulled | claude | tool default (team) | pulled ${RUN_TEAM.slice(0, 7)} | 1 |`);
    expect(text).toContain('| bare | claude | tool default (team) | none | 1 |');
    expect(text).toContain(`| no-fixer | claude | tool default (team) | ${RUN_TEAM.slice(0, 7)} without rules/commits.md, skills/fixer | 1 |`);
    expect(text).toContain('| main | claude | tool default (team) | main ccccccc | 1 |');
    expect(pulledOnly).toContain('| Arm | Tool | Model (source) | Planned |');
  });

  it("counts the trials that loaded each skill an arm changes, on that arm and on the defaults arm, keeping unseen trials apart", () => {
    const pulled = { name: 'pulled', tool: 'claude', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } } as const;
    const main = { name: 'main', tool: 'claude', source: 'team', team: { kind: 'ref', ref: 'main', revision: 'c'.repeat(40) } } as const;
    const { benchmark } = recordOf([pulled, ABLATED, main], [
      { arm: 'pulled', used: { fixer: 'loaded' } },
      { arm: 'pulled', used: { fixer: 'unknown' } },
      { arm: 'pulled' },
      { arm: 'pulled', result: 'not_run', agent: null },
      { arm: 'no-fixer', used: {} },
      { arm: 'no-fixer' },
      { arm: 'main', used: { fixer: 'loaded' } },
    ]);
    const skillChanges = [
      { arm: 'no-fixer', defaults: 'pulled', skills: [{ name: 'fixer', change: 'removed' }] },
      { arm: 'main', skills: [{ name: 'fixer', change: 'changed' }] },
    ] as const satisfies BenchmarkRecord['skillChanges'];

    const text = formatBenchmarkTable(benchmarkTable({ benchmark: { ...benchmark, skillChanges: [...skillChanges] } }));

    expect(text).toContain('| Arm | Skill | Change | Loaded in this arm | Loaded in the defaults arm |');
    expect(text).toContain('| no-fixer | fixer | removed | 0/1, 1 unknown | 1/1, 2 unknown |');
    expect(text).toContain('| main | fixer | changed | 1/1 | - |');
  });
});

describe('benchmark limits', () => {
  it('counts the trials a suite limit stopped per arm, and a trial whose driver did not enforce a suite limit as a deviation', () => {
    const codex = { name: 'codex', tool: 'codex', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } } as const;
    const opus = { agent: { model: { reported: 'claude-opus-4-1' } } };
    const table = benchmarkTable(recordOf([CLAUDE_ARM, codex], [
      { limit: 'timeout', ...opus },
      { result: 'failed', limit: 'budget', ...opus },
      opus,
      { arm: 'codex', limit: 'budget', unenforced: ['budget'], agent: { tool: { name: 'codex' } } },
      { arm: 'codex', unenforced: ['max_turns'], agent: { tool: { name: 'codex' } } },
    ]));

    expect(table.results).toMatchObject([{ arm: 'opus', stoppedByLimit: 2, deviations: 0 }, { arm: 'codex', stoppedByLimit: 1, deviations: 2 }]);
    expect(formatBenchmarkTable(table)).toContain([
      '| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| opus | claude | claude-opus-4-1 (team) | 3 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 67% (2/3) |',
      '| codex | codex | tool default (team) | 2 | 2 | 0 | 0 | 0 | 0 | 1 | 2 | 0 | 100% (2/2) |',
    ].join('\n'));
  });
});

describe('benchmark usage', () => {
  it('gives each arm the median of the tokens and durations it knows, with how many it used', () => {
    const table = benchmarkTable(recordOf([CLAUDE_ARM], [
      { tokens: { input: 4, output: 2, complete: true }, durationMs: 1000 },
      { tokens: { input: 10, output: 0, complete: true }, durationMs: 3000 },
      { tokens: { input: 3, complete: true }, durationMs: 2000 },
      {},
    ]));

    expect(table.usage).toMatchObject([{ arm: 'opus', tokens: { value: 8, used: 2, components: ['input', 'output'] }, durationMs: { value: 2000, used: 3 } }]);
    expect(formatBenchmarkTable(table)).toContain('| Arm | Median tokens (input + output) | Median duration | Cost |\n| --- | --- | --- | --- |\n| opus | 8 (2) | 2.0 s (3) |');
  });

  it('adds up costs in one unit only, marks a total with an unknown part incomplete, and never counts a missing cost as zero', () => {
    const arm = (name: string) => ({ ...CLAUDE_ARM, name });
    const table = benchmarkTable(recordOf([arm('known'), arm('partial'), arm('mixed'), arm('none')], [
      { arm: 'known', cost: { amount: 0.1, unit: 'USD', complete: true } },
      { arm: 'known', cost: { amount: 0.2, unit: 'USD', complete: true } },
      { arm: 'known', result: 'not_run', agent: null },
      { arm: 'partial', cost: { amount: 0.25, unit: 'USD', complete: true } },
      { arm: 'partial' },
      { arm: 'mixed', cost: { amount: 1, unit: 'USD', complete: true } },
      { arm: 'mixed', cost: { amount: 2, unit: 'EUR', complete: true } },
      { arm: 'none' },
    ]));

    expect(table.usage.map(({ arm: name, cost }) => ({ name, cost }))).toEqual([
      { name: 'known', cost: { kind: 'known', amount: expect.closeTo(0.3), unit: 'USD', used: 2 } },
      { name: 'partial', cost: { kind: 'incomplete', amount: 0.25, unit: 'USD', used: 1, unknown: 1 } },
      { name: 'mixed', cost: { kind: 'mixed', units: ['EUR', 'USD'] } },
      { name: 'none', cost: { kind: 'unknown' } },
    ]);
    const text = formatBenchmarkTable(table);
    expect(text).toContain('| known | unknown (0) | unknown (0) | 0.3 USD (2) |');
    expect(text).toContain('| partial | unknown (0) | unknown (0) | 0.25 USD (1), incomplete: 1 unknown |');
    expect(text).toContain('| mixed | unknown (0) | unknown (0) | mixed units: EUR, USD |');
    expect(text).toContain('| none | unknown (0) | unknown (0) | unknown (0) |');
  });

  it("records each trial's duration, tokens and cost as its prompt reported them, and each arm's model as the plan resolved it", async () => {
    const { config, runId } = await startTen('{ tool: claude, model: claude-opus-4-1 }');
    await settleBaselines(config, runId, driver, can);
    const prompt = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, {
      attempt: prompt.attempt, revision: prompt.revision, outcome: 'failed', driver, tool: 'claude',
      tokens: { input: 4, output: 2 }, durationMs: 1500, cost: { amount: 0.25, unit: 'USD' },
    });
    await cancelRun(config, runId, {});

    const record = await endRecord(config, runId);

    expect(record.benchmark.arms).toEqual([{ name: 'claude', tool: 'claude', model: 'claude-opus-4-1', source: 'team', team: { kind: 'pulled', revision: RUN_TEAM } }]);
    expect(record.benchmark.trials[0]).toMatchObject({ result: 'error', tokens: { input: 4, output: 2 }, durationMs: 1500, cost: { amount: 0.25, unit: 'USD' } });
    expect(record.benchmark.trials[1]).not.toHaveProperty('durationMs');
    expect(record.benchmark.trials[1]).not.toHaveProperty('cost');
  });
});

describe('a trial cancelled before its next lease', () => {
  it.each([
    ['a loop keeps', (run: RunState, step: StepState) => Object.assign(step, { passes: [{ pass: 1, attempt: 'earlier', outcome: 'success' }] })],
    ['a loop archived', (run: RunState, step: StepState) => Object.assign(run, { archive: [{ step: `${step.id}.inner`, pass: 1, attempt: 'archived', outcome: 'success' }] })],
  ])('reads as an error when an earlier pass of its work was leased, as %s it', async (_, earlier) => {
    const { config, runId } = await startTen();
    await settleBaselines(config, runId, driver, can);
    LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const planned = planOfRun(run);
    if ('failure' in planned) throw new Error(planned.failure.message);
    const step = run.steps.find((state) => state.id === 'trials.r1.fix.claude.prompt');
    if (step?.status !== 'cancelled') throw new Error(`trial step is ${step?.status}`);
    // The loop's next pass: no current attempt, the earlier one kept by `passes` or `archive`.
    delete step.attempt;
    earlier(run, step);

    expect(benchmarkRecord(run, planned.found).trials[0]?.result).toBe('error');
  });
});

describe('benchmark task by arm matrix', () => {
  it("gives each task its pass rate on each arm below the usage table, then the tasks whose trials did not run, then the closing sentence", () => {
    const arms = [CLAUDE_ARM, { ...CLAUDE_ARM, name: 'sonnet', model: 'claude-sonnet-4-5' }];
    const table = benchmarkTable(recordOf(arms, [
      { task: 'fix', arm: 'opus' }, { task: 'fix', arm: 'opus', result: 'failed' },
      { task: 'fix', arm: 'sonnet' }, { task: 'fix', arm: 'sonnet' },
      { task: 'lint', arm: 'opus' }, { task: 'lint', arm: 'opus' }, { task: 'lint', arm: 'opus', result: 'failed' },
      { task: 'lint', arm: 'sonnet', result: 'not_run', agent: null },
    ]));

    expect(table.matrix).toEqual([
      { task: 'fix', arms: [{ arm: 'opus', passRate: { passed: 1, planned: 2 } }, { arm: 'sonnet', passRate: { passed: 2, planned: 2 } }] },
      { task: 'lint', arms: [{ arm: 'opus', passRate: { passed: 2, planned: 3 } }, { arm: 'sonnet', passRate: { passed: 0, planned: 1 } }] },
    ]);
    expect(formatBenchmarkTable({ ...table, invalid: [{ task: 'lint', baseline: 'could_not_run' }] })).toBe([
      '| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| opus | claude | claude-opus-4-1 (team) | 5 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 5 | 60% (3/5) |',
      '| sonnet | claude | claude-sonnet-4-5 (team) | 3 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 2 | 67% (2/3) |',
      '',
      '| Arm | Median tokens (input + output) | Median duration | Cost |',
      '| --- | --- | --- | --- |',
      '| opus | unknown (0) | unknown (0) | unknown (0) |',
      '| sonnet | unknown (0) | unknown (0) | unknown (0) |',
      '',
      '| Task | opus | sonnet |',
      '| --- | --- | --- |',
      '| fix | 50% (1/2) | 100% (2/2) |',
      '| lint | 67% (2/3) | 0% (0/1) |',
      '',
      '| Task | Baseline |',
      '| --- | --- |',
      '| lint | check could not run |',
      '',
      'These results hold for these tasks, this run and this machine.',
    ].join('\n'));
  });

  it('rounds a cell as the results table rounds its row, dividing before it multiplies', () => {
    const trials = Array.from({ length: 200 }, (_, index): TrialSpec => ({ result: index < 29 ? 'passed' : 'failed' }));

    const text = formatBenchmarkTable(benchmarkTable(recordOf([CLAUDE_ARM], trials)));

    expect(text).toContain('| 14% (29/200) |\n');
    expect(text).toContain('| Task | opus |\n| --- | --- |\n| fix | 14% (29/200) |\n');
  });

  it('gives a task with no planned trial on an arm no pass rate there', async () => {
    const record = await onePassedOfTen();

    const table = benchmarkTable({ ...record, benchmark: { ...record.benchmark, trials: [] } });

    expect(table.matrix).toEqual([{ task: 'fix', arms: [{ arm: 'claude' }] }]);
    expect(formatBenchmarkTable(table)).toContain('| Task | claude |\n| --- | --- |\n| fix | - |\n');
  });
});
