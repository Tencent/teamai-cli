/**
 * Real CLI: a step's `scorers:` on a run the local driver drives. Each settled pass gets one root teamai-score run that
 * the scoring module starts; an attended `workflow start` drives it before it returns, so the label is written by then.
 * A `scorers.start: workflow` step, whose workflow scores its passes itself, gets none. An unattended drive labels its
 * pass the same way, so the drain it ends with judges no workflow pass.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const QUALITY = `---
labels:
  - { value: good, score: 1, description: Does what the step asked. }
  - { value: bad, score: 0, description: Does not. }
passingScore: 1
samplingRate: 100
---
Judge whether the review does what the step asked.
`;
const review = (scorers: string) => `schemaVersion: v1alpha1
name: review
description: Review the change.
steps:
  - id: review
    prompt: Review the change.
    tool: claude
    scorers: ${scorers}
`;
// As a prompt tool, it reviews nothing and leaves its session where Claude Code keeps it. As a judge, or asked its
// version, it is the fixture's.
const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {
  process.exit(spawnSync(path.join(__dirname, 'claude-fixture'), process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
const project = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(project, { recursive: true });
const base = { cwd: process.cwd(), sessionId: 'review-session', timestamp: new Date().toISOString() };
fs.writeFileSync(path.join(project, 'review-session.jsonl'), [
  { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Review the change.' } },
  { ...base, type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', model: 'fake-claude', content: [{ type: 'text', text: 'Reviewed.' }] } },
].map((line) => JSON.stringify(line)).join('\\n') + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'review-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'review-session', usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
`;

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');

const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string() }) });
const RunSchema = z.object({ id: z.string(), name: z.string(), startedBy: z.string().optional(), inputs: z.record(z.string(), z.unknown()).optional() }).passthrough();
const LabelSchema = z.object({ scorer: z.string(), label: z.string(), subject: z.unknown(), judge: z.object({ kind: z.string() }).passthrough() }).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function reviewFixture(scorers: string, mode: 'attended' | 'unattended'): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'does-nothing', sandbox: false, tools: ['claude'], team: { 'scorers/quality.md': QUALITY, 'workflows/review.yaml': review(scorers) },
  });
  fixtures.push(fixture);
  fs.renameSync(path.join(fixture.bin, 'claude'), path.join(fixture.bin, 'claude-fixture'));
  fs.writeFileSync(path.join(fixture.bin, 'claude'), CLAUDE, { mode: 0o755 });
  fixture.env.TEAMAI_MODE = mode;
  delete fixture.env.CI;
  return fixture;
}

function scoreRuns(fixture: BenchmarkFixture): Array<z.infer<typeof RunSchema>> {
  return fixture.runIds().map((id) => RunSchema.parse(fixture.runFile(id))).filter((run) => run.name === 'teamai-score');
}

function labels(fixture: BenchmarkFixture): Array<z.infer<typeof LabelSchema>> {
  const file = path.join(fixture.dataHome(), 'scores', 'labels.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => LabelSchema.parse(JSON.parse(line))) : [];
}

describe('the scoring of a run\'s passes, through the real CLI', () => {
  it('labels the pass of an attended local run by the time workflow start returns, through one teamai-score run', async () => {
    const fixture = await reviewFixture('[quality]', 'attended');

    const started = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    const { done } = DoneSchema.parse(envelope(started).data);
    expect(done.outcome).toBe('succeeded');
    const [score, ...more] = scoreRuns(fixture);
    expect(more).toEqual([]);
    expect(score).toMatchObject({
      startedBy: 'cli', status: 'succeeded',
      inputs: { subject: `run:${done.run}:review:1`, scorers: [], label: '', batch: false, demand: 'auto' },
    });
    expect(labels(fixture)).toEqual([expect.objectContaining({
      scorer: 'quality', label: 'good', subject: { runId: done.run, step: 'review', pass: 1 }, judge: expect.objectContaining({ kind: 'model' }),
    })]);
    expect(fixture.judgeLaunches()).toHaveLength(1);
  }, 180_000);

  it('labels the pass on a resume from another directory after the driver died while judging it', async () => {
    const fixture = await reviewFixture('[quality]', 'attended');
    const killed = path.join(fixture.tmp, 'judge-killed');
    fs.writeFileSync(path.join(fixture.bin, 'claude'), CLAUDE.replace("if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {",
      `if (process.argv.includes('--json-schema') && !fs.existsSync(${JSON.stringify(killed)})) {
  fs.writeFileSync(${JSON.stringify(killed)}, '');
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}
if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {`), { mode: 0o755 });
    await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);
    expect(fs.existsSync(killed)).toBe(true);
    const parent = fixture.runIds().map((id) => RunSchema.parse(fixture.runFile(id))).find((run) => run.name === 'review');
    const elsewhere = path.join(fixture.work, 'docs');
    fs.mkdirSync(elsewhere, { recursive: true });

    const resumed = spawnSync(process.execPath, [CLI, 'workflow', 'resume', parent?.id ?? '', '--driver', 'local'], { cwd: elsewhere, env: fixture.env, encoding: 'utf8', timeout: 120_000 });

    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(scoreRuns(fixture)).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(labels(fixture)).toEqual([expect.objectContaining({ scorer: 'quality', label: 'good', subject: { runId: parent?.id, step: 'review', pass: 1 } })]);
  }, 300_000);

  it('starts no teamai-score run for a step whose workflow scores its passes itself', async () => {
    const fixture = await reviewFixture('{ names: [quality], start: workflow }', 'attended');

    const started = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    expect(scoreRuns(fixture)).toEqual([]);
    expect(labels(fixture)).toEqual([]);
    expect(fixture.judgeLaunches()).toEqual([]);
  }, 180_000);

  it('labels with teamai score --drain the pass of a start: workflow step its workflow did not score, once the run ended', async () => {
    const fixture = await reviewFixture('{ names: [quality], start: workflow }', 'attended');
    const started = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);
    const { done } = DoneSchema.parse(envelope(started).data);

    const drained = await fixture.teamai(['score', '--drain']);

    expect(drained.code, said(drained)).toBe(0);
    expect(said(drained)).toContain('✔ Judged 1 sampled pass here (quality)');
    expect(fixture.runIds().map((id) => RunSchema.parse(fixture.runFile(id))).filter((run) => run.name === 'teamai-finished-sessions'))
      .toEqual([expect.objectContaining({ startedBy: 'cli', status: 'succeeded' })]);
    expect(labels(fixture)).toEqual([expect.objectContaining({ scorer: 'quality', label: 'good', subject: { runId: done.run, step: 'review', pass: 1 } })]);

    const again = await fixture.teamai(['score', '--drain']);

    expect(again.code, said(again)).toBe(0);
    expect(said(again)).not.toContain('Judged');
  }, 180_000);

  it('labels the pass of an unattended local run through one teamai-score run, leaving its drain no workflow pass to judge', async () => {
    const fixture = await reviewFixture('[quality]', 'unattended');

    const started = await fixture.teamai(['workflow', 'start', 'review', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    const { done } = DoneSchema.parse(envelope(started).data);
    expect(scoreRuns(fixture)).toEqual([expect.objectContaining({ startedBy: 'cli', status: 'succeeded', inputs: expect.objectContaining({ subject: `run:${done.run}:review:1` }) })]);
    expect(labels(fixture)).toEqual([expect.objectContaining({ scorer: 'quality', label: 'good', subject: { runId: done.run, step: 'review', pass: 1 } })]);
    expect(fixture.judgeLaunches()).toHaveLength(1);
    expect(started.stderr).not.toContain('sampled pass');
  }, 180_000);
});
