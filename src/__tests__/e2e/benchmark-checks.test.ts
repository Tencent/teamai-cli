/**
 * Real CLI on the local driver: teamai tries each task's check on its starting commit before any trial, and checks a
 * trial against the protected paths as the starting commit has them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture, type BenchmarkFixtureOptions } from '../helpers/benchmark-fixture.js';

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }) }).passthrough();
const RecordSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), baseline: z.string() })),
  trials: z.array(z.object({ result: z.string() })),
});

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
  ] as const)('checks a trial that %s against the protected paths of the starting commit', async (_, tool, result) => {
    const { fixture, before, done, record } = await ran({ tool, ...GAMEABLE });

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(record).toEqual({ tasks: [expect.objectContaining({ id: 'fix', baseline: 'valid' })], trials: [expect.objectContaining({ result })] });
    expect(fixture.toolLaunches()).toHaveLength(1);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  // Neither test is in the starting commit, and the check needs both, so a passed trial shows check.add wrote each.
  it('checks a trial with a test the solution brought and a test from the suite directory, in one check.add', async () => {
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
solutionCommit: ${fix}
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

  it('checks with the suite file as the run started, though the member pulls its edit during the run', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: HIDDEN_TASK }, team: { [REFRESH_FROM]: REFRESH_TEST }, executable: [REFRESH_FROM],
      firstLaunch: 'pulls-a-team-change', teamChange: { [REFRESH_FROM]: REFRESH_TEST.replace('42', '43') },
    });
    fixtures.push(fixture);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    const done = DoneSchema.safeParse(envelope(started).data?.done);
    if (!done.success) throw new Error(`the run did not end: ${said(started)}`);
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.data.run)).trials).toEqual([expect.objectContaining({ result: 'passed' })]);
    expect(fs.readFileSync(path.join(fixture.teamClone, REFRESH_FROM), 'utf8')).toBe(REFRESH_TEST.replace('42', '43'));
  }, 120_000);

  it('reports that the check could not run for a baseline whose check is killed under a shell that reports it as exit 137, and runs none of its trials', async () => {
    const { fixture, done, record } = await ran({ tool: 'fixes', app: { 'kill.js': "process.kill(process.pid, 'SIGKILL');\n" }, tasks: { fix: task('node kill.js; exit $?', ['kill.js']) } });

    expect(done.outputs.text).toContain('| fix | check could not run |');
    expect(record).toEqual({ tasks: [expect.objectContaining({ baseline: 'could_not_run' })], trials: [expect.objectContaining({ result: 'not_run' })] });
    expect(fixture.toolLaunches()).toEqual([]);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);
});

describe('teamai benchmark check', () => {
  /** `teamai benchmark check <args>` in `cwd`, the member's checkout by default, as the step of attempt `marker` would run it. */
  function check(fixture: BenchmarkFixture, args: string[], marker?: string, cwd = fixture.work) {
    const env = { ...fixture.env, ...(marker !== undefined ? { TEAMAI_WORKFLOW_ATTEMPT: marker } : {}) };
    return spawnSync(path.join(fixture.bin, 'teamai'), ['benchmark', 'check', ...args], { cwd, env, encoding: 'utf8' });
  }

  it('refuses to run as no step of a run', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);

    const checked = check(fixture, ['--trial']);

    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toContain('TEAMAI_WORKFLOW_ATTEMPT is not set to <run>/<attempt>');
  }, 60_000);
});
