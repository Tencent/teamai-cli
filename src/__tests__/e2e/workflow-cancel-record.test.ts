/**
 * Real CLI: `workflow cancel` ends a run whose driver died, and publishes its end record to the team then, without
 * waiting for a later command to deliver it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review the project.
steps:
  - id: review
    prompt: Review the project.
    tool: claude
`;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('a cancel through the CLI', () => {
  it('publishes the end record of the run it cancels', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', firstLaunch: 'kills-its-driver', sandbox: false, tools: ['claude'], team: { 'workflows/review.yaml': REVIEW } });
    fixtures.push(fixture);
    // The tool kills the driver, which leaves the run running with no process to end it.
    await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);
    const [run = ''] = fixture.runIds();

    const cancelled = await fixture.teamai(['workflow', 'cancel', run]);

    expect(envelope(cancelled).data, said(cancelled)).toMatchObject({ run: { status: 'cancelled' } });
    expect(fixture.endRecord(run)).toMatchObject({ run, phase: 'end', status: 'cancelled' });
  }, 120_000);
});
