/**
 * Real CLI: `teamai benchmark run --task --arm` and the inputs `tasks` and `arms` of `teamai-benchmark` run only the
 * chosen tasks and arms of a suite; `[]` runs all of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, fixTask, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

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

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function twoByTwo(): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, suite: TWO_ARMS,
    tasks: { fix: fixTask('{{startingCommit}}'), again: fixTask('{{startingCommit}}', 'Make node test.js pass again.') },
  });
  fixtures.push(fixture);
  return fixture;
}

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string() }).passthrough() }).passthrough();

const RecordSchema = z.object({
  tasks: z.array(z.object({ id: z.string() }).passthrough()),
  arms: z.array(z.object({ name: z.string() }).passthrough()),
  trials: z.array(z.object({ task: z.string(), arm: z.string(), result: z.string() }).passthrough()),
}).passthrough();

describe('benchmark run --task --arm', () => {
  it('runs one baseline and the chosen arm\'s trials of the chosen task, and records only them', async () => {
    const fixture = await twoByTwo();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--task', 'fix', '--arm', 'codex']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(record.tasks.map(({ id }) => id)).toEqual(['fix']);
    expect(record.arms.map(({ name }) => name)).toEqual(['codex']);
    expect(record.trials).toMatchObject([{ task: 'fix', arm: 'codex', result: 'passed' }]);
    expect(fixture.toolLaunches().map(({ tool }) => tool)).toEqual(['codex']);
    expect(done.outputs.text).toContain('| codex |');
    expect(done.outputs.text).not.toContain('| claude |');
    expect(done.outputs.text).not.toContain('| again |');
  }, 180_000);

  it('fails naming a task the suite does not have and the tasks it has, and leaves no run', async () => {
    const fixture = await twoByTwo();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--task', 'nope']);

    expect(ran.code, said(ran)).toBe(1);
    expect(envelope(ran).error).toEqual({ code: 'invalid_arguments', message: 'Suite "fix" has no task "nope". Its tasks: again, fix.' });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 180_000);

  it('fails naming an arm the suite does not have and the arms it has, and leaves no run', async () => {
    const fixture = await twoByTwo();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--arm', 'gemini']);

    expect(ran.code, said(ran)).toBe(1);
    expect(envelope(ran).error).toEqual({ code: 'invalid_arguments', message: 'Suite "fix" has no arm "gemini". Its arms: claude, codex.' });
    expect(fixture.runIds()).toEqual([]);
  }, 180_000);
});

describe('the inputs tasks and arms of teamai-benchmark', () => {
  it('plan the whole suite when both are []', async () => {
    const fixture = await twoByTwo();

    const ran = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--driver', 'local', '--sandbox', '--timeout', '10m', '--inputs', '{"suite":"fix","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false}']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const record = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(record.tasks.map(({ id }) => id)).toEqual(['again', 'fix']);
    expect(record.arms.map(({ name }) => name)).toEqual(['claude', 'codex']);
    expect(record.trials).toHaveLength(4);
  }, 180_000);
});
