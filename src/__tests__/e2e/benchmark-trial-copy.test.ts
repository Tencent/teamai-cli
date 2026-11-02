/**
 * Real CLI, driven by hand as an external driver would: one call at a time prepares, reports, checks or sweeps a trial
 * copy, a report the engine refuses leaves the clone and its work as they were, and nothing reads a trial's evidence or
 * clone before its report finished with them. The driver runs every command lease of the benchmark workflow (its plan,
 * baselines, checks and report) itself, in the place `next --prepare` prepared, with the attempt marker every driver
 * sets. `git` on the fixture's PATH can be held at one call, so two calls overlap.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LeaseWireSchema } from '../../workflow/lease-wire.js';
import { benchmarkFixture, envelope, FIX_SUITE, startFixBenchmark, type BenchmarkFixture, type Envelope } from '../helpers/benchmark-fixture.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], unattended: true };
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
---
Judge how tidy the change is.
`;
/** A lease `next --prepare` answers, with the place it prepared for the step. */
const LeaseSchema = z.intersection(LeaseWireSchema, z.object({ cwd: z.string().min(1) }));
type Lease = z.infer<typeof LeaseSchema>;
const LeasedSchema = z.object({ data: z.object({ lease: LeaseSchema }) });
const NextSchema = z.object({ data: z.union([z.object({ lease: LeaseSchema }), z.object({ wait: z.object({}).passthrough() }), z.object({ done: z.object({}).passthrough() })]) });
const RunSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });
const RecordSchema = z.object({ trials: z.array(z.object({ result: z.string() }).passthrough()) });
const ExitedSchema = z.object({ code: z.number().nullable().optional(), stdout: z.string().optional() });
const execute = promisify(execFile);

const fixtures: BenchmarkFixture[] = [];
const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function fixtureWith(options: { suite?: string; tasks?: Record<string, string>; team?: Record<string, string> } = {}): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], ...options });
  fixtures.push(fixture);
  return fixture;
}

/** A driver of `run` that sends the CLI what an external driver sends, as `identity`. */
function byHand(fixture: BenchmarkFixture, run: string, identity = { kind: 'external', machine: 'by-hand', workspace: '/by-hand' }) {
  const next = async (): Promise<Envelope> => envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...identity, can: CAN }, running: [] })]));
  const report = (lease: Lease, changed: Record<string, unknown> = {}): Record<string, unknown> => ({
    driver: identity, tool: 'claude', attempt: lease.attempt, revision: lease.revision, outcome: 'success', ...changed,
  });
  const send = async (body: Record<string, unknown>): Promise<Envelope> => envelope(await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify(body)]));
  /** Runs a command lease where it was prepared, without the names it withholds, and reports what it printed. */
  const command = async (lease: Lease): Promise<Envelope> => {
    if (lease.command === undefined) throw new Error(`step ${lease.step} runs no command`);
    const withheld = lease.envScope?.withhold ?? [];
    const env = { ...Object.fromEntries(Object.entries(fixture.env).filter(([key]) => !withheld.includes(key))), ...lease.env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}` };
    const ran = await execute('/bin/sh', ['-c', lease.command], { cwd: lease.cwd, env }).then(({ stdout }) => ({ code: 0, stdout }), (error: unknown) => {
      const exited = ExitedSchema.parse(error);
      return { code: exited.code ?? 1, stdout: exited.stdout ?? '' };
    });
    const settled = ran.code !== 0 ? { outcome: 'failed' } : { outcome: 'success', ...(lease.output !== undefined ? { outputs: JSON.parse(ran.stdout) } : {}) };
    return send({ driver: identity, attempt: lease.attempt, revision: lease.revision, ...settled });
  };
  /** Takes and runs every command lease until `next` answers a prompt lease, or else what it answered. */
  const commandsUntil = async (wanted: 'prompt' | 'done'): Promise<Envelope> => {
    for (let polls = 0; polls < 60; polls += 1) {
      const answer = await next();
      const parsed = NextSchema.safeParse(answer);
      if (!parsed.success || 'done' in parsed.data.data) return answer;
      if ('wait' in parsed.data.data) {
        if (wanted === 'done') await new Promise((resolve) => { setTimeout(resolve, 500); });
        else return answer;
        continue;
      }
      const { lease } = parsed.data.data;
      if (lease.command === undefined) return answer;
      await command(lease);
    }
    throw new Error(`run ${run} did not reach a ${wanted}`);
  };
  return {
    identity, next, report, send, command,
    /** The trial's prompt lease, once the driver ran the plan and the baselines before it. */
    prompt: async (): Promise<Lease> => LeasedSchema.parse(await commandsUntil('prompt')).data.lease,
    /** What `next` answers once the driver ran every command lease left: the run's end, or a lease it cannot run. */
    finish: () => commandsUntil('done'),
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting until ${what}`);
}

/**
 * Makes every git call of the fixture whose arguments hold `pattern` wait until `release`, after it says it entered.
 * Every other git call runs at once.
 */
function holdGit(fixture: BenchmarkFixture, pattern: string): { entered(): number; release(): void } {
  const executable = path.join(fixture.bin, 'git');
  const real = fs.readlinkSync(executable);
  const marker = path.join(fixture.root, 'git-held');
  const released = path.join(fixture.root, 'git-released');
  fs.unlinkSync(executable);
  fs.writeFileSync(executable, `#!/bin/sh
case " $* " in
  *"${pattern}"*)
    echo entered >> '${marker}'
    while [ ! -f '${released}' ]; do sleep 0.05; done
    ;;
esac
exec '${real}' "$@"
`, { mode: 0o755 });
  const release = (): void => fs.writeFileSync(released, '');
  releases.push(release);
  return { entered: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0), release };
}

function cloneGit(lease: Lease, args: string[]): string {
  return execFileSync('git', args, { cwd: lease.cwd, encoding: 'utf8' }).trim();
}

describe('a report the engine refuses', () => {
  it.each([
    ['a stale revision', 'stale_revision', (lease: Lease) => ({ revision: lease.revision + 1 })],
    ['another driver', 'wrong_driver', () => ({ driver: { kind: 'external', machine: 'another', workspace: '/another' } })],
  ])('with %s leaves the clone and its uncommitted work as they were, so the corrected report counts it', async (_, code, refused) => {
    const fixture = await fixtureWith();
    const run = await startFixBenchmark(fixture);
    const driver = byHand(fixture, run);
    const lease = await driver.prompt();
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');

    const rejected = await driver.send(driver.report(lease, refused(lease)));

    expect(rejected).toMatchObject({ error: { code } });
    expect(fs.readFileSync(path.join(lease.cwd, 'answer.js'), 'utf8')).toBe('module.exports = 42;\n');
    expect(cloneGit(lease, ['rev-parse', 'HEAD'])).toBe(fixture.startingCommit);
    expect(cloneGit(lease, ['status', '--porcelain', '--', 'answer.js'])).toBe('M answer.js');
    const corrected = await driver.send(driver.report(lease));
    const done = await driver.finish();
    expect(corrected).toMatchObject({ data: { accepted: true } });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(RecordSchema.parse(fixture.benchmarkRecord(run)).trials).toEqual([expect.objectContaining({ result: 'passed' })]);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);
});

describe('two calls on one trial copy', () => {
  it('prepares one clone when a second next --prepare comes while the first still prepares, and answers the second driver_running', async () => {
    const fixture = await fixtureWith({ tasks: { fix: CRITERIA_TASK } });
    const run = await startFixBenchmark(fixture);
    const driver = byHand(fixture, run);
    const plan = LeasedSchema.parse(await driver.next()).data.lease;
    const planned = await driver.command(plan);
    const held = holdGit(fixture, ' --template= ');

    const first = driver.next();
    await until(() => held.entered() === 1, 'the first call makes its clone');
    let secondAnswered = false;
    const second = driver.next().then((answer) => {
      secondAnswered = true;
      return answer;
    });
    await until(() => secondAnswered || held.entered() === 2, 'the second call answers or makes a clone too');
    held.release();
    const answers = await Promise.all([first, second]);

    expect(plan.step).toBe('plan');
    expect(planned).toMatchObject({ data: { accepted: true } });
    const lease = LeasedSchema.parse(answers[0]).data.lease;
    expect(lease.step).toBe('trials.r1.fix.claude.prompt');
    expect(answers[1]).toMatchObject({ error: { code: 'driver_running' } });
    expect(fixture.trialRootEntries()).toEqual([path.basename(path.dirname(lease.cwd))]);
    await fixture.teamai(['workflow', 'cancel', run]);
    expect(await driver.finish()).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it("gives score --next nothing to judge while the trial's report still collects its evidence, so the judge reads all of it", async () => {
    const fixture = await fixtureWith({ tasks: { fix: CRITERIA_TASK } });
    const run = await startFixBenchmark(fixture);
    const driver = byHand(fixture, run);
    const lease = await driver.prompt();
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    const held = holdGit(fixture, ' --no-ext-diff --no-textconv ');
    const judge = { kind: 'external', machine: 'judge', workspace: fixture.work };
    const scoreNext = async (): Promise<Envelope> => envelope(await fixture.teamai(['score', '--next', '--json', JSON.stringify({ driver: { ...judge, can: { judge: { isolation: 'verified', tools: ['claude'] } } } })]));

    const reporting = driver.send(driver.report(lease));
    await until(() => held.entered() === 1, 'the report collects the evidence');
    const early = await scoreNext();
    held.release();
    const reported = await reporting;
    const leased = z.object({ data: z.object({ lease: z.object({ ref: z.string() }) }) }).parse(await scoreNext());
    const labelled = envelope(await fixture.teamai(['score', '--lease', leased.data.lease.ref, '--json', JSON.stringify({ driver: judge })]));
    const done = await driver.finish();

    expect(early).toEqual({ data: { idle: { open: 0, leased: 0 } } });
    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(labelled).toMatchObject({ data: { label: { label: 'correct', passed: true } } });
    expect(fixture.judgeLaunches()).toEqual([expect.objectContaining({ diff: expect.stringContaining('+module.exports = 42;') })]);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(RecordSchema.parse(fixture.benchmarkRecord(run)).trials).toEqual([expect.objectContaining({ result: 'passed' })]);
  }, 120_000);

  it('takes the report again after one was killed while it collected the evidence, and runs the check on the clone it kept', async () => {
    const fixture = await fixtureWith({ suite: `${FIX_SUITE}scorers: [quality]\n`, team: { 'scorers/quality.md': QUALITY } });
    const run = await startFixBenchmark(fixture);
    const driver = byHand(fixture, run);
    const lease = await driver.prompt();
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    const held = holdGit(fixture, ' --no-ext-diff --no-textconv ');
    const body = driver.report(lease);

    const killed = spawn(process.execPath, [CLI, 'workflow', 'report', run, '--json', JSON.stringify(body)], { cwd: fixture.work, env: fixture.env, stdio: 'ignore' });
    const closed = new Promise((resolve) => killed.once('close', resolve));
    await until(() => held.entered() === 1, 'the report collects the evidence');
    killed.kill('SIGKILL');
    await closed;
    held.release();
    const again = await driver.send(body);
    const check = LeasedSchema.parse(await driver.next()).data.lease;
    const checked = await driver.command(check);

    expect(again).toMatchObject({ data: { accepted: true } });
    expect(check).toMatchObject({ step: 'trials.r1.fix.claude.check', cwd: lease.cwd });
    expect(checked).toMatchObject({ data: { accepted: true } });
    expect(await driver.next()).toMatchObject({ data: { wait: { judging: 1 } } });
    const steps = RunSchema.parse(fixture.runFile(run)).steps;
    expect(steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded', outputs: { result: 'passed' } });
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('removes the evidence a killed report staged once the run ends without accepting that report', async () => {
    const fixture = await fixtureWith({ tasks: { fix: CRITERIA_TASK } });
    const run = await startFixBenchmark(fixture);
    const driver = byHand(fixture, run);
    const lease = await driver.prompt();
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    const partition = dataHomeOf(fixture, run);
    const subjects = path.join(partition, 'scores', 'evidence', 'subjects');
    const runLock = path.join(partition, 'workflows', 'runs', `${run}.lock`);
    fs.writeFileSync(runLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'test' }));
    releases.push(() => fs.rmSync(runLock, { force: true }));
    const staged = (): string[] => (fs.existsSync(subjects) ? fs.readdirSync(subjects).filter((name) => fs.existsSync(path.join(subjects, name, '.ready'))) : []);

    const killed = spawn(process.execPath, [CLI, 'workflow', 'report', run, '--json', JSON.stringify(driver.report(lease))], { cwd: fixture.work, env: fixture.env, stdio: 'ignore' });
    const closed = new Promise((resolve) => killed.once('close', resolve));
    await until(() => staged().length === 1, 'the report staged the evidence and waits for the run');
    killed.kill('SIGKILL');
    await closed;
    fs.rmSync(runLock);
    const leasedWhenKilled = RunSchema.parse(fixture.runFile(run)).steps.find((step) => step.id === lease.step);
    await fixture.teamai(['workflow', 'cancel', run]);
    const done = await driver.finish();

    expect(leasedWhenKilled).toMatchObject({ status: 'leased' });
    expect(done).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(fs.readdirSync(subjects)).toEqual([]);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);
});

/** The data home that holds `run`. */
function dataHomeOf(fixture: BenchmarkFixture, run: string): string {
  const projects = path.join(fixture.home, '.teamai', 'projects');
  const found = fs.readdirSync(projects).map((name) => path.join(projects, name)).find((dir) => fs.existsSync(path.join(dir, 'workflows', 'runs', `${run}.json`)));
  if (!found) throw new Error(`no data home under ${projects} holds run ${run}`);
  return found;
}
