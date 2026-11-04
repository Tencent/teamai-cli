/**
 * Real CLI: an ordinary workflow whose step's scorers have `sampling: all`. Every pass of that step is judged by a
 * teamai-score run of its own, whatever the scorer samples, which the local driver drives before `workflow start`
 * returns; the run itself records no verdicts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const QUALITY = `---
labels:
  - { value: tidy, score: 1, description: The review is short and clear }
  - { value: messy, score: 0, description: It is not }
passingScore: 1
samplingRate: 0
---
Judge how tidy the review is.
`;
const JUDGED = `schemaVersion: v1alpha1
name: judged
description: Fix the answer; a judge labels every fix.
steps:
  - id: review
    prompt: Make answer.js export 42.
    tool: claude
    workspace: new
    scorers: { names: [quality], sampling: all }
`;

// The fixture's claude, as a prompt tool, ends on a detached HEAD, which a new workspace refuses. This one fixes the
// answer and leaves HEAD where it was, and names no session, whose transcript the judge's evidence would need; as a
// judge, or asked its version, it is the fixture's.
const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {
  process.exit(spawnSync(path.join(__dirname, 'claude-fixture'), process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
fs.writeFileSync('answer.js', 'module.exports = 42;\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
`;

const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string() }) });
const ScoreRunSchema = z.object({
  definition: z.object({ name: z.string() }),
  status: z.string(),
  steps: z.array(z.object({ id: z.string(), outputs: z.object({ labels: z.unknown() }).partial().optional() }).passthrough()),
});

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('the judge loop of an ordinary workflow on the local driver', () => {
  it('judges a pass of a sampling: all step that the scorer does not sample, with a teamai-score run of its own, and records no verdicts in the run', async () => {
    const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, tools: ['claude'], team: { 'scorers/quality.md': QUALITY, 'workflows/judged.yaml': JUDGED } });
    fixtures.push(fixture);
    fs.renameSync(path.join(fixture.bin, 'claude'), path.join(fixture.bin, 'claude-fixture'));
    fs.writeFileSync(path.join(fixture.bin, 'claude'), CLAUDE, { mode: 0o755 });

    const started = await fixture.teamai(['workflow', 'start', 'judged', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    const { done } = DoneSchema.parse(envelope(started).data);
    const scoring = fixture.runIds().filter((id) => id !== done.run).map((id) => ScoreRunSchema.parse(fixture.runFile(id)));
    expect(done.outcome).toBe('succeeded');
    expect(fixture.runFile(done.run)).not.toHaveProperty('verdicts');
    expect(fixture.judgeLaunches().map(({ labels }) => labels)).toEqual([['tidy', 'messy']]);
    expect(scoring).toEqual([expect.objectContaining({ definition: expect.objectContaining({ name: 'teamai-score' }), status: 'succeeded' })]);
    expect(scoring[0]?.steps.find(({ id }) => id === 'score[0]')?.outputs?.labels).toEqual([{ scorer: 'quality', label: 'tidy', code: '' }]);
  }, 120_000);
});
