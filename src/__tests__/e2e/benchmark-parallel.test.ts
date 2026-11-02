/**
 * Real CLI: a suite's `parallel` is the number of lanes its trials run in. The local driver runs as many at once as the
 * smaller of that and `workflows.max_parallel` allows, so a suite that sets none runs one trial at a time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const suite = (parallel: string): string => `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 2
${parallel}timeout: 10m
`;
const RecordSchema = z.object({ trials: z.array(z.object({ result: z.string() }).passthrough()) }).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** Runs the suite on a member whose local driver runs `maxParallel` leases at once, and answers when each trial's tool started. */
async function launchTimes(parallel: string, { maxParallel }: { maxParallel?: number } = { maxParallel: 2 }): Promise<number[]> {
  const fixture = await benchmarkFixture({ tool: 'fixes-slowly', sandbox: true, tools: ['claude'], suite: suite(parallel), maxParallel });
  fixtures.push(fixture);
  const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
  expect(ran.code, said(ran)).toBe(0);
  const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
  expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials.map(({ result }) => result)).toEqual(['passed', 'passed']);
  return fixture.toolLaunches().map(({ at }) => at).sort((left, right) => left - right);
}

describe('benchmark parallel lanes', () => {
  it('runs one trial at a time when the suite sets no parallel, whatever max_parallel allows', async () => {
    const [first = 0, second = 0] = await launchTimes('');

    // Each trial's tool runs three seconds, so the second starts after the first ended.
    expect(second - first).toBeGreaterThanOrEqual(3000);
  }, 240_000);

  it('runs two trials at once with parallel: 2 and max_parallel: 2', async () => {
    const [first = 0, second = 0] = await launchTimes('parallel: 2\n');

    expect(second - first).toBeLessThan(3000);
  }, 240_000);

  it('runs one trial at a time with parallel: 2 when max_parallel is unset', async () => {
    const [first = 0, second = 0] = await launchTimes('parallel: 2\n', {});

    expect(second - first).toBeGreaterThanOrEqual(3000);
  }, 240_000);
});
