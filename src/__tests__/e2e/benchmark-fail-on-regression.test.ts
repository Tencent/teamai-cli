/**
 * Real CLI: `teamai benchmark run --fail-on-regression` compares the run's record with the newest earlier succeeded
 * record of the same suite, tasks and arms published on teamai-reports, and exits 1 when an arm's paired pass rate
 * dropped by more than chance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchmarkFixture, fixTask, FIX_SUITE, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

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

describe('benchmark run --fail-on-regression', () => {
  it('passes with a notice when no earlier run compares, then exits 1 when every trial that passed before fails', async () => {
    const fixture = await fixtureOfThree();

    const first = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);
    expect(first.code, said(first)).toBe(0);
    expect(first.stderr).toContain('No earlier succeeded run of suite fix ran the same tasks on the same arms on teamai-reports: recording is off, or nothing comparable has been published yet.');

    stopFixing(fixture);
    const second = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);

    expect(second.code, said(second)).toBe(1);
    expect(second.stderr).toMatch(/Arm "claude" passed 0\/3 paired trials, against 3\/3 in run [\w-]+: a drop of 100 points, with a 95% interval of -100 to -\d+ points\./);
  }, 240_000);

  it('passes without comparing once the earlier run measured another version of a task', async () => {
    const fixture = await fixtureOfThree();
    const first = await fixture.teamai(['benchmark', 'run', 'fix']);
    expect(first.code, said(first)).toBe(0);
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': fixTask(fixture.startingCommit, 'Make node test.js pass, please.') });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    stopFixing(fixture);
    const second = await fixture.teamai(['benchmark', 'run', 'fix', '--fail-on-regression']);

    expect(second.code, said(second)).toBe(0);
    expect(second.stderr).toContain('No earlier succeeded run of suite fix ran the same tasks on the same arms on teamai-reports');
  }, 240_000);

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
