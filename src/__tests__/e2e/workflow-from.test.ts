/**
 * Real CLI: an ordinary workflow whose command step prints a workflow, and a `from` step that runs it, on the local
 * driver. The printing step runs `teamai --version` with no teamai of its own on PATH, so it finds the CLI that runs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const PLANNED = `schemaVersion: v1alpha1
name: planned
description: Print a workflow, then run it.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
outputs:
  plan: steps.plan.outputs.plan
`;
const PLAN = `const { execFileSync } = require('node:child_process');
const teamai = execFileSync('teamai', ['--version'], { encoding: 'utf8' }).trim();
const definition = { schemaVersion: 'v1alpha1', name: 'generated', description: 'Say hello.', steps: [{ id: 'hello', command: 'node hello.js' }] };
process.stdout.write(JSON.stringify({ definition: { definition }, plan: { teamai } }));
`;
const HELLO = `require('node:fs').writeFileSync(process.env.FIXTURE_ROOT + '/hello.txt', 'hello');
`;

const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ plan: z.object({ teamai: z.string() }) }) }) });
const RunSchema = z.object({ admitted: z.object({ plan: z.object({ hash: z.string(), output: z.unknown() }) }) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('a from step on the local driver', () => {
  it('runs the workflow an earlier command step printed, and that step reaches the running teamai', async () => {
    const fixture = await benchmarkFixture({
      tool: 'does-nothing', sandbox: false, tools: [], team: { 'workflows/planned.yaml': PLANNED }, app: { 'plan.js': PLAN, 'hello.js': HELLO },
    });
    fixtures.push(fixture);
    const version = (await fixture.teamai(['--version'])).stdout.trim();
    // Only the running CLI can answer teamai on PATH now.
    fs.rmSync(path.join(fixture.bin, 'teamai'));

    const started = await fixture.teamai(['workflow', 'start', 'planned', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    const { done } = DoneSchema.parse(envelope(started).data);
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.plan.teamai).toBe(version);
    expect(fs.readFileSync(path.join(fixture.root, 'hello.txt'), 'utf8')).toBe('hello');
    const run = RunSchema.parse(fixture.runFile(done.run));
    expect(run.admitted.plan.output).toEqual({ definition: { definition: expect.objectContaining({ name: 'generated' }) }, plan: { teamai: version } });
  }, 120_000);
});
