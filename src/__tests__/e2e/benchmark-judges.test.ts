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

/** A suite of the one task, whose arms each run claude, the first on its default model, the others on the model named. */
const suite = ({ arms, scorers = [] }: { arms: Array<{ name: string; model?: string }>; scorers?: string[] }) => `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
${arms.map(({ name, model }) => `  - name: ${name}\n${model ? `    model: ${model}\n` : ''}`).join('')}${scorers.length > 0 ? `scorers: [${scorers.join(', ')}]\n` : ''}repetitions: 1
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

async function judgedFixture(options: { judge?: FakeJudge; arms?: Array<{ name: string; model?: string }>; scorers?: string[]; tools?: Array<'claude' | 'codex'>; timeout?: string; team?: Record<string, string> } = {}): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, judge: options.judge, tools: options.tools ?? ['claude'],
    suite: suite({ arms: options.arms ?? [{ name: 'claude' }], scorers: options.scorers }).replace('timeout: 10m', `timeout: ${options.timeout ?? '10m'}`), tasks: { fix: CRITERIA_TASK },
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
      { scorer: 'quality', outcome: { kind: 'labelled', label: 'tidy', passed: true } },
      { scorer: 'quality', outcome: { kind: 'labelled', label: 'tidy', passed: true } },
      { scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', passed: true } },
      { scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', passed: true } },
    ]);
    const runFile = RunSchema.parse(fixture.runFile(done.run));
    expect(runFile).not.toHaveProperty('verdicts');
    expect(runFile.steps.filter(({ id }) => id === 'subjects' || id === 'score').map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'subjects', status: 'succeeded' }, { id: 'score', status: 'succeeded' }]);
    // Each trial is judged by a step of the benchmark run, never by a teamai-score run of its own, and its labels stay here.
    expect(fixture.runIds()).toEqual([done.run]);
    expect(outbox(fixture)).toEqual([]);
  }, 120_000);

  it.each([
    ['incorrect', 'failed', '| claude | claude | tool default (team) | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0% (0/1) |', { kind: 'labelled', label: 'incorrect', passed: false }],
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

  it('labels a trial whose judge stated no usage, and records no scoring cost for it', async () => {
    const fixture = await judgedFixture({ judge: 'states-nothing' });

    const done = await runLocally(fixture);

    expect(done.outputs.table.verdicts).toEqual([expect.objectContaining({ scorer: CORRECTNESS, outcome: { kind: 'labelled', label: 'correct', passed: true } })]);
    expect(done.outputs.table.verdicts[0]).not.toHaveProperty('scoringCost');
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run)).trials).toEqual([expect.not.objectContaining({ scoringCost: expect.anything() })]);
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

  it('refuses to start a suite that needs a judge on a machine with no judge tool, and leaves no run', async () => {
    const fixture = await judgedFixture({ tools: [] });

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
      message: 'This suite needs a judge (task "fix" has successCriteria), and this machine cannot judge: Scorer "teamai:correctness:fix" needs a verified judge, which scorers/scoring.yaml isolation asks for, and no judge tool here runs verified. Fix it, or start the benchmark where a judge tool is installed.',
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
    expect(done.outputs?.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(fixture.runIds()).toEqual([runId]);
  }, 120_000);
});
