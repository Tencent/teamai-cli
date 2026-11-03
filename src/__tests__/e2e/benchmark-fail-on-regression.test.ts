/**
 * Real CLI: with input fail_on_regression, which `teamai benchmark run --fail-on-regression` sets, the report of
 * `teamai-benchmark` compares the run's record with the newest earlier succeeded record of the same suite, tasks and arms
 * published on teamai-reports, and its `regression` finally step fails when an arm's paired pass rate dropped by more
 * than chance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, FIX_SUITE, said, type BenchmarkFixture, type CliResult } from '../helpers/benchmark-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const THREE = FIX_SUITE.replace('repetitions: 1', 'repetitions: 3');

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function fixtureOfThree(): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], suite: THREE });
  fixtures.push(fixture);
  return fixture;
}

/** From now on the fake claude changes nothing, so every trial's check fails. */
function stopFixing(fixture: BenchmarkFixture): void {
  fs.writeFileSync(path.join(fixture.bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), finally: z.array(z.object({ id: z.string() }).passthrough()).optional() }).passthrough();
const StepsSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string(), outputs: z.unknown().optional() }).passthrough()) }).passthrough();

function doneOf(result: CliResult): z.infer<typeof DoneSchema> {
  return DoneSchema.parse(envelope(result).data?.done);
}

/** The status of each finally step of `run`, and what its report said of a regression. */
function gateOf(fixture: BenchmarkFixture, run: string): { regression: string | undefined; report: unknown } {
  const { steps } = StepsSchema.parse(fixture.runFile(run));

  return { regression: steps.find(({ id }) => id === 'regression')?.status, report: z.object({ regression: z.string() }).safeParse(steps.find(({ id }) => id === 'report')?.outputs).data?.regression };
}

describe('benchmark run --fail-on-regression', () => {
  it('passes with a notice when no earlier run compares, then exits 1 on the regression step when every trial that passed before fails', async () => {
    const fixture = await fixtureOfThree();

    const first = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);
    expect(first.code, said(first)).toBe(0);
    expect(first.stderr).toContain('No earlier succeeded run of suite fix ran the same tasks on the same arms on teamai-reports: recording is off, or nothing comparable has been published yet.');
    expect(doneOf(first).finally).toBeUndefined();
    expect(gateOf(fixture, doneOf(first).run)).toEqual({ regression: 'skipped', report: 'no_comparable' });

    stopFixing(fixture);
    const second = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);

    expect(second.code, said(second)).toBe(1);
    expect(second.stderr).toMatch(/Arm "claude" passed 0\/3 paired trials, against 3\/3 in run [\w-]+: a drop of 100 points, with a 95% interval of -100 to -\d+ points\./);
    expect(doneOf(second)).toMatchObject({ outcome: 'succeeded', finally: [{ id: 'regression', outcome: 'failed' }] });
    expect(gateOf(fixture, doneOf(second).run)).toEqual({ regression: 'failed', report: 'dropped' });
  }, 240_000);

  it('does not compare without the flag: the report says off and the gate is skipped', async () => {
    const fixture = await fixtureOfThree();
    const first = await fixture.teamai(['benchmark', 'run', 'fix']);
    expect(first.code, said(first)).toBe(0);

    stopFixing(fixture);
    const second = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(second.code, said(second)).toBe(0);
    expect(second.stderr).not.toContain('paired trials');
    expect(gateOf(fixture, doneOf(second).run)).toEqual({ regression: 'skipped', report: 'off' });
  }, 240_000);

  it('starts with --driver skill from a team file that allows it, once the start answers its describe, and the run a local driver resumes fails the gate on a drop', async () => {
    const fixture = await fixtureOfThree();
    const shipped = fs.readFileSync(path.join(ROOT, 'workflows', 'teamai-benchmark.yaml'), 'utf8');
    fixture.pushTeam({ 'workflows/teamai-benchmark.yaml': shipped.replace('invoke: deny', 'invoke: allow') });
    const pulled = await fixture.teamai(['pull']);
    const first = await fixture.teamai(['benchmark', 'run', 'fix']);
    expect(pulled.code, said(pulled)).toBe(0);
    expect(first.code, said(first)).toBe(0);
    stopFixing(fixture);

    const asked = await fixture.teamai(['benchmark', 'run', 'fix', '--driver', 'skill', '--fail-on-regression']);
    expect(envelope(asked).error).toMatchObject({ code: 'confirm_needed', next: 'teamai workflow start --describe teamai-benchmark --driver skill' });
    const inputs = JSON.stringify({ suite: 'fix', aliases: 'team', tasks: [], arms: [], fail_on_regression: true });
    const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--driver', 'skill', '--confirmed', '--parallel', '1', '--tools', 'default=claude', '--no-judge', '--timeout', '10m', '--inputs', inputs]);
    expect(started.code, said(started)).toBe(0);
    const run = z.object({ run: z.string() }).parse(envelope(started).data?.turn, { error: () => said(started) }).run;
    // teamai-score's judge step is a prompt step, so the run asks the host question before it drives anything.
    const chose = await fixture.teamai(['workflow', 'next', run, '--driver', 'skill', '--choice', 'h1']);
    expect(chose.code, said(chose)).toBe(0);
    const waited = await fixture.teamai(['workflow', 'next', run, '--driver', 'skill', '--wait']);
    const resumed = await fixture.teamai(['workflow', 'resume', run, '--driver', 'local', '--sandbox']);

    expect(envelope(waited).data?.turn).toMatchObject({ waiting: { held: [{ step: 'trials.baselines.fix', missing: ['workspace.clone'] }] } });
    expect(doneOf(resumed)).toMatchObject({ run, outcome: 'succeeded', finally: [{ id: 'regression', outcome: 'failed' }] });
    expect(gateOf(fixture, run)).toEqual({ regression: 'failed', report: 'dropped' });
  }, 240_000);

  it('is refused with --driver skill as the shipped workflow refuses any agent start, before any run starts', async () => {
    const fixture = await fixtureOfThree();

    const started = await fixture.teamai(['benchmark', 'run', 'fix', '--driver', 'skill', '--fail-on-regression']);

    expect(started.code, said(started)).toBe(1);
    expect(envelope(started).error).toMatchObject({ code: 'invoke_denied' });
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('compares with no record still pending publication, and its own pending record leaves the exit code alone', async () => {
    const fixture = await fixtureOfThree();
    const hook = path.join(fixture.teamOrigin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/teamai-reports ] && exit 1; done\nexit 0\n', { mode: 0o755 });
    const first = await fixture.teamai(['benchmark', 'run', 'fix']);
    expect(first.code, said(first)).toBe(0);

    stopFixing(fixture);
    const second = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);

    expect(second.code, said(second)).toBe(0);
    expect(second.stderr).toContain('record: pending');
    expect(second.stderr).toContain('No earlier succeeded run of suite fix ran the same tasks on the same arms on teamai-reports');
  }, 240_000);

  it('passes, saying so, when the run held up against the earlier one', async () => {
    const fixture = await fixtureOfThree();
    const first = await fixture.teamai(['benchmark', 'run', 'fix']);
    expect(first.code, said(first)).toBe(0);

    const second = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);

    expect(second.code, said(second)).toBe(0);
    expect(second.stderr).toMatch(/No arm's pass rate dropped by more than chance against run [\w-]+\./);
  }, 240_000);
});
