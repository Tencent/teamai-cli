/**
 * Real CLI: the limits a suite's `trial` sets on every trial's prompt, enforced by the local driver in a declared
 * sandbox, and the reports that carry them. A limit ends the agent's turn, and the trial's check still decides it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, FIX_SUITE, said, type BenchmarkFixture, type FakeTool } from '../helpers/benchmark-fixture.js';

const DoneSchema = z.object({ run: z.string(), outcome: z.string() }).passthrough();
const TrialSchema = z.object({ order: z.number(), result: z.string(), limit: z.string().optional(), unenforced: z.array(z.string()).optional() }).passthrough();
const RecordSchema = z.object({ limits: z.record(z.string(), z.number()).optional(), trials: z.array(TrialSchema) }).passthrough();
const StepsSchema = z.object({ steps: z.array(z.object({ id: z.string(), end: z.string().optional() }).passthrough()) }).passthrough();

const fixtures: BenchmarkFixture[] = [];

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** The one-task fix suite, run `repetitions` times under the suite's `trial` value. */
function limitedSuite(trial: string, repetitions = 1): string {
  return FIX_SUITE.replace('repetitions: 1\n', `repetitions: ${repetitions}\ntrial: ${trial}\n`);
}

/** The end the trials of `run` reached: `settled` once every trial settled, whatever its result. */
function trialsEnd(fixture: BenchmarkFixture, run: string): string | undefined {
  return StepsSchema.parse(fixture.runFile(run)).steps.find((step) => step.id === 'trials')?.end;
}

async function runLocally(tool: FakeTool, suite: string): Promise<{ fixture: BenchmarkFixture; done: z.infer<typeof DoneSchema>; record: z.infer<typeof RecordSchema>; stderr: string }> {
  const fixture = await benchmarkFixture({ tool, sandbox: true, suite });
  fixtures.push(fixture);
  const started = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(started).data?.done);
  if (!done.success) throw new Error(said(started));
  return { fixture, done: done.data, record: RecordSchema.parse(fixture.benchmarkRecord(done.data.run)), stderr: started.stderr };
}

describe('trial limits on the local driver', () => {
  it('stops a tool that hangs at its trial timeout, checks what it left, and runs the next trial', async () => {
    const { fixture, done, record, stderr } = await runLocally('hangs', limitedSuite('{ timeout: 3s }', 2));

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.limits).toEqual({ timeoutMs: 3000 });
    expect(record.trials).toEqual([
      expect.objectContaining({ order: 1, result: 'failed', limit: 'timeout' }),
      expect.objectContaining({ order: 2, result: 'failed', limit: 'timeout' }),
    ]);
    expect(stderr).toContain('| claude | claude | tool default (team) | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0% (0/2) |');
    expect(fixture.toolLaunches()).toHaveLength(2);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('stops a tool that wrote the fix and hangs holding git\'s index, HEAD and branch locks, and its check passes what it left', async () => {
    const { fixture, done, record } = await runLocally('fixes-and-hangs', limitedSuite('{ timeout: 3s }'));

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.trials).toEqual([expect.objectContaining({ result: 'passed', limit: 'timeout' })]);
  }, 120_000);

  it('records a trial a limit stopped as an error, without its limit, when its work cannot be committed, and settles the run', async () => {
    const { fixture, done, record } = await runLocally('corrupts-git-and-hangs', limitedSuite('{ timeout: 3s }'));

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(record.trials[0]).not.toHaveProperty('limit');
  }, 120_000);

  it('caps the turns of a claude trial, and lists max_turns as unenforced on a codex trial', async () => {
    const suite = limitedSuite('{ max_turns: 3 }').replace('  - name: claude\n', '  - name: claude\n  - name: codex\n    tool: codex\n');
    const { fixture, done, record, stderr } = await runLocally('fixes-and-runs-out-of-turns', suite);

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.trials).toEqual([
      expect.objectContaining({ arm: 'claude', result: 'passed', limit: 'max_turns' }),
      expect.objectContaining({ arm: 'codex', result: 'passed', unenforced: ['max_turns'] }),
    ]);
    expect(record.trials[0]).not.toHaveProperty('unenforced');
    expect(record.trials[1]).not.toHaveProperty('limit');
    expect(stderr).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 100% (1/1) |');
    expect(stderr).toContain('| codex | codex | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 100% (1/1) |');
  }, 120_000);

  it('stops a claude trial whose stdout passes its budget, and marks the budget unenforced on a codex trial that passed it', async () => {
    const suite = limitedSuite('{ budget: { tokens: 100 } }').replace('  - name: claude\n', '  - name: claude\n  - name: codex\n    tool: codex\n');
    const { fixture, done, record } = await runLocally('fixes-and-spends', suite);

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.trials).toEqual([
      expect.objectContaining({ arm: 'claude', result: 'passed', limit: 'budget', tokens: { input: 80, output: 60, complete: true } }),
      expect.objectContaining({ arm: 'codex', result: 'passed', limit: 'budget', unenforced: ['budget'] }),
    ]);
    expect(record.trials[0]).not.toHaveProperty('unenforced');
  }, 120_000);

  it('stops a codex trial at its timeout under a budget it cannot be held to, and lets the check decide it', async () => {
    const suite = limitedSuite('{ timeout: 3s, budget: { tokens: 100000 } }').replace('  - name: claude\n', '  - name: codex\n    tool: codex\n');
    const { fixture, done, record, stderr } = await runLocally('hangs', suite);

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(trialsEnd(fixture, done.run)).toBe('settled');
    expect(record.trials).toEqual([expect.objectContaining({ arm: 'codex', result: 'failed', limit: 'timeout', unenforced: ['budget'] })]);
    expect(stderr).toContain('| codex | codex | tool default (team) | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 1 | 0 | 0% (0/1) |');
  }, 120_000);

  it('stops the git that commits a trial\'s work, and the filter it started, at the run timeout when that filter never returns', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes-behind-a-hanging-filter', sandbox: true, suite: FIX_SUITE.replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(started).data?.done);

    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run)).trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.filterPids()).not.toEqual([]);
    expect(fixture.filterPids().filter(alive)).toEqual([]);
  }, 120_000);

  it('stops the git that puts a protected path back for the check, and the filter it started, at the run timeout when that filter never returns', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes-behind-a-hanging-smudge', sandbox: true, suite: FIX_SUITE.replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(started).data?.done);

    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(RecordSchema.parse(fixture.benchmarkRecord(done.run)).trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.filterPids()).not.toEqual([]);
    expect(fixture.filterPids().filter(alive)).toEqual([]);
  }, 120_000);

  it('stops the git that checks out a trial\'s clone, and the filter it started, at the run timeout when that filter never returns', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, suite: FIX_SUITE.replace('timeout: 10m', 'timeout: 20s'), app: { '.gitattributes': '* filter=hang\n' } });
    fixtures.push(fixture);
    // Configured for the member's git once the fixture is made, so only the clones the run makes check out through it.
    const pids = path.join(fixture.root, 'filter-pids.log');
    fs.appendFileSync(path.join(fixture.home, '.gitconfig'), `[filter "hang"]\n\tsmudge = "echo $$ >> '${pids}'; exec sleep 600"\n`);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(started).data?.done);

    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.filterPids()).not.toEqual([]);
    expect(fixture.filterPids().filter(alive)).toEqual([]);
  }, 120_000);

  it('ends the run at its timeout when that comes before the trial timeout, with no limit on the trial', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: true, suite: limitedSuite('{ timeout: 19900ms }').replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(started.code, said(started)).toBe(1);
    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(record.trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(record.trials[0]).not.toHaveProperty('limit');
  }, 120_000);
});

/** A driver of another machine: it declares what a benchmark's steps require, and asks for prepared places. */
const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/work' };
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], end_turn: true, unattended: true };
const LeaseSchema = z.object({ attempt: z.string(), revision: z.number(), step: z.string(), command: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string(), limits: z.record(z.string(), z.unknown()).optional() }).passthrough();
const NextSchema = z.object({ data: z.object({ lease: LeaseSchema.optional() }).passthrough() });

/**
 * Drives run `run` of the benchmark workflow as an external driver: it runs each command it is leased in the place
 * `next --prepare` made, under the lease's attempt, and reports what it printed, until the first prompt lease, which
 * it returns unreported.
 */
async function leaseFirstPrompt(fixture: BenchmarkFixture, run: string): Promise<z.infer<typeof LeaseSchema>> {
  for (let polls = 0; polls < 10; polls += 1) {
    const next = await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]);
    const lease = NextSchema.parse(envelope(next)).data.lease;
    if (lease === undefined) throw new Error(`no lease: ${said(next)}`);
    if (lease.command === undefined) return lease;
    const ran = spawnSync('/bin/sh', ['-c', lease.command], { cwd: lease.cwd, env: { ...fixture.env, ...lease.env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}` }, encoding: 'utf8' });
    const outputs: unknown = JSON.parse(ran.stdout);
    const reported = await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({ attempt: lease.attempt, revision: lease.revision, driver: EXTERNAL, outcome: ran.status === 0 ? 'success' : 'failed', outputs })]);
    if (reported.code !== 0) throw new Error(`report of ${lease.step}: ${said(reported)}`);
  }
  throw new Error(`run ${run} leased no prompt`);
}

describe('trial limit reports', () => {
  it('refuses a report whose limit is none of the trial limits', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, suite: limitedSuite('{ timeout: 3s }') });
    fixtures.push(fixture);
    const started = envelope(await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']));
    const run = String(started.data?.run);
    const lease = await leaseFirstPrompt(fixture, run);
    const report = (limit: string) => ['workflow', 'report', run, '--json', JSON.stringify({
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: EXTERNAL, durationMs: 3000, limit,
    })];

    const unknown = envelope(await fixture.teamai(report('turns')));
    const unset = envelope(await fixture.teamai(report('max_turns')));

    expect(lease).toMatchObject({ step: 'trials.r1.fix.claude.prompt', limits: { timeoutMs: 3000 } });
    expect(unknown.error).toEqual({ code: 'invalid_report', message: 'limit must be the lease limit that ended the turn: timeout, budget or max_turns' });
    expect(unset.error).toEqual({
      code: 'invalid_report',
      message: `Attempt ${lease.attempt} of step "trials.r1.fix.claude.prompt": limit max_turns is not one of the lease's limits; send limit only for a limit in the lease's limits that ended the turn`,
    });
  }, 120_000);
});
