/**
 * Real CLI: `teamai benchmark run` starts the workflow `teamai-benchmark`, teamai's default or the team's file of that name,
 * which plans the suite, runs its trials in fresh clones from the plan, and reports them in a finally step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string(), table: z.unknown().optional() }) }).passthrough();
const RecordSchema = z.object({ run: z.string(), outcome: z.string(), workflow: z.object({ name: z.string(), origin: z.object({ source: z.string() }) }).passthrough(), trials: z.array(z.unknown()) }).passthrough();

describe('teamai benchmark run', () => {
  it('runs the shipped benchmark workflow: plan, trials from the plan, and a report with the record', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const kept = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(ran.stderr).toContain(done.outputs.text);
    expect(kept).toMatchObject({
      run: done.run, outcome: 'succeeded', workflow: { name: 'teamai-benchmark', origin: { source: 'default' } },
      trials: [{ task: 'fix', arm: 'claude', step: 'trials.r1.fix.claude.prompt', result: 'passed' }],
    });
    expect(fixture.reportedBenchmark(done.run)).toEqual(fixture.benchmarkRecord(done.run));
  }, 180_000);

  it('runs each trial prompt in its tool\'s unattended mode, so a tool the machine grants no edits still fixes the task', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes-when-unattended', sandbox: true });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(done.outputs.text).not.toContain('own permission settings');
  }, 180_000);

  it('shows record: pending when teamai-reports refuses the record, and exits 0', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const hook = path.join(fixture.teamOrigin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/teamai-reports ] && exit 1; done\nexit 0\n', { mode: 0o755 });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(done.outputs.text.endsWith('\n\nrecord: pending')).toBe(true);
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run))).toMatchObject({ run: done.run, outcome: 'succeeded' });
  }, 180_000);

  it('keeps the record only in the run directory when the team turns usage reporting off', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    fixture.pushTeam({ 'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\nusageReport: false\n` });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code, said(ran)).toBe(0);
    expect(done.outputs.text).not.toContain('record: pending');
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run))).toMatchObject({ run: done.run, outcome: 'succeeded' });
    expect(() => fixture.reportedBenchmark(done.run)).toThrow();
  }, 180_000);
});

/** The shipped workflow without its strict sandbox, as a team may write it. */
const RELAXED = `schemaVersion: v1alpha1
name: teamai-benchmark
description: Run a benchmark suite on any machine.
invoke: deny
inputs: { suite: string }
steps:
  - id: plan
    command: teamai benchmark plan "$SUITE"
    env: { SUITE: "{{ inputs.suite }}" }
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
finally:
  - id: report
    command: teamai benchmark report
    output: { text: string, table: json }
outputs: { text: steps.report.outputs.text }
`;

describe('a team benchmark workflow', () => {
  it('replaces the shipped one, and benchmark run names it', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': RELAXED });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code, said(ran)).toBe(0);
    expect(ran.stderr).toContain('Running the team\'s workflows/teamai-benchmark.yaml, which replaces teamai\'s benchmark workflow.');
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(fixture.benchmarkRecord(done.run)).toMatchObject({ workflow: { name: 'teamai-benchmark', origin: { source: 'team' } } });
  }, 180_000);

  it('runs its trials with the tool\'s own permission settings when it drops the strict sandbox, and says so', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes-when-unattended', sandbox: true });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': RELAXED });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code, said(ran)).toBe(0);
    expect(done.outputs.text.startsWith('Each trial ran with its tool\'s own permission settings, since the step that runs the plan is not a strict sandbox: a tool that may not edit failed its trials. To run them with permissions: unattended, keep requires: { isolation: sandbox, strict: true } on that step.\n\n')).toBe(true);
    expect(done.outputs.text).toContain('0% (0/1)');
  }, 180_000);

  it('replaces the shipped one from the namespace the member\'s role receives, and benchmark run names its file', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: false, role: 'ops',
      team: { 'manifest/roles.yaml': 'version: 1\nroles:\n  - id: ops\n    resources:\n      knowledge: []\n      skills: []\n      workflows: [ops]\n', 'workflows/ops/teamai-benchmark.yaml': RELAXED },
    });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);

    expect(ran.code, said(ran)).toBe(0);
    expect(ran.stderr).toContain('Running the team\'s workflows/ops/teamai-benchmark.yaml, which replaces teamai\'s benchmark workflow.');
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(fixture.benchmarkRecord(done.run)).toMatchObject({ workflow: { name: 'teamai-benchmark', origin: { source: 'team' } } });
  }, 180_000);

  it('is refused by benchmark run, leaving no run, when two namespaces the member receives both define it', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, role: 'ops',
      team: {
        'manifest/roles.yaml': 'version: 1\nroles:\n  - id: ops\n    resources:\n      knowledge: []\n      skills: []\n      workflows: [a, b]\n',
        'workflows/a/teamai-benchmark.yaml': RELAXED, 'workflows/b/teamai-benchmark.yaml': RELAXED,
      },
    });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(1);
    expect(envelope(ran).error).toEqual({
      code: 'workflow_namespace_conflict',
      message: 'Workflow "teamai-benchmark" is defined in multiple active namespaces (workflows/a/teamai-benchmark.yaml and workflows/b/teamai-benchmark.yaml); conflicting workflows have no runnable version. Keep it in one namespace, push it, run teamai pull, and start again.',
    });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 180_000);

  it('is refused by workflow start, leaving no run, when two namespaces the member receives both define it', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, role: 'ops',
      team: {
        'manifest/roles.yaml': 'version: 1\nroles:\n  - id: ops\n    resources:\n      knowledge: []\n      skills: []\n      workflows: [a, b]\n',
        'workflows/a/teamai-benchmark.yaml': RELAXED, 'workflows/b/teamai-benchmark.yaml': RELAXED,
      },
    });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--driver', 'local', '--sandbox', '--timeout', '10m', '--inputs', '{"suite":"fix","aliases":"team"}']);

    expect(started.code, said(started)).toBe(1);
    expect(envelope(started).error).toMatchObject({ code: 'workflow_namespace_conflict' });
    expect(fixture.runIds()).toEqual([]);
  }, 180_000);

  it('is refused by benchmark run, leaving no run, when it takes no input suite', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': RELAXED.replace('inputs: { suite: string }', 'inputs: { name: string }').replaceAll('inputs.suite', 'inputs.name') });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code).toBe(1);
    expect(envelope(ran).error).toEqual({ code: 'invalid_inputs', message: 'The team\'s workflows/teamai-benchmark.yaml replaces teamai\'s benchmark workflow and takes no input suite, so teamai benchmark run cannot give it the suite. Add inputs: { suite: string } to it, or remove it to run teamai\'s default.' });
    expect(fixture.runIds()).toEqual([]);
  }, 180_000);

  it('is refused by benchmark run --member-aliases, leaving no run, when it takes no input aliases', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': RELAXED });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--member-aliases']);

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code).toBe(1);
    expect(envelope(ran).error).toEqual({ code: 'invalid_inputs', message: 'The team\'s workflows/teamai-benchmark.yaml replaces teamai\'s benchmark workflow and takes no input aliases, so teamai benchmark run cannot give it --member-aliases. Add aliases: string to its inputs and pass it to teamai benchmark plan --aliases, or run without --member-aliases.' });
    expect(fixture.runIds()).toEqual([]);
  }, 180_000);
});

/** A team benchmark workflow whose plan step prints a plan of a schemaVersion no teamai reads, and a bundle of `steps`. */
function futurePlan(steps: ReadonlyArray<Record<string, unknown>>): string {
  const printed = { definition: { definition: { schemaVersion: 'v1alpha1', name: 'future', description: 'A newer plan.', steps } }, plan: { schemaVersion: 99 } };
  return RELAXED.replace('command: teamai benchmark plan "$SUITE"', `command: node -e 'process.stdout.write(process.argv[1])' '${JSON.stringify(printed)}'`);
}

const StepsSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), message: z.string().optional() }).passthrough()) }).passthrough();
const FUTURE = 'printed a benchmark plan of schemaVersion 99, and this teamai reads only schemaVersion 1. Run the benchmark with the teamai that planned it, or start it again.';

describe('a plan of an unknown schemaVersion', () => {
  it('fails the report, and benchmark run exits 1 though the run succeeded', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': futurePlan([{ id: 'noop', command: 'node -e 0' }]) });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done);
    const report = StepsSchema.parse(fixture.runFile(done.run)).steps.find((step) => step.id === 'report');

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code, said(ran)).toBe(1);
    expect(done).toMatchObject({ outcome: 'succeeded', finally: [{ id: 'report', outcome: 'failed' }] });
    expect(report).toMatchObject({ status: 'failed', message: expect.stringContaining(FUTURE) });
  }, 180_000);

  it('fails a benchmark check', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': futurePlan([{ id: 'check', command: 'teamai benchmark check --trial' }]) });
    const pulled = await fixture.teamai(['pull']);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = z.object({ run: z.string() }).passthrough().parse(envelope(ran).data?.done);
    const check = StepsSchema.parse(fixture.runFile(done.run)).steps.find((step) => step.id === 'trials.check');

    expect(pulled.code, said(pulled)).toBe(0);
    expect(ran.code).toBe(1);
    expect(check).toMatchObject({ status: 'failed', message: expect.stringContaining(FUTURE) });
  }, 180_000);
});

describe('the benchmark workflow', () => {
  it('fails at plan, naming workflow start --timeout, when started directly with no timeout or a longer one than the suite\'s', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);

    const unbounded = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--driver', 'local']);
    const longer = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--driver', 'local', '--timeout', '11m']);

    expect(unbounded.code, said(unbounded)).toBe(1);
    expect(envelope(unbounded).data?.done).toMatchObject({ outcome: 'failed' });
    expect(unbounded.stderr).toContain('has no timeout, and suite "fix" allows 10m. Start it with teamai workflow start teamai-benchmark --timeout 10m, or with teamai benchmark run fix, which sets it.');
    expect(longer.code, said(longer)).toBe(1);
    expect(longer.stderr).toContain('may take 11m, and suite "fix" allows 10m.');
    expect(fixture.toolLaunches()).toEqual([]);
  }, 180_000);
});
