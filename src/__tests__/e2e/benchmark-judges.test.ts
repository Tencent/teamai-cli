/**
 * Real CLI: every trial is judged before its run ends. A task judged by success criteria gets a correctness label on
 * each trial, and the suite's scorers judge every trial, from the evidence teamai collected from the trial's clone when
 * its prompt was reported, so the judge runs after the clone is gone. A trial whose judge fails is unscored, at once.
 */
import { spawnSync } from 'node:child_process';
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
const RunSchema = z.object({ status: z.string(), verdicts: z.array(z.object({ scorer: z.string(), step: z.string(), outcome: z.record(z.string(), z.unknown()) }).passthrough()) });
const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }) }) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function judgedFixture(options: { judge?: FakeJudge; arms?: Array<{ name: string; model?: string }>; scorers?: string[]; tools?: Array<'claude' | 'codex'>; timeout?: string } = {}): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, judge: options.judge, tools: options.tools ?? ['claude'],
    suite: suite({ arms: options.arms ?? [{ name: 'claude' }], scorers: options.scorers }).replace('timeout: 10m', `timeout: ${options.timeout ?? '10m'}`), tasks: { fix: CRITERIA_TASK },
    team: options.scorers ? { 'scorers/quality.md': QUALITY } : {},
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
    expect(RunSchema.parse(fixture.runFile(done.run)).verdicts).toHaveLength(4);
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
    expect(RunSchema.parse(fixture.runFile(done.run)).verdicts).toEqual([expect.objectContaining({ scorer: CORRECTNESS, outcome })]);
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

  it('names a suite scorer that has no valid scorer at pull, and refuses to start the suite without it', async () => {
    const fixture = await judgedFixture({ scorers: ['quality', 'missing'] });

    const pulled = await fixture.teamai(['pull']);
    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(pulled.stdout + pulled.stderr).toContain('benchmarks/fix/suite.yaml: suite "fix" lists scorer "missing", which has no valid scorers/missing.md; the benchmark does not start without it');
    expect(envelope(started).error).toEqual({
      code: 'scorer_not_found',
      message: 'Suite "fix" lists scorer "missing", which has no valid scorers/missing.md for this member. Add the scorer, or remove it from benchmarks/fix/suite.yaml, push it, run teamai pull, and start again.',
    });
    expect(started.code).toBe(1);
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});

/** A driver of another machine that provides the clones and sandbox a benchmark's steps require, and launches claude. */
const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/work' };
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], unattended: true };
const NextSchema = z.object({
  data: z.union([
    z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), step: z.string(), command: z.string().optional(), prompt: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string() }).passthrough() }),
    z.object({ wait: z.record(z.string(), z.unknown()) }),
    z.object({ done: z.object({ outcome: z.string(), outputs: z.object({ text: z.string() }).partial().optional() }).passthrough() }),
  ]),
});

/**
 * Drives benchmark run `run` for at most `polls` calls of `next --prepare`: it runs a command lease in its place under
 * its attempt and reports what it printed, launches claude for a prompt lease there and reports how it went, and waits
 * on a `wait`. Answers the steps it was leased, and the run's done once it ended.
 */
async function drive(fixture: BenchmarkFixture, run: string, polls: number) {
  const leased: string[] = [];
  for (let poll = 0; poll < polls; poll += 1) {
    const asked = await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]);
    const parsed = NextSchema.safeParse(envelope(asked));
    if (!parsed.success) throw new Error(`next answered no lease, wait or done: ${said(asked)}`);
    const answer = parsed.data.data;
    if ('done' in answer) return { leased, done: answer.done };
    if ('wait' in answer) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      continue;
    }
    const { lease } = answer;
    leased.push(lease.step);
    const env = { ...fixture.env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}` };
    const started = Date.now();
    const ran = lease.command !== undefined
      ? spawnSync('/bin/sh', ['-c', lease.command], { cwd: lease.cwd, env, encoding: 'utf8' })
      : spawnSync(path.join(fixture.bin, 'claude'), ['-p', lease.prompt ?? ''], { cwd: lease.cwd, env, encoding: 'utf8' });
    const outputs: unknown = lease.command !== undefined && ran.status === 0 ? JSON.parse(ran.stdout) : undefined;
    const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({
      attempt: lease.attempt, revision: lease.revision, driver: EXTERNAL, outcome: ran.status === 0 ? 'success' : 'failed',
      ...(outputs !== undefined ? { outputs } : { tool: 'claude', durationMs: Date.now() - started }),
    })]);
    if (reported.code !== 0) throw new Error(`report of ${lease.step}: ${said(reported)}`);
  }
  return { leased };
}

describe('benchmark judges of an external driver', () => {
  it("judges a trial from the evidence collected at the driver's report, with teamai score, and only then ends the run", async () => {
    const fixture = await judgedFixture();
    const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']);
    const runId = z.object({ run: z.string() }).parse(envelope(started).data).run;

    const judging = await drive(fixture, runId, 5);
    const judge = { kind: 't3', machine: 'judge', workspace: fixture.work };
    const next = await fixture.teamai(['score', '--next', '--json', JSON.stringify({ driver: { ...judge, can: { judge: { isolation: 'verified', tools: ['claude'] } } } })]);
    const lease = z.object({ data: z.object({ lease: z.object({ ref: z.string() }) }) }).parse(envelope(next));
    const labelled = envelope(await fixture.teamai(['score', '--lease', lease.data.lease.ref, '--json', JSON.stringify({ driver: judge })]));
    const ended = await drive(fixture, runId, 4);

    expect(judging).toEqual({ leased: ['plan', 'trials.r1.fix.claude.prompt'] });
    expect(labelled).toMatchObject({ data: { label: { scorer: CORRECTNESS, label: 'correct', passed: true } } });
    expect(fixture.judgeLaunches()).toEqual([{ labels: ['correct', 'incorrect'], diff: expect.stringContaining('+module.exports = 42;'), trialRoots: [] }]);
    expect(ended.leased).toEqual(['report']);
    expect(ended.done?.outputs?.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
  }, 120_000);
});
