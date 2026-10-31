/**
 * Real CLI on the local driver: teamai tries each task's check on its starting commit before any trial, and checks a
 * trial against the protected paths as the starting commit has them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture, type BenchmarkFixtureOptions } from '../helpers/benchmark-fixture.js';

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }) }).passthrough();
const RecordSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), baseline: z.string() })),
  trials: z.array(z.object({ result: z.string() })),
});

function suite({ timeout = '10m', setup }: { timeout?: string; setup?: string } = {}): string {
  return `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 1
timeout: ${timeout}
${setup ? `setup:\n  command: ${setup}\n` : ''}`;
}

function task(run: string, protect: string[]): string {
  return `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make the check pass.
startingCommit: '{{startingCommit}}'
check:
  run: ${run}
  protect: [${protect.join(', ')}]
`;
}

/** A check that reads a config and every .setup.js helper under test/, both protected: it fails until answer.js exports 42. */
const GAMEABLE = {
  app: {
    'check.config.js': 'module.exports = { skip: false };\n',
    'test/answer.test.js': [
      "const assert = require('node:assert');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "for (const file of fs.readdirSync(__dirname, { recursive: true }).filter((name) => name.endsWith('.setup.js'))) require(path.join(__dirname, file));",
      "if (!require('../check.config.js').skip) assert.strictEqual(require('../answer.js'), 42);",
      '',
    ].join('\n'),
  },
  tasks: { fix: task('node test/answer.test.js', ['check.config.js', "'test/**'"]) },
};

const OTHER_CASE = "require('node:assert').ok(true);\n";

const HashedRecordSchema = z.object({
  tasks: z.array(z.object({ sourceHash: z.string() })),
  trials: z.array(z.object({ result: z.string() })),
});

/** A check the agent never sees: check.add writes it from the suite directory, where the issue's example keeps it. */
const REFRESH_FROM = 'benchmarks/fix/check-files/expired-token/refresh.test.js';
const REFRESH_TO = 'test/auth/refresh.test.js';
const REFRESH_TEST = "#!/usr/bin/env node\nrequire('node:assert').strictEqual(require('../../answer.js'), 42);\n";
const HIDDEN_TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make the check pass.
startingCommit: '{{startingCommit}}'
check:
  run: ${REFRESH_TO}
  protect: ['test/**']
  add:
    - from: check-files/expired-token/refresh.test.js
      to: ${REFRESH_TO}
`;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function ran(options: Omit<BenchmarkFixtureOptions, 'sandbox'>) {
  const fixture = await benchmarkFixture({ ...options, sandbox: true, tools: ['claude'] });
  fixtures.push(fixture);
  const before = fixture.status();
  const started = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(started).data?.done);
  if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
  return { fixture, before, done: done.data, record: RecordSchema.parse(fixture.benchmarkRecord(done.data.run)) };
}

describe('benchmark checks on the local driver', () => {
  it.each([
    ['fixes answer.js', 'fixes', 'passed'],
    ['sets skip in the protected config', 'skips-the-check', 'failed'],
    ['adds a helper under the protected test directory', 'adds-a-helper', 'failed'],
    ['adds a helper in a git repository of its own under the protected test directory', 'adds-a-helper-repository', 'failed'],
  ] as const)('checks a trial that %s against the protected paths of the starting commit', async (_, tool, result) => {
    const { fixture, before, done, record } = await ran({ tool, ...GAMEABLE });

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(record).toEqual({ tasks: [expect.objectContaining({ id: 'fix', baseline: 'valid' })], trials: [expect.objectContaining({ result })] });
    expect(fixture.toolLaunches()).toHaveLength(1);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  // The check passes without the fix's version of test/answer.test.js, so a valid baseline shows the baseline wrote it,
  // and a failed trial that its check did, after the restore put back the starting commit's.
  it.each([
    ['fixes answer.js', 'a test the fix brought', 'fixes', 'passed'],
    ['changes nothing', 'a test the fix brought', 'does-nothing', 'failed'],
    ['changes nothing', 'the case the fix added to an existing test', 'does-nothing', 'failed'],
  ] as const)('checks a trial that %s with %s, which check.add writes from the fix', async (_, test, tool, result) => {
    const existing = test !== 'a test the fix brought';
    const app = { 'test/other.test.js': OTHER_CASE, ...(existing ? { 'test/answer.test.js': OTHER_CASE } : {}) };
    const fixture = await benchmarkFixture({ tool, sandbox: true, tools: ['claude'], app });
    fixtures.push(fixture);
    const fix = fixture.pushProduct({ 'answer.js': 'module.exports = 42;\n', 'test/answer.test.js': `${existing ? OTHER_CASE : ''}require('node:assert').strictEqual(require('../answer.js'), 42);\n` });
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make the check pass.
startingCommit: ${fixture.startingCommit}
check:
  run: 'for f in test/*.test.js; do node "$f" || exit 1; done'
  protect: [test]
  add: [test/answer.test.js]
source: { platform: claude-code, sessionId: s1, fix: ${fix} }
` });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    const done = DoneSchema.parse(envelope(started).data?.done);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run))).toEqual({ tasks: [expect.objectContaining({ id: 'fix', baseline: 'valid' })], trials: [expect.objectContaining({ result })] });
    expect(fixture.toolLaunches().map((launch) => launch.paths)).toEqual([expect.arrayContaining(['test/other.test.js'])]);
    if (!existing) expect(fixture.toolLaunches()[0]?.paths).not.toContain('test/answer.test.js');
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  // The suite's refresh.test.js fails at the starting commit, so a valid baseline shows the baseline wrote it. It runs as
  // an executable, so it keeps the mode it has in the team repo.
  it.each([
    ['fixes answer.js', 'fixes', 'passed'],
    ['writes its own passing test where the check reads it', 'writes-a-passing-test', 'failed'],
  ] as const)('checks a trial that %s with a test from the suite directory, which its clone never has', async (_, tool, result) => {
    const { fixture, done, record } = await ran({ tool, tasks: { fix: HIDDEN_TASK }, team: { [REFRESH_FROM]: REFRESH_TEST }, executable: [REFRESH_FROM] });

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(record).toEqual({ tasks: [expect.objectContaining({ id: 'fix', baseline: 'valid' })], trials: [expect.objectContaining({ result })] });
    expect(fixture.toolLaunches()).toEqual([expect.objectContaining({ paths: expect.not.arrayContaining([REFRESH_TO]) })]);
    expect(fixture.toolLaunches()[0]?.paths).toContain('answer.js');
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  // Neither test is in the starting commit, and the check needs both, so a passed trial shows check.add wrote each.
  it('checks a trial with a test the fix brought and a test from the suite directory, in one check.add', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], app: { 'test/other.test.js': OTHER_CASE }, team: { [REFRESH_FROM]: REFRESH_TEST }, executable: [REFRESH_FROM] });
    fixtures.push(fixture);
    const fix = fixture.pushProduct({ 'answer.js': 'module.exports = 42;\n', 'test/answer.test.js': "require('node:assert').strictEqual(require('../answer.js'), 42);\n" });
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make the check pass.
startingCommit: ${fixture.startingCommit}
check:
  run: 'node test/answer.test.js && ${REFRESH_TO}'
  protect: [test]
  add:
    - test/answer.test.js
    - from: check-files/expired-token/refresh.test.js
      to: ${REFRESH_TO}
source: { platform: claude-code, sessionId: s1, fix: ${fix} }
` });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    const done = DoneSchema.parse(envelope(started).data?.done);
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run))).toEqual({ tasks: [expect.objectContaining({ id: 'fix', baseline: 'valid' })], trials: [expect.objectContaining({ result: 'passed' })] });
    expect(fixture.toolLaunches()).toHaveLength(1);
    expect(fixture.toolLaunches()[0]?.paths).not.toContain('test/answer.test.js');
    expect(fixture.toolLaunches()[0]?.paths).not.toContain(REFRESH_TO);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('checks with the suite file as the run started, and a later run with its edit, under another sourceHash', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: HIDDEN_TASK }, team: { [REFRESH_FROM]: REFRESH_TEST }, executable: [REFRESH_FROM],
      firstLaunch: 'pulls-a-team-change', teamChange: { [REFRESH_FROM]: REFRESH_TEST.replace('42', '43') },
    });
    fixtures.push(fixture);
    const run = async () => {
      const started = await fixture.teamai(['benchmark', 'run', 'fix']);
      const done = DoneSchema.safeParse(envelope(started).data?.done);
      if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
      return HashedRecordSchema.parse(fixture.benchmarkRecord(done.data.run));
    };

    const before = await run();
    const after = await run();

    expect(before.trials).toEqual([expect.objectContaining({ result: 'passed' })]);
    expect(after.trials).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(after.tasks[0]?.sourceHash).not.toBe(before.tasks[0]?.sourceHash);
  }, 180_000);

  it('reports a task whose check passes on its starting commit invalid, and runs none of its trials', async () => {
    const { fixture, done, record } = await ran({ tool: 'fixes', app: { 'answer.js': 'module.exports = 42;\n' } });

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(done.outputs.text).toContain('| Task | Baseline |\n| --- | --- |\n| fix | invalid: check passes without changes |');
    expect(record).toEqual({ tasks: [expect.objectContaining({ baseline: 'invalid' })], trials: [expect.objectContaining({ result: 'not_run' })] });
    expect(fixture.toolLaunches()).toEqual([]);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it.each<[string, Omit<BenchmarkFixtureOptions, 'sandbox' | 'tool'>]>([
    ['whose setup fails', { suite: suite({ setup: 'exit 3' }) }],
    ['whose check is not found', { tasks: { fix: task('no-such-check', ['test.js']) } }],
    ['whose check is killed', { app: { 'kill.js': "process.kill(process.pid, 'SIGKILL');\n" }, tasks: { fix: task('node kill.js', ['kill.js']) } }],
    ['whose check is killed under a shell that reports it as exit 137', { app: { 'kill.js': "process.kill(process.pid, 'SIGKILL');\n" }, tasks: { fix: task('node kill.js; exit $?', ['kill.js']) } }],
    ['whose check runs past the run timeout', { suite: suite({ timeout: '15s' }), app: { 'hang.js': 'setInterval(() => {}, 1000);\n' }, tasks: { fix: task('node hang.js', ['hang.js']) } }],
  ])('reports that the check could not run for a baseline %s, and runs none of its trials', async (_, options) => {
    const { fixture, done, record } = await ran({ tool: 'fixes', ...options });

    expect(done.outputs.text).toContain('| fix | check could not run |');
    expect(record).toEqual({ tasks: [expect.objectContaining({ baseline: 'could_not_run' })], trials: [expect.objectContaining({ result: 'not_run' })] });
    expect(fixture.toolLaunches()).toEqual([]);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('gives error, not failed, to a trial whose check is killed under a shell after its prompt succeeded', async () => {
    const killed = "if (require('./answer.js') === 42) process.kill(process.pid, 'SIGKILL'); else process.exit(1);\n";

    const { fixture, done, record } = await ran({ tool: 'fixes', app: { 'killed-check.js': killed }, tasks: { fix: task('node killed-check.js; exit $?', ['killed-check.js']) } });

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(record).toEqual({ tasks: [expect.objectContaining({ baseline: 'valid' })], trials: [expect.objectContaining({ result: 'error' })] });
    expect(fixture.toolLaunches()).toHaveLength(1);
  }, 120_000);

  it('gives error, not failed, to a trial whose check runs past the run timeout after its prompt succeeded', async () => {
    const slow = "if (require('./answer.js') === 42) setInterval(() => {}, 1000); else process.exit(1);\n";

    const { fixture, done, record } = await ran({ tool: 'fixes', suite: suite({ timeout: '20s' }), app: { 'slow-check.js': slow }, tasks: { fix: task('node slow-check.js', ['slow-check.js']) } });

    expect(done).toMatchObject({ outcome: 'failed' });
    expect(record).toEqual({ tasks: [expect.objectContaining({ baseline: 'valid' })], trials: [expect.objectContaining({ result: 'error' })] });
    expect(fixture.toolLaunches()).toHaveLength(1);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);
});

describe('teamai benchmark check', () => {
  /** `teamai benchmark check <args>` in `cwd`, the member's checkout by default, as the step of attempt `marker` would run it. */
  function check(fixture: BenchmarkFixture, args: string[], marker?: string, cwd = fixture.work) {
    const env = { ...fixture.env, ...(marker !== undefined ? { TEAMAI_WORKFLOW_ATTEMPT: marker } : {}) };
    return spawnSync(path.join(fixture.bin, 'teamai'), ['benchmark', 'check', ...args], { cwd, env, encoding: 'utf8' });
  }

  /** A driver of another machine that provides the clones and sandbox a benchmark's steps require. */
  const driver = { kind: 'external', machine: 'ci', workspace: '/work' };
  const can = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'] };
  const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string(), command: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string() }).passthrough();
  const NextSchema = z.object({ data: z.object({ lease: LeaseSchema }).passthrough() });
  const StoredPlanSchema = z.object({
    admitted: z.object({ plan: z.object({ output: z.object({ plan: z.object({ schemaVersion: z.number() }).passthrough() }).passthrough() }).passthrough() }).passthrough(),
  }).passthrough();

  /** Runs and reports the plan step of benchmark run `run` as `driver`, and answers the lease `next --prepare` gives next. */
  async function leaseAfterPlan(fixture: BenchmarkFixture, run: string): Promise<z.infer<typeof LeaseSchema>> {
    const next = async () => NextSchema.parse(envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...driver, can }, running: [] })]))).data.lease;
    const plan = await next();
    if (plan.step !== 'plan' || plan.command === undefined) throw new Error(`leased ${plan.step} before the plan`);
    const planned = spawnSync('/bin/sh', ['-c', plan.command], { cwd: plan.cwd, env: { ...fixture.env, ...plan.env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${plan.attempt}` }, encoding: 'utf8' });
    const outputs: unknown = JSON.parse(planned.stdout);
    const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({ attempt: plan.attempt, revision: plan.revision, driver, outcome: 'success', outputs })]);
    if (reported.code !== 0) throw new Error(`the plan step was not reported: ${said(reported)}`);
    return next();
  }

  it('refuses to run as no step of a run', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);

    const checked = check(fixture, ['--trial']);

    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toContain('TEAMAI_WORKFLOW_ATTEMPT is not set to <run>/<attempt>');
  }, 60_000);

  it('refuses a run whose plan has a schemaVersion this teamai does not know', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const run = envelope(await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m'])).data?.run;
    if (typeof run !== 'string') throw new Error('the run did not start');
    const baseline = await leaseAfterPlan(fixture, run);
    const projects = path.join(fixture.home, '.teamai', 'projects');
    const file = fs.readdirSync(projects).map((name) => path.join(projects, name, 'workflows', 'runs', `${run}.json`)).find((at) => fs.existsSync(at));
    if (file === undefined) throw new Error(`no run file of ${run}`);
    const stored = StoredPlanSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const { plan } = stored.admitted;
    fs.writeFileSync(file, JSON.stringify({ ...stored, admitted: { ...stored.admitted, plan: { ...plan, output: { ...plan.output, plan: { ...plan.output.plan, schemaVersion: 2 } } } } }));

    const checked = check(fixture, ['--baseline'], `${run}/${baseline.attempt}`, baseline.cwd);

    expect(baseline.step).toBe('trials.baselines.fix');
    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toContain(`run_unreadable: Step "plan" of run ${run} printed a benchmark plan of schemaVersion 2, and this teamai reads only schemaVersion 1.`);
  }, 60_000);
});
