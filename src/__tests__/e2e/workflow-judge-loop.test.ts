/**
 * Real CLI: an ordinary workflow whose step's scorers have `sampling: all`. The local driver judges every pass of that
 * step, whatever the scorer samples, before the run's `finally` steps run, and the verdicts stay in `run.verdicts`
 * whatever a `finally` step does.
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
finally:
  - id: seen
    command: node seen.js
`;
// The finally step records how many judges had run, and the verdicts the run held, when it started; then it fails.
const SEEN = `const fs = require('node:fs');
const path = require('node:path');
const log = process.env.FIXTURE_ROOT + '/judge.log';
const projects = path.join(process.env.HOME, '.teamai', 'projects');
const runs = fs.readdirSync(projects).map((name) => path.join(projects, name, 'workflows', 'runs')).filter((dir) => fs.existsSync(dir));
const [run] = runs.flatMap((dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))));
fs.writeFileSync(process.env.FIXTURE_ROOT + '/seen.json', JSON.stringify({
  judges: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0,
  verdicts: run.verdicts ?? null,
}));
process.exit(1);
`;

// The fixture's claude, as a prompt tool, ends on a detached HEAD, which a new workspace refuses. This one fixes the
// answer and leaves HEAD where it was; as a judge, or asked its version, it is the fixture's.
const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {
  process.exit(spawnSync(path.join(__dirname, 'claude-fixture'), process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
fs.writeFileSync('answer.js', 'module.exports = 42;\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fake-session', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
`;

const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string(), finally: z.array(z.object({ id: z.string(), outcome: z.string() }).passthrough()) }) });
const RunSchema = z.object({ verdicts: z.array(z.unknown()) });
const SeenSchema = z.object({ judges: z.number(), verdicts: z.array(z.unknown()).nullable() });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe('the judge loop of an ordinary workflow on the local driver', () => {
  it('judges every pass of a sampling: all step before finally runs, and keeps the verdicts whatever finally does', async () => {
    const fixture = await benchmarkFixture({
      tool: 'does-nothing', sandbox: false, tools: ['claude'], team: { 'scorers/quality.md': QUALITY, 'workflows/judged.yaml': JUDGED }, app: { 'seen.js': SEEN },
    });
    fixtures.push(fixture);
    fs.renameSync(path.join(fixture.bin, 'claude'), path.join(fixture.bin, 'claude-fixture'));
    fs.writeFileSync(path.join(fixture.bin, 'claude'), CLAUDE, { mode: 0o755 });

    const started = await fixture.teamai(['workflow', 'start', 'judged', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    const { done } = DoneSchema.parse(envelope(started).data);
    expect(done.outcome).toBe('succeeded');
    expect(done.finally).toEqual([expect.objectContaining({ id: 'seen', outcome: 'failed' })]);
    expect(fixture.judgeLaunches().map(({ labels }) => labels)).toEqual([['tidy', 'messy']]);
    const verdicts = [expect.objectContaining({ scorer: 'quality', step: 'review', pass: 1, outcome: { kind: 'labelled', label: 'tidy', passed: true } })];
    expect(SeenSchema.parse(JSON.parse(fs.readFileSync(path.join(fixture.root, 'seen.json'), 'utf8')))).toEqual({ judges: 1, verdicts });
    expect(RunSchema.parse(fixture.runFile(done.run)).verdicts).toEqual(verdicts);
  }, 120_000);
});
