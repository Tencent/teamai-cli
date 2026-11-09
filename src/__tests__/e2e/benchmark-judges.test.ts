/**
 * Real CLI: every trial is judged by the run's own `score` step before its report. A task judged by success criteria
 * gets a correctness label on each trial, and the suite's scorers judge every trial, from the evidence teamai collected
 * from the trial's clone when its prompt was reported, so the judge runs after the clone is gone. A trial whose judge
 * fails is unscored, at once, and the report says why.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture, type FakeJudge } from '../helpers/benchmark-fixture.js';

/** A suite of the one task, whose arms each run claude, or the tool named, the first on its default model, the others on the model named. */
const suite = ({ arms, scorers = [] }: { arms: Array<{ name: string; model?: string; tool?: string }>; scorers?: string[] }) => `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
${arms.map(({ name, model, tool }) => `  - name: ${name}\n${model ? `    model: ${model}\n` : ''}${tool ? `    tool: ${tool}\n` : ''}`).join('')}${scorers.length > 0 ? `scorers: [${scorers.join(', ')}]\n` : ''}repetitions: 1
timeout: 10m
`;
const CRITERIA_TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make answer.js export 42.
startingCommit: {{startingCommit}}
successCriteria: answer.js exports 42.
`;
const QUALITY = `---
labels:
  - { value: tidy, score: 1, description: The change is small and clear }
  - { value: messy, score: 0, description: It is not }
passingScore: 1
samplingRate: 0
---
Judge how tidy the change is.
`;
const CORRECTNESS = 'teamai:correctness:fix';

const RecordSchema = z.object({
  baselineTeamRevision: z.string(),
  scorers: z.array(z.object({ name: z.string(), rubric: z.object({ sourceHash: z.string() }) })),
  trials: z.array(z.object({ arm: z.string(), result: z.string() }).passthrough()),
});
const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).passthrough();
const VerdictsSchema = z.array(z.object({ scorer: z.string(), step: z.string(), pass: z.number(), outcome: z.record(z.string(), z.unknown()) }));
const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string(), table: z.object({ verdicts: VerdictsSchema }).passthrough() }) }) });

/** The labels waiting in the member's outbox for teamai-reports. */
function outbox(fixture: BenchmarkFixture): string[] {
  const pending = path.join(fixture.dataHome(), 'scores', 'pending');
  return fs.existsSync(pending) ? fs.readdirSync(pending) : [];
}

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function judgedFixture(options: { judge?: FakeJudge; arms?: Array<{ name: string; model?: string; tool?: string }>; scorers?: string[]; tools?: Array<'claude' | 'codex'>; timeout?: string; team?: Record<string, string>; task?: string } = {}): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, judge: options.judge, tools: options.tools ?? ['claude'],
    suite: suite({ arms: options.arms ?? [{ name: 'claude' }], scorers: options.scorers }).replace('timeout: 10m', `timeout: ${options.timeout ?? '10m'}`), tasks: { fix: options.task ?? CRITERIA_TASK },
    team: { ...(options.scorers ? { 'scorers/quality.md': QUALITY } : {}), ...options.team },
  });
  fixtures.push(fixture);
  return fixture;
}

async function runLocally(fixture: BenchmarkFixture): Promise<z.infer<typeof DoneSchema>['done']> {
  const started = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(started).data);
  if (!done.success) throw new Error(`no done: ${said(started)}`);
  return done.data.done;
}

describe('benchmark judges on the local driver', () => {
  it("labels each trial's correctness and judges it with every suite scorer, from evidence its clone left, after the clone is gone", async () => {
    const fixture = await judgedFixture({ arms: [{ name: 'first' }, { name: 'second', model: 'm2' }], scorers: ['quality'] });

    const done = await runLocally(fixture);

    const judged = fixture.judgeLaunches();
    expect(judged.map(({ labels }) => labels.join(' ')).sort()).toEqual(['correct incorrect', 'correct incorrect', 'tidy messy', 'tidy messy']);
    expect(judged.every(({ diff, trialRoots }) => diff?.includes('+module.exports = 42;') === true && trialRoots.length === 0)).toBe(true);
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain('| first | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(done.outputs.text).toContain('| second | claude | m2 (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    expect(record.scorers.map(({ name }) => name).sort()).toEqual(['quality', CORRECTNESS]);
    expect(record.trials).toEqual([
      expect.objectContaining({ arm: 'first', result: 'passed', scoringCost: { amount: 0.2, unit: 'USD', complete: true } }),
      expect.objectContaining({ arm: 'second', result: 'passed', scoringCost: { amount: 0.2, unit: 'USD', complete: true } }),
    ]);
    expect(done.outputs.table.verdicts.map(({ scorer, outcome }) => ({ scorer, outcome })).sort((left, right) => left.scorer.localeCompare(right.scorer))).toEqual([
      { scorer: 'quality', outcome: { kind: 'labelled', label: 'tidy', score: 1, passed: true } },
      { scorer: 'quality', outcome: { kind: 'labelled', label: 'tidy', score: 1, passed: true } },
      { scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true } },
      { scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true } },
    ]);
    const runFile = RunSchema.parse(fixture.runFile(done.run));
    expect(runFile).not.toHaveProperty('verdicts');
    expect(runFile.steps.filter(({ id }) => id === 'subjects' || id === 'score').map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'subjects', status: 'succeeded' }, { id: 'score', status: 'succeeded' }]);
    // Each trial is judged by a step of the benchmark run, never by a teamai-score run of its own, and its labels stay here.
    expect(fixture.runIds()).toEqual([done.run]);
    expect(outbox(fixture)).toEqual([]);
  }, 120_000);

  it("counts a batched judge's one stated cost as the whole cost of the scorers it judged together", async () => {
    const fixture = await judgedFixture({ scorers: ['quality', 'tidiness'], team: { 'scorers/tidiness.md': QUALITY } });

    const done = await runLocally(fixture);

    const record = z.object({ trials: z.array(z.object({ scoringCost: z.unknown(), verdicts: z.array(z.object({ scorer: z.string(), decider: z.object({ batched: z.boolean().optional() }).passthrough().optional() })) })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    // The correctness scorer is judged alone; quality and tidiness share one launch, which states its cost once.
    expect(fixture.judgeLaunches()).toHaveLength(2);
    expect(record.trials[0]?.verdicts.map(({ scorer, decider }) => ({ scorer, batched: decider?.batched }))).toEqual([
      { scorer: CORRECTNESS, batched: false }, { scorer: 'quality', batched: true }, { scorer: 'tidiness', batched: true },
    ]);
    expect(record.trials[0]?.scoringCost).toEqual({ amount: 0.2, unit: 'USD', complete: true });
  }, 120_000);

  it("leaves a trial's judging cost incomplete when one of two batched launches of the same judge stated no cost", async () => {
    const other = QUALITY.replace('samplingRate: 0', 'samplingRate: 0\nmodel: other-model');
    const fixture = await judgedFixture({ judge: 'states-one-batch', scorers: ['quality', 'tidiness', 'polish', 'clarity'], team: { 'scorers/tidiness.md': QUALITY, 'scorers/polish.md': other, 'scorers/clarity.md': other } });

    const done = await runLocally(fixture);

    const record = z.object({ trials: z.array(z.object({ scoringCost: z.unknown(), verdicts: z.array(z.object({ decider: z.object({ model: z.string().optional() }).passthrough().optional() })) })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    // The correctness scorer alone, then quality and tidiness, then polish and clarity, which ask for another model;
    // the judge reports the same model for each, and only one of the two batches states its cost.
    expect(fixture.judgeLaunches()).toHaveLength(3);
    expect(new Set(record.trials[0]?.verdicts.map(({ decider }) => decider?.model))).toEqual(new Set(['fake-judge']));
    expect(record.trials[0]?.scoringCost).toEqual({ amount: 0.2, unit: 'USD', complete: false });
  }, 120_000);

  it("decides a task with a check and success criteria by its failing check with no judge, and by its judge once its check passes, on the work as the prompt left it", async () => {
    const mixed = (name: string, run: string) => `schemaVersion: v1alpha1
title: ${name}
prompt: Make answer.js export 42.
startingCommit: {{startingCommit}}
check:
  run: ${run}
  protect: [test.js, 'test/**']
  add: [{ from: check-files/extra.test.js, to: test/extra.test.js }]
successCriteria: answer.js exports 42.
`;
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: suite({ arms: [{ name: 'claude' }] }),
      tasks: { 'login-copy': mixed('Clearer login error', 'node test.js'), 'still-failing': mixed('Still failing', 'exit 1') },
      team: { 'benchmarks/fix/check-files/extra.test.js': 'written by the check\n' },
    });
    fixtures.push(fixture);

    const done = await runLocally(fixture);

    const runFile = RunSchema.parse(fixture.runFile(done.run));
    const checks = Object.fromEntries(runFile.steps.filter(({ id }) => id.endsWith('.check')).map((step) => [step.id, step.outputs]));
    const labels = fs.readFileSync(path.join(fixture.dataHome(), 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => z.object({ scorer: z.string(), label: z.string(), judge: z.object({ kind: z.string() }) }).passthrough().parse(JSON.parse(line)));
    const record = z.object({ tasks: z.array(z.object({ id: z.string(), sourceHash: z.string(), baseline: z.string() })), trials: z.array(z.object({ task: z.string(), result: z.string(), verdicts: z.unknown() })) }).parse(fixture.benchmarkRecord(done.run));
    const judged = fixture.judgeLaunches();
    expect(done.outcome).toBe('succeeded');
    expect(record.tasks.map(({ id, baseline }) => ({ id, baseline }))).toEqual([{ id: 'login-copy', baseline: 'valid' }, { id: 'still-failing', baseline: 'valid' }]);
    expect(checks['trials.r1.login-copy.claude.check']).toEqual({ result: 'passed', cause: '', label: '' });
    expect(checks['trials.r1.still-failing.claude.check']).toMatchObject({ result: 'failed', cause: '', label: expect.stringMatching(/.+/) });
    expect(labels.map(({ scorer, label, judge }) => ({ scorer, label, judge: judge.kind })).sort((left, right) => left.scorer.localeCompare(right.scorer))).toEqual([
      { scorer: 'teamai:correctness:login-copy', label: 'correct', judge: 'model' },
      { scorer: 'teamai:correctness:still-failing', label: 'incorrect', judge: 'stage' },
    ]);
    expect(judged.map(({ labels: allowed }) => allowed.join(' '))).toEqual(['correct incorrect']);
    expect(judged[0]?.diff).toContain('+module.exports = 42;');
    expect(judged[0]?.diff).not.toContain('extra.test.js');
    expect(record.trials.map(({ task, result, verdicts }) => ({ task, result, verdicts }))).toEqual([
      { task: 'login-copy', result: 'passed', verdicts: [expect.objectContaining({ scorer: 'teamai:correctness:login-copy', outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true }, decider: expect.objectContaining({ by: 'judge', tool: 'claude' }) })] },
      { task: 'still-failing', result: 'failed', verdicts: [{ scorer: 'teamai:correctness:still-failing', outcome: { kind: 'labelled', label: 'incorrect', score: 0, passed: false }, decider: { by: 'check', task: record.tasks[1]?.sourceHash } }] },
    ]);
  }, 120_000);

  it("leaves a trial of a task with a check and success criteria unscored when its check could not run, whatever a judge said", async () => {
    // The test fails on the starting commit, so the baseline is valid; once fixed, the check exits 127, as a missing command does.
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: suite({ arms: [{ name: 'claude' }] }),
      tasks: { 'login-copy': `${CRITERIA_TASK}check: { run: node test.js && exit 127, protect: [test.js] }\n` },
    });
    fixtures.push(fixture);

    const done = await runLocally(fixture);

    const record = z.object({ trials: z.array(z.object({ task: z.string(), result: z.string(), verdicts: z.unknown(), scoringCost: z.unknown().optional() })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    // The judge still ran, and what it cost is counted though its label is not.
    expect(fixture.judgeLaunches()).toHaveLength(1);
    expect(record.trials.map(({ task, result, verdicts, scoringCost }) => ({ task, result, verdicts, scoringCost }))).toEqual([
      { task: 'login-copy', result: 'error', verdicts: [{ scorer: 'teamai:correctness:login-copy', outcome: { kind: 'unscored', because: 'check_could_not_run' } }], scoringCost: { amount: 0.1, unit: 'USD', complete: true } },
    ]);
  }, 120_000);

  it("records a trial's judging cost as unknown when a judge launch ran and stated none, though its label is not kept", async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, judge: 'states-nothing', tools: ['claude'], suite: suite({ arms: [{ name: 'claude' }] }),
      tasks: { 'login-copy': `${CRITERIA_TASK}check: { run: node test.js && exit 127, protect: [test.js] }\n` },
    });
    fixtures.push(fixture);

    const done = await runLocally(fixture);

    const record = z.object({ trials: z.array(z.object({ result: z.string(), scoringCost: z.unknown().optional() })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    expect(fixture.judgeLaunches()).toHaveLength(1);
    expect(record.trials.map(({ result, scoringCost }) => ({ result, scoringCost }))).toEqual([{ result: 'error', scoringCost: { complete: false } }]);
  }, 120_000);

  it("counts what a calibration judge cost in its trial's judging cost when its label is refused, and records no calibration", async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, judge: 'another-label', tools: ['claude'], suite: `${suite({ arms: [{ name: 'claude' }] })}calibration: { rate: 100 }\n`,
      tasks: { 'still-failing': `${CRITERIA_TASK}check: { run: exit 1, protect: [test.js] }\n` },
    });
    fixtures.push(fixture);

    const done = await runLocally(fixture);

    const record = z.object({ trials: z.array(z.object({ result: z.string(), calibration: z.unknown().optional(), scoringCost: z.unknown().optional() })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    expect(fixture.judgeLaunches()).toHaveLength(1);
    expect(record.trials.map(({ result, calibration, scoringCost }) => ({ result, calibration, scoringCost }))).toEqual([{ result: 'failed', calibration: undefined, scoringCost: { amount: 0.1, unit: 'USD', complete: true } }]);
  }, 120_000);

  it("calibrates the correctness judge on a trial whose check failed, storing nothing, and shows how often it passed that work", async () => {
    const mixed = (name: string, run: string) => `schemaVersion: v1alpha1
title: ${name}
prompt: Make answer.js export 42.
startingCommit: {{startingCommit}}
check: { run: ${run}, protect: [test.js] }
successCriteria: answer.js exports 42.
`;
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: `${suite({ arms: [{ name: 'claude' }] })}calibration: { rate: 100 }\n`,
      tasks: { 'login-copy': mixed('Clearer login error', 'node test.js'), 'still-failing': mixed('Still failing', 'exit 1') },
    });
    fixtures.push(fixture);

    const done = await runLocally(fixture);

    const labels = fs.readFileSync(path.join(fixture.dataHome(), 'scores', 'labels.jsonl'), 'utf8').trim().split('\n');
    const record = z.object({ trials: z.array(z.object({ task: z.string(), result: z.string(), verdicts: z.unknown(), calibration: z.unknown().optional() })) }).parse(fixture.benchmarkRecord(done.run));
    expect(done.outcome).toBe('succeeded');
    // The judge of login-copy's passed check, then the one that calibrates still-failing's failed check.
    expect(fixture.judgeLaunches()).toHaveLength(2);
    expect(labels).toHaveLength(2);
    expect(outbox(fixture)).toEqual([]);
    expect(record.trials.map(({ task, result, calibration }) => ({ task, result, calibration }))).toEqual([
      { task: 'login-copy', result: 'passed', calibration: undefined },
      { task: 'still-failing', result: 'failed', calibration: { label: 'correct', passed: true, decider: expect.objectContaining({ by: 'judge', tool: 'claude', model: 'fake-judge', batched: false }), scoringCost: { amount: 0.1, unit: 'USD', complete: true } } },
    ]);
    expect(record.trials[1]?.verdicts).toEqual([expect.objectContaining({ scorer: 'teamai:correctness:still-failing', outcome: expect.objectContaining({ label: 'incorrect' }), decider: expect.objectContaining({ by: 'check' }) })]);
    expect(done.outputs.text).toContain('Judge calibration · teamai:correctness\n\n| Judge | Judged with a failed check | Labelled passing | False pass rate | 95% interval |\n| --- | --- | --- | --- | --- |\n| claude fake-judge | 1 | 1 | 100% | 21% to 100% |');
  }, 120_000);

  it("judges every arm's trials with the suite's defaults.tool, though an arm runs codex, and says that judge is also an arm's tool", async () => {
    const fixture = await judgedFixture({ arms: [{ name: 'claude' }, { name: 'codex', tool: 'codex' }], tools: ['claude', 'codex'] });

    const done = await runLocally(fixture);

    // Only the fake claude answers as a judge: a codex judge of the codex arm's trial would leave it unscored.
    expect(fixture.judgeLaunches().map(({ labels }) => labels.join(' '))).toEqual(['correct incorrect', 'correct incorrect']);
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(done.outputs.text).toContain('| codex | codex | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(done.outputs.text).toContain("Judge claude is also arm claude's tool; set tool in the scorer to judge with another.");
    const record = z.object({ judges: z.unknown(), trials: z.array(z.object({ arm: z.string(), verdicts: z.unknown() })) }).parse(fixture.benchmarkRecord(done.run));
    expect(record.judges).toEqual({ [CORRECTNESS]: { tool: 'claude', model: '' } });
    expect(record.trials.map(({ arm, verdicts }) => ({ arm, verdicts }))).toEqual(['claude', 'codex'].map((arm) => ({ arm, verdicts: [expect.objectContaining({
      scorer: CORRECTNESS, decider: expect.objectContaining({ by: 'judge', tool: 'claude', model: 'fake-judge' }), asPlanned: 'match',
    })] })));
  }, 120_000);

  it.each([
    ['incorrect', 'failed', '| claude | claude | tool default (team) | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0% (0/1) |', { kind: 'labelled', label: 'incorrect', score: 0, passed: false }],
    ['fails', 'unscored', '| claude | claude | tool default (team) | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0% (0/1) |', { kind: 'unscored', because: 'judge_failed' }],
    ['another-label', 'unscored', '| claude | claude | tool default (team) | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0% (0/1) |', { kind: 'unscored', because: 'judge_answer_invalid' }],
  ] as const)('makes a trial whose judge answers %s %s, and ends the run without waiting for its lease to lapse', async (judge, result, row, outcome) => {
    const fixture = await judgedFixture({ judge });

    const done = await runLocally(fixture);

    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain(row);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    expect(record.trials).toMatchObject([{ result }]);
    // The record keeps the pins it judged with, whatever the judge answered.
    expect(record.scorers).toEqual([{ name: CORRECTNESS, rubric: { sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) } }]);
    expect(record.baselineTeamRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(done.outputs.table.verdicts).toEqual([expect.objectContaining({ scorer: CORRECTNESS, outcome })]);
  }, 120_000);

  it('labels a trial whose judge stated no usage, and records its scoring cost as unknown', async () => {
    const fixture = await judgedFixture({ judge: 'states-nothing' });

    const done = await runLocally(fixture);

    expect(done.outputs.table.verdicts).toEqual([expect.objectContaining({ scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', score: 1, passed: true } })]);
    expect(done.outputs.table.verdicts[0]).not.toHaveProperty('scoringCost');
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run)).trials).toEqual([expect.objectContaining({ scoringCost: { complete: false } })]);
  }, 120_000);

  it('stops a judge still running at the suite timeout, and ends the run timed out with the trial unscored', async () => {
    const fixture = await judgedFixture({ judge: 'hangs', timeout: '20s' });

    const started = Date.now();
    const done = await runLocally(fixture);

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(fixture.judgeLaunches()).toHaveLength(1);
    expect(done.outcome).toBe('failed');
    expect(done.outputs.text).toContain('| claude | claude | tool default (team) | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0% (0/1) |');
  }, 120_000);

  it.each([
    ['success criteria', CRITERIA_TASK],
    ['a check and success criteria', `${CRITERIA_TASK}check: { run: node test.js, protect: [test.js] }\n`],
  ])('refuses to start a suite whose task has %s on a machine with no judge tool, and leaves no run', async (_, task) => {
    const fixture = await judgedFixture({ tools: [], task });

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(started.code).toBe(1);
    expect(envelope(started).error).toEqual({
      code: 'scoring_unavailable',
      message: 'This suite needs a judge (task "fix" has successCriteria), and this machine cannot judge: No judge tool is on PATH: install Claude Code, Codex, OpenCode or CodeBuddy. Fix it, or start the benchmark where a judge tool is installed.',
    });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('refuses to start a suite whose judge needs verified isolation on a machine whose judge tools run only best-effort, and leaves no run', async () => {
    const fixture = await judgedFixture({ team: { 'scorers/scoring.yaml': 'isolation: verified\n' } });
    const claude = path.join(fixture.bin, 'claude');
    fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace("console.log('2.1.308 (Claude Code)')", "console.log('2.0.0 (Claude Code)')"));
    await fixture.teamai(['pull']);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(started.code).toBe(1);
    expect(envelope(started).error).toEqual({
      code: 'scoring_unavailable',
      message: 'This suite needs a judge (task "fix" has successCriteria), and this machine cannot judge: Scorer "teamai:correctness:fix" needs a verified judge, which scorers/scoring.yaml isolation asks for, and claude, its judge tool, does not run verified here. Fix it, or start the benchmark where a judge tool is installed.',
    });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

});

/** A driver of another machine that provides the clones and sandbox a benchmark's steps require, launches claude, and runs it confined to a directory. */
const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/work' };
const CAN = {
  workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], unattended: true,
  confined: [{ level: 'verified', access: 'read', tools: ['claude'] }],
};
const NextSchema = z.object({
  data: z.union([
    z.object({
      lease: z.object({
        attempt: z.string(), revision: z.number(), step: z.string(), command: z.string().optional(), prompt: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(),
        confined: z.object({ dir: z.string() }).optional(),
      }).passthrough(),
    }),
    z.object({ wait: z.record(z.string(), z.unknown()) }),
    z.object({ done: z.object({ outcome: z.string(), outputs: z.object({ text: z.string() }).partial().optional() }).passthrough() }),
  ]),
});

/**
 * Drives benchmark run `run` to its end, in at most 40 calls of `next --prepare`: it runs a command lease in its place
 * under its attempt and reports what it printed, launches claude for a prompt lease there and reports how it went,
 * answers a lease confined to a directory with a correct label as a confined run of claude would, after reading the
 * diff in that directory, and waits on a `wait`. Answers the steps it was leased, each confined diff, and the run's done.
 */
async function drive(fixture: BenchmarkFixture, run: string) {
  const leased: string[] = [];
  const judged: string[] = [];
  for (let poll = 0; poll < 40; poll += 1) {
    const asked = await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]);
    const parsed = NextSchema.safeParse(envelope(asked));
    if (!parsed.success) throw new Error(`next answered no lease, wait or done: ${said(asked)}`);
    const answer = parsed.data.data;
    if ('done' in answer) return { leased, judged, done: answer.done };
    if ('wait' in answer) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      continue;
    }
    const { lease } = answer;
    leased.push(lease.step);
    const report = { attempt: lease.attempt, revision: lease.revision, driver: EXTERNAL };
    if (lease.confined) {
      judged.push(fs.readFileSync(path.join(lease.confined.dir, 'diff.patch'), 'utf8'));
      const confined = { tool: 'claude', isolation: 'verified', access: 'read' };
      const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({ ...report, outcome: 'success', outputs: { answer: { label: 'correct', reasoning: 'It exports 42.' } }, confined })]);
      if (reported.code !== 0) throw new Error(`report of ${lease.step}: ${said(reported)}`);
      continue;
    }
    const env = { ...fixture.env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}` };
    const started = Date.now();
    const ran = lease.command !== undefined
      ? spawnSync('/bin/sh', ['-c', lease.command], { cwd: lease.cwd, env, encoding: 'utf8' })
      : spawnSync(path.join(fixture.bin, 'claude'), ['-p', lease.prompt ?? ''], { cwd: lease.cwd, env, encoding: 'utf8' });
    const printed = ran.stdout.trim().split('\n').at(-1) ?? '';
    const outputs: unknown = lease.command !== undefined && ran.status === 0 && printed.startsWith('{') ? JSON.parse(printed) : undefined;
    const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({
      ...report, outcome: ran.status === 0 ? 'success' : 'failed',
      ...(lease.command !== undefined ? (outputs !== undefined ? { outputs } : {}) : { tool: 'claude', durationMs: Date.now() - started }),
    })]);
    if (reported.code !== 0) throw new Error(`report of ${lease.step}: ${said(reported)}\n${ran.stderr}`);
  }
  throw new Error(`run ${run} did not end in 40 calls: ${leased.join(', ')}`);
}

describe('benchmark judges of an external driver', () => {
  it("judges a trial with the run's own score step, from the evidence collected at the driver's report, and only then reports", async () => {
    const fixture = await judgedFixture();
    const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false}', '--timeout', '10m']);
    const runId = z.object({ run: z.string() }).parse(envelope(started).data).run;

    const { leased, judged, done } = await drive(fixture, runId);

    const judge = leased.findIndex((step) => step.endsWith('.judge'));
    expect(leased.slice(0, 3)).toEqual(['plan', 'trials.r1.fix.claude.prompt', 'subjects']);
    expect(judge).toBeGreaterThan(2);
    expect(leased.indexOf('report')).toBeGreaterThan(judge);
    expect(judged).toEqual([expect.stringContaining('+module.exports = 42;')]);
    expect(fixture.trialRootEntries()).toEqual([]);
    // The driver's judge reported no model, so the label cannot show it ran the judge the plan pins.
    expect(done.outputs?.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 100% (1/1) |');
    expect(fixture.runIds()).toEqual([runId]);
  }, 120_000);
});
