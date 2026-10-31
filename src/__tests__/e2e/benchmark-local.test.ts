/**
 * Real CLI: a one-task, one-arm check suite, run by `teamai benchmark run` in a member's checkout on the local driver in
 * a declared sandbox, or started as the workflow `teamai-benchmark` for another driver.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveRunMode } from '../../launch-context.js';
import { benchmarkFixture, driveCommands, envelope, FIX_SUITE, fixTask, PRODUCT_URL, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

interface StepTree {
  id: string;
  workflow?: { steps: StepTree[] };
}
const StepTreeSchema: z.ZodType<StepTree> = z.lazy(() => z.object({
  id: z.string(),
  workflow: z.object({ steps: z.array(StepTreeSchema) }).optional(),
}));
const RunFileSchema = z.object({
  runMode: z.string().optional(),
  steps: z.array(z.object({ id: z.string(), end: z.string().optional() }).passthrough()),
  admitted: z.object({
    plan: z.object({
      output: z.object({
        definition: z.object({ teamRevision: z.string() }).passthrough(),
        plan: z.object({ baselineTeamRevision: z.string(), trials: z.array(z.unknown()) }).passthrough(),
      }),
      definition: z.object({ steps: z.array(StepTreeSchema) }).passthrough(),
    }),
  }).optional(),
}).passthrough();

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }).passthrough() }).passthrough();
const RecordSchema = z.object({ trials: z.array(z.unknown()) }).passthrough();
const EndRecordSchema = z.object({ workflow: z.string(), status: z.string(), isolated: z.boolean().optional() }).passthrough();
const CAPTION = 'These results hold for these tasks, this run and this machine.';
const NO_SANDBOX = 'Step "trials" requires strict isolation, and the local driver here is not a sandbox. Run it in CI or a container, and declare it with --sandbox or workflows.sandbox: true.';
const USER_SCOPE = 'A benchmark gives each trial the team revision it plans, but this team also reaches this checkout through user scope, where every workspace shares one copy, so a trial could read team assets that revision does not have. Remove the user-scope install, or turn off inheritUserScope in this workspace, and run the benchmark again.';

const TWO_BY_TWO = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 2
timeout: 10m
`;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function occurrences(text: string, line: string): number {
  return text.split(line).length - 1;
}

function leafSteps(steps: StepTree[], prefix = ''): string[] {
  return steps.flatMap((step) => (step.workflow ? leafSteps(step.workflow.steps, `${prefix}${step.id}.`) : [`${prefix}${step.id}`]));
}

describe('benchmark on the local driver', () => {
  it('the plan step stores the plan, and a driver without a sandbox is held from the trials', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const teamHead = execFileSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

    const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']);
    const run = String(envelope(started).data?.run);
    const driver = { kind: 'ci', machine: 'ci', workspace: fixture.work, can: { workspace: ['read-only', 'new', 'continue', 'clone'] } };
    const next = await driveCommands(fixture, run, { driver });
    const stored = RunFileSchema.parse(fixture.runFile(run));
    const beforePull = fixture.runFile(run);
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': fixTask(fixture.startingCommit, 'Change the answer.') });
    const pulled = await fixture.teamai(['pull']);

    expect(started.code, said(started)).toBe(0);
    expect(stored.admitted?.plan.output.definition.teamRevision).toBe(teamHead);
    // The fixture's CLI inherits this process's CI and TEAMAI_MODE.
    expect(stored.runMode).toBe(resolveRunMode(process.env));
    expect(stored.admitted?.plan.output.plan).toMatchObject({
      suite: { name: 'fix', repo: 'https://github.com/fixture/app.git' },
      baselineTeamRevision: teamHead,
      selection: { additionalRoles: [], projects: [], excludedSkills: [] },
      repetitions: 1,
      tasks: [{ id: 'fix', startingCommit: fixture.startingCommit, judge: { kind: 'check', run: 'node test.js', protect: ['test.js'] } }],
      arms: [{ name: 'claude', tool: 'claude', team: { kind: 'pulled', revision: teamHead } }],
      trials: [{ order: 1, repetition: 1, task: 'fix', arm: 'claude', step: 'r1.fix.claude.prompt' }],
    });
    expect(leafSteps(stored.admitted?.plan.definition.steps ?? [])).toEqual(['baselines.fix', 'r1.fix.claude.prompt', 'r1.fix.claude.check', 'settled']);
    expect(next).toMatchObject({ data: { wait: { held: [{ step: 'trials.baselines.fix', missing: ['isolation', 'env'] }] } } });
    expect(pulled.code, said(pulled)).toBe(0);
    expect(fs.readFileSync(path.join(fixture.teamClone, 'benchmarks', 'fix', 'tasks', 'fix.yaml'), 'utf8')).toContain('Change the answer.');
    expect(fixture.runFile(run)).toEqual(beforePull);
  }, 120_000);

  it.each([
    ['passed', 'fixes', '100% (1/1)'],
    ['failed', 'does-nothing', '0% (0/1)'],
  ] as const)('%s', async (result, tool, passRate) => {
    const fixture = await benchmarkFixture({ tool, sandbox: true });
    fixtures.push(fixture);
    const before = fixture.status();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    const end = EndRecordSchema.parse(fixture.endRecord(done.run));
    const [launch, ...more] = fixture.toolLaunches();

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outcome).toBe('succeeded');
    expect(RunFileSchema.parse(fixture.runFile(done.run)).steps.find((step) => step.id === 'trials')).toMatchObject({ end: 'settled' });
    expect(done.outputs.text).toContain(passRate);
    expect(done.outputs.text).toContain(CAPTION);
    expect(ran.stderr).toContain(done.outputs.text);
    expect(end).toMatchObject({ workflow: 'teamai-benchmark', status: 'succeeded', isolated: true });
    expect(end).not.toHaveProperty('benchmark');
    expect(record.trials).toMatchObject([{ task: 'fix', arm: 'claude', repetition: 1, order: 1, step: 'trials.r1.fix.claude.prompt', result }]);
    expect(more).toEqual([]);
    expect(launch).toMatchObject({ ownGit: true, head: fixture.startingCommit, remotes: '' });
    expect(launch?.cwd.startsWith(path.join(fixture.tmp, 'teamai-clones'))).toBe(true);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  it('eight trials', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fails-first', sandbox: true, suite: TWO_BY_TWO,
      tasks: { one: fixTask('{{startingCommit}}'), two: fixTask('{{startingCommit}}') },
    });
    fixtures.push(fixture);
    const before = fixture.status();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    const launches = fixture.toolLaunches();

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outcome).toBe('succeeded');
    expect(record.trials).toMatchObject([
      { order: 1, repetition: 1, task: 'one', arm: 'claude', step: 'trials.r1.one.claude.prompt', result: 'error' },
      { order: 2, repetition: 1, task: 'one', arm: 'codex', step: 'trials.r1.one.codex.prompt', result: 'passed' },
      { order: 3, repetition: 1, task: 'two', arm: 'claude', step: 'trials.r1.two.claude.prompt', result: 'passed' },
      { order: 4, repetition: 1, task: 'two', arm: 'codex', step: 'trials.r1.two.codex.prompt', result: 'passed' },
      { order: 5, repetition: 2, task: 'one', arm: 'codex', step: 'trials.r2.one.codex.prompt', result: 'passed' },
      { order: 6, repetition: 2, task: 'one', arm: 'claude', step: 'trials.r2.one.claude.prompt', result: 'passed' },
      { order: 7, repetition: 2, task: 'two', arm: 'codex', step: 'trials.r2.two.codex.prompt', result: 'passed' },
      { order: 8, repetition: 2, task: 'two', arm: 'claude', step: 'trials.r2.two.claude.prompt', result: 'passed' },
    ]);
    expect(launches.map((launch) => launch.tool)).toEqual(['claude', 'codex', 'claude', 'codex', 'codex', 'claude', 'codex', 'claude']);
    expect(new Set(launches.map((launch) => launch.cwd)).size).toBe(8);
    for (const launch of launches) expect(launch).toMatchObject({ ownGit: true, head: fixture.startingCommit, remotes: '' });
    expect(done.outputs.text).toContain('| claude | claude | tool default (team) | 4 | 3 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 75% (3/4) |');
    expect(done.outputs.text).toContain('| codex | codex | tool default (team) | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (4/4) |');
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  it('--sandbox declares a sandbox for this process only', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--sandbox']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));
    const again = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    expect(record.trials).toEqual([expect.objectContaining({ arm: 'claude', result: 'passed' })]);
    expect(again.code).toBe(1);
    expect(envelope(again).error).toEqual({ code: 'requirement_unmet', message: NO_SANDBOX });
    expect(fixture.runIds()).toEqual([done.run]);
  }, 120_000);

  it('no sandbox', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code).toBe(1);
    expect(envelope(ran)).toEqual({ error: { code: 'requirement_unmet', message: NO_SANDBOX } });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('a tool that hangs is stopped at the suite timeout', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: true, suite: FIX_SUITE.replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = envelope(ran).data?.done;

    expect(ran.code, said(ran)).toBe(1);
    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(ran.stderr).toContain('| claude | claude | tool default (team) | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0% (0/1) |');
    expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude']);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('prints the table of a run cancelled during its trials, with the trial it never reached not_run, and exits 1', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: true, suite: FIX_SUITE.replace('repetitions: 1', 'repetitions: 2') });
    fixtures.push(fixture);

    const running = fixture.teamai(['benchmark', 'run', 'fix']);
    for (let polls = 0; fixture.toolLaunches().length === 0; polls += 1) {
      if (polls > 120) throw new Error('the first trial never launched its tool');
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    const [runId = ''] = fixture.runIds();
    const cancelled = await fixture.teamai(['workflow', 'cancel', runId]);
    const ran = await running;

    expect(cancelled.code, said(cancelled)).toBe(0);
    expect(ran.code, said(ran)).toBe(1);
    expect(DoneSchema.parse(envelope(ran).data?.done)).toMatchObject({ run: runId, outcome: 'cancelled' });
    const trials = z.array(z.object({ repetition: z.number(), result: z.string() }).passthrough()).parse(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials);
    expect(trials.find(({ repetition }) => repetition === 2)?.result).toBe('not_run');
    expect(ran.stderr).toMatch(/\| claude \| claude \| tool default \(team\) \| 2 \| 0 \| 0 \| [01] \| 0 \| [12] \|/);
    expect(fixture.toolLaunches()).toHaveLength(1);
  }, 120_000);

  it('tool missing', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], suite: TWO_BY_TWO });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outcome).toBe('succeeded');
    expect(occurrences(ran.stderr, 'Arm "codex" uses codex, which the local driver cannot run, so its trials did not run.')).toBe(1);
    expect(ran.stderr).not.toContain(NO_SANDBOX);
    expect(record.trials).toEqual([
      expect.objectContaining({ order: 1, arm: 'claude', result: 'passed' }),
      expect.objectContaining({ order: 2, arm: 'codex', result: 'not_run' }),
      expect.objectContaining({ order: 3, arm: 'codex', result: 'not_run' }),
      expect.objectContaining({ order: 4, arm: 'claude', result: 'passed' }),
    ]);
    expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude', 'claude']);
  }, 120_000);

  it('user scope reaches the team, so it refuses before the run', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const user = await fixture.teamai(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(user.code, said(user)).toBe(0);
    expect(ran.code).toBe(1);
    expect(envelope(ran)).toEqual({ error: { code: 'team_ref_blocked', message: USER_SCOPE } });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('a workspace that inherits user scope refuses before the run, with no user-scope install', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const inherits = await fixture.teamai(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--inherit-user-scope', '--force']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(inherits.code, said(inherits)).toBe(0);
    expect(ran.code).toBe(1);
    expect(envelope(ran)).toEqual({ error: { code: 'team_ref_blocked', message: USER_SCOPE } });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});
