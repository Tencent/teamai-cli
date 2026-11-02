/**
 * Real CLI: what a benchmark run keeps once it has started. Its plan does not follow the suite, its record holds the
 * comparison after the suite is gone, and no control command measures a trial twice or moves the run to another machine.
 * A run is the workflow benchmark, which `teamai benchmark run` starts, or `workflow start teamai-benchmark` for another driver.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, driveCommands, envelope, FIX_SUITE, fixTask, PRODUCT_URL, said, startFixBenchmark, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const TWO_ARMS = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 1
timeout: 10m
`;

const QUALITY = `---
labels:
  - { value: tidy, score: 1, description: The change is small and clear }
  - { value: messy, score: 0, description: It is not }
passingScore: 1
---
Judge how tidy the change is.
`;

const PlanSchema = z.object({ suite: z.object({ sourceHash: z.string() }).passthrough(), repetitions: z.number(), tasks: z.array(z.object({ id: z.string(), sourceHash: z.string() }).passthrough()) }).passthrough();
const RunFileSchema = z.object({
  admitted: z.object({ plan: z.object({ output: z.object({ plan: PlanSchema }) }) }).optional(),
  steps: z.array(z.object({ id: z.string(), status: z.string(), attempt: z.string().optional(), failure: z.object({ code: z.string() }).optional() }).passthrough()),
}).passthrough();
const RecordSchema = z.object({
  suite: z.object({ sourceHash: z.string() }),
  repetitions: z.number(),
  baselineTeamRevision: z.string(),
  scorers: z.array(z.object({ name: z.string(), rubric: z.object({ sourceHash: z.string() }) })),
  tasks: z.array(z.object({ id: z.string(), sourceHash: z.string(), baseline: z.string() })),
  trials: z.array(z.object({ arm: z.string(), step: z.string(), result: z.string() })),
}).passthrough();
const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }).passthrough() }).passthrough();
const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], unattended: true };
const DRIVER = { kind: 'external', machine: 'lifecycle-driver', workspace: '/fake' };
const NO_SANDBOX = { driver: { kind: 'ci', machine: 'ci', workspace: '/fake', can: { workspace: ['read-only', 'new', 'continue', 'clone'] } } };

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function fixtureOf(options: Parameters<typeof benchmarkFixture>[0]): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture(options);
  fixtures.push(fixture);
  return fixture;
}

/** Starts the workflow teamai-benchmark for suite fix with no driver, and runs its plan step as a driver that is no sandbox, so the run waits at its trials. */
async function started(fixture: BenchmarkFixture): Promise<string> {
  const run = await startFixBenchmark(fixture);
  await driveCommands(fixture, run, NO_SANDBOX);
  return run;
}

/** The one `jq` command a guide page gives for a benchmark record on teamai-reports. */
function documentedJq(page: string): string {
  const commands = fs.readFileSync(path.join(ROOT, page), 'utf8').split('\n').filter((line) => line.startsWith('jq ') && line.includes('benchmarks/runs/'));
  const [command, ...more] = commands;
  if (command === undefined || more.length > 0) throw new Error(`${page} gives ${commands.length} benchmark jq commands, not one`);
  return command;
}

describe('a benchmark run once it has started', () => {
  it('keeps its plan through a suite edit and pull, and the guide computes its pass rates from the record once the suite is gone', async () => {
    const fixture = await fixtureOf({ tool: 'fails-first', sandbox: true, suite: TWO_ARMS });
    const runId = await started(fixture);
    const plan = RunFileSchema.parse(fixture.runFile(runId)).admitted?.plan.output.plan;
    fixture.pushTeam({
      'benchmarks/fix/suite.yaml': TWO_ARMS.replace('repetitions: 1', 'repetitions: 3'),
      'benchmarks/fix/tasks/fix.yaml': fixTask(fixture.startingCommit, 'Change the answer.'),
      'benchmarks/fix/tasks/more.yaml': fixTask(fixture.startingCommit),
    });
    const pulled = await fixture.teamai(['pull']);
    const edited = RunFileSchema.parse(fixture.runFile(await started(fixture))).admitted?.plan.output.plan;

    const resumed = await fixture.teamai(['workflow', 'resume', runId]);
    const done = DoneSchema.parse(envelope(resumed).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    fixture.pushTeam({ 'benchmarks/fix': null });
    const emptied = await fixture.teamai(['pull']);
    const gone = envelope(await fixture.teamai(['benchmark', 'run', 'fix']));
    const reports = path.join(fixture.root, 'reports');
    execFileSync('git', ['clone', '-q', '--branch', 'teamai-reports', fixture.teamOrigin, reports], { env: fixture.env });

    expect(pulled.code, said(pulled)).toBe(0);
    expect(resumed.code, said(resumed)).toBe(0);
    expect(plan?.suite.sourceHash).toBe(createHash('sha256').update(TWO_ARMS).digest('hex'));
    expect(record).toMatchObject({ suite: { sourceHash: plan?.suite.sourceHash }, repetitions: 1 });
    expect(record.tasks).toEqual([expect.objectContaining({ id: 'fix', sourceHash: plan?.tasks[0]?.sourceHash, baseline: 'valid' })]);
    expect(record.trials).toEqual([
      expect.objectContaining({ arm: 'claude', step: 'trials.r1.fix.claude.prompt', result: 'error' }),
      expect.objectContaining({ arm: 'codex', step: 'trials.r1.fix.codex.prompt', result: 'passed' }),
    ]);
    expect(fixture.toolLaunches()).toHaveLength(2);
    expect(emptied.code, said(emptied)).toBe(0);
    expect(gone.error?.code).toBe('benchmark_not_found');
    expect(edited).toMatchObject({ repetitions: 3, tasks: [{ id: 'fix' }, { id: 'more' }] });
    const command = documentedJq('docs/guide/workflow.md');
    const rates = execFileSync('sh', ['-c', command.replace('<run id>', runId)], { cwd: reports, encoding: 'utf8' }).trim().split('\n');
    expect(rates).toEqual(['claude 0% (0/1)', 'codex 100% (1/1)']);
    for (const rate of rates) {
      const [arm, ...printed] = rate.split(' ');
      expect(done.outputs.text.split('\n').filter((line) => line.startsWith(`| ${arm} |`) && line.endsWith(`| ${printed.join(' ')} |`))).toHaveLength(1);
    }
    expect(documentedJq('docs/guide/zh-CN/workflow.md')).toBe(command);
  }, 120_000);

  it("keeps the baseline team revision and each scorer's rubric hash on the record when every trial is not_run", async () => {
    const fixture = await fixtureOf({ tool: 'fixes', sandbox: true, tools: ['codex'], suite: `${FIX_SUITE}scorers: [quality]\n`, team: { 'scorers/quality.md': QUALITY } });
    const teamHead = execFileSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(record.baselineTeamRevision).toBe(teamHead);
    expect(record.scorers).toEqual([{ name: 'quality', rubric: { sourceHash: createHash('sha256').update(QUALITY).digest('hex') } }]);
    expect(record.tasks).toEqual([expect.objectContaining({ id: 'fix', baseline: 'valid' })]);
    expect(record.trials.map((trial) => trial.result)).toEqual(['not_run']);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('reads a trial cancelled before its lease as not_run and after it as error, and refuses retry, publish and claim', async () => {
    // Two lanes, so the codex trial is in the run, still unleased, while the claude trial runs.
    const fixture = await fixtureOf({ tool: 'fixes', sandbox: false, suite: TWO_ARMS.replace('repetitions: 1\n', 'repetitions: 1\nparallel: 2\n') });
    const status = fixture.status();
    const answer = envelope(await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']));
    const runId = String(answer.data?.run);
    const driver = { ...DRIVER, can: SANDBOX_CLAUDE };

    const leased = await driveCommands(fixture, runId, { driver });
    const early = envelope(await fixture.teamai(['workflow', 'cancel', runId, 'trials.lane2.r1.fix.codex.prompt']));
    const late = envelope(await fixture.teamai(['workflow', 'cancel', runId, 'trials.lane1.r1.fix.claude.prompt']));
    const before = fixture.runFile(runId);
    const retried = envelope(await fixture.teamai(['workflow', 'retry', runId, 'trials.lane1.r1.fix.claude.prompt']));
    const published = envelope(await fixture.teamai(['workflow', 'publish', runId]));
    const claimed = envelope(await fixture.teamai(['workflow', 'resume', runId, '--claim']));
    const nextClaimed = envelope(await fixture.teamai(['workflow', 'next', runId, '--json', JSON.stringify({ driver, running: [], claim: true })]));
    const after = fixture.runFile(runId);
    const done = await driveCommands(fixture, runId, { driver });
    const run = RunFileSchema.parse(fixture.runFile(runId));
    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    const snapshot = execFileSync('git', ['--git-dir', fixture.teamOrigin, 'ls-tree', '-r', '--name-only', 'teamai-reports'], { encoding: 'utf8' });

    expect(early.error).toBeUndefined();
    expect(leased).toMatchObject({ data: { lease: { step: 'trials.lane1.r1.fix.claude.prompt' } } });
    expect(late.error).toBeUndefined();
    expect(retried.error).toEqual({ code: 'not_retryable', message: `Run ${runId} is isolated: it runs only on the machine that started it, and a step that ran again would change what it already admitted or measured. Start a new run: teamai benchmark run fix` });
    expect(published.error).toMatchObject({ code: 'isolated_run' });
    expect(claimed.error).toMatchObject({ code: 'isolated_run' });
    expect(nextClaimed.error).toMatchObject({ code: 'isolated_run' });
    expect(after).toEqual(before);
    expect(snapshot).not.toContain(`workflows/runs/${runId}/state.json`);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(run.steps.find((step) => step.id === 'trials.lane2.r1.fix.codex.prompt')).toMatchObject({ status: 'cancelled', failure: { code: 'cancelled' } });
    expect(run.steps.find((step) => step.id === 'trials.lane2.r1.fix.codex.prompt')).not.toHaveProperty('attempt');
    expect(run.steps.find((step) => step.id === 'trials.lane1.r1.fix.claude.prompt')).toMatchObject({ status: 'cancelled', attempt: expect.any(String), failure: { code: 'cancelled' } });
    expect(record.trials).toEqual([
      expect.objectContaining({ arm: 'claude', result: 'error' }),
      expect.objectContaining({ arm: 'codex', result: 'not_run' }),
    ]);
    expect(fixture.toolLaunches()).toEqual([]);
    expect(fixture.status()).toBe(status);
  }, 120_000);

  it("is refused by the skill driver, which launches no trial tool, and handed to the person's local resume", async () => {
    const fixture = await fixtureOf({ tool: 'fixes', sandbox: false, suite: FIX_SUITE });
    const answer = envelope(await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']));
    const runId = String(answer.data?.run);

    const resumed = await fixture.teamai(['workflow', 'resume', runId, '--driver', 'skill']);

    expect(envelope(resumed).error).toEqual({
      code: 'invoke_denied',
      message: `Workflow "teamai-benchmark" has invoke: deny, so no coding agent continues it, with any driver, and this command uses --driver skill, which only a coding agent drives. The person can continue it from their own terminal with teamai workflow resume ${runId}. To let agents continue it, the team sets invoke: allow, or invoke: ask for a resume after the person agrees, in workflows/teamai-benchmark.yaml.`,
      next: null,
    });
    expect(RunFileSchema.parse(fixture.runFile(runId)).steps.every((step) => step.status === 'pending')).toBe(true);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});
