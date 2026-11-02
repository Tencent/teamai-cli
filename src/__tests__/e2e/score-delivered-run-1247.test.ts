/**
 * Real CLI: the example of docs/guide/scorers.md#score-what-a-run-delivered. A run of ship-issue reads an issue into a
 * typed output, then delivers a pull request on a GitHub origin, and a member scores it on demand with only
 * `teamai score --run <id> --scorer delivered`. The scorer's check (`node test.js`, with test.js protected) runs on the
 * delivered commit first, then the pull request's CI is read; the first that fails decides the label with no judge, and
 * the label says which. When both pass, the judge decides. `gh` is the fake every delivery test shares, answering the
 * same check runs for any commit.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeGhHost } from '../helpers/fake-gh.js';

const DELIVERED = `---
labels:
  - { value: complete, score: 1, description: Delivers what was asked and nothing else. }
  - { value: partial, score: 0.5, description: Delivers part of what was asked. }
  - { value: off-target, score: 0, description: Delivers something other than what was asked. }
passingScore: 1
samplingRate: 100
check: { run: node test.js, protect: [test.js] }
---
Judge whether the pull request delivers what the issue asked, and only that.
`;
const SHIP = `schemaVersion: v1alpha1
name: ship-issue
description: Make the change an issue asks for and deliver it for review.
inputs: { issue: number }
steps:
  - id: read-issue
    command: node read-issue.js
    env: { ISSUE: "{{ inputs.issue }}" }
    output: { title: string, body: string }
  - id: change
    needs: [read-issue]
    prompt: "Do what issue {{ inputs.issue }} asks: {{ steps.read-issue.outputs.body }}"
    tool: claude
    workspace: new
    deliver: pr
    scorers: [delivered]
`;
// The same run, with the change made by a workflow of its own, which delivers what its steps wrote.
const SHIP_BY_WORKFLOW = SHIP.replace(`    prompt: "Do what issue {{ inputs.issue }} asks: {{ steps.read-issue.outputs.body }}"
    tool: claude
    workspace: new`, `    workspace: new
    workflow:
      steps:
        - id: write
          prompt: "Do what issue {{ inputs.issue }} asks: {{ steps.read-issue.outputs.body }}"
          tool: claude
          workspace: continue`);
// What the issue tracker answers for an issue, as a typed output.
const READ_ISSUE = "console.log(JSON.stringify({ title: 'Answer 42', body: 'Issue ' + process.env.ISSUE + ': make answer.js export 42.' }));\n";
// The fixture's claude, as a prompt tool, ends on a detached HEAD, which a new workspace refuses. This one fixes the
// answer, except for issue 13, where it writes 43; it leaves HEAD where it was and its session where Claude Code keeps
// it. As a judge, or asked its version, it is the fixture's.
const CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--json-schema') || process.argv.includes('--version')) {
  process.exit(spawnSync(path.join(__dirname, 'claude-fixture'), process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
}
fs.writeFileSync('answer.js', process.argv.some((arg) => arg.includes('issue 13 ')) ? 'module.exports = 43;\\n' : 'module.exports = 42;\\n');
const project = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(project, { recursive: true });
const base = { cwd: process.cwd(), sessionId: 'fake-session', timestamp: new Date().toISOString() };
fs.writeFileSync(path.join(project, 'fake-session.jsonl'), [
  { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Make answer.js export 42.' } },
  { ...base, type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', model: 'fake-claude', content: [{ type: 'text', text: 'Done.' }] } },
].map((line) => JSON.stringify(line)).join('\\n') + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fake-session', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
`;

const DoneSchema = z.object({ done: z.object({ run: z.string(), outcome: z.string() }) });
const LabelSchema = z.object({
  scorer: z.string(), label: z.string(), passed: z.boolean(), decidedBy: z.string().optional(), evidenceHash: z.string().optional(),
  subject: z.object({ runId: z.string(), step: z.string(), pass: z.number() }),
  judge: z.object({ kind: z.string() }).passthrough(),
}).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** The labels the team origin's teamai-reports holds under `scores/`, as text and parsed. */
function published(fixture: BenchmarkFixture): { text: string; labels: Array<z.infer<typeof LabelSchema>> } {
  const git = (...args: string[]): string => spawnSync('git', ['--git-dir', fixture.teamOrigin, ...args], { encoding: 'utf8' }).stdout.trim();
  const text = git('ls-tree', '-r', '--name-only', 'teamai-reports').split('\n').filter((file) => file.startsWith('scores/'))
    .map((file) => git('show', `teamai-reports:${file}`)).join('\n');
  return { text, labels: text.split('\n').filter(Boolean).map((line) => LabelSchema.parse(JSON.parse(line))) };
}

/**
 * Runs ship-issue for `issue` against a GitHub origin whose `gh` answers `checkRuns` for any commit, then scores its
 * delivering pass on demand with only --run and --scorer.
 */
async function shipAndScore(checkRuns: unknown[], issue = 42, ship = SHIP): Promise<{ fixture: BenchmarkFixture; run: string }> {
  const fixture = await benchmarkFixture({
    tool: 'does-nothing', sandbox: false, tools: ['claude'], team: { 'scorers/delivered.md': DELIVERED, 'workflows/ship-issue.yaml': ship },
    app: { 'read-issue.js': READ_ISSUE },
  });
  fixtures.push(fixture);
  fs.renameSync(path.join(fixture.bin, 'claude'), path.join(fixture.bin, 'claude-fixture'));
  fs.writeFileSync(path.join(fixture.bin, 'claude'), CLAUDE, { mode: 0o755 });
  const gh = fakeGhHost(path.join(fixture.root, 'gh'), { checks: { runs: checkRuns } });
  fixture.env.PATH = [path.dirname(gh.bin), fixture.env.PATH ?? ''].join(path.delimiter);

  const started = await fixture.teamai(['workflow', 'start', 'ship-issue', '--inputs', JSON.stringify({ issue }), '--driver', 'local']);
  expect(started.code, said(started)).toBe(0);
  const { done } = DoneSchema.parse(envelope(started).data);
  expect(done.outcome, said(started)).toBe('succeeded');
  expect(fixture.judgeLaunches()).toEqual([]);

  const scored = await fixture.teamai(['score', '--run', done.run, '--scorer', 'delivered']);
  expect(scored.code, said(scored)).toBe(0);
  return { fixture, run: done.run };
}

describe('scoring what a workflow run delivered, through the real CLI', () => {
  it('labels a delivered pull request whose CI failed from the CI, with no judge, and publishes no prompt or diff', async () => {
    const { fixture, run } = await shipAndScore([{ name: 'test', status: 'completed', conclusion: 'failure' }]);

    expect(fixture.judgeLaunches()).toEqual([]);
    const { text, labels } = published(fixture);
    expect(labels).toEqual([expect.objectContaining({
      scorer: 'delivered', label: 'partial', passed: false, decidedBy: 'ci', evidenceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      subject: { runId: run, step: 'change', pass: 1 },
    })]);
    expect(labels[0]?.judge).not.toHaveProperty('usage');
    // Neither the issue the run read, the prompt, the diff nor the reasoning leaves this machine.
    for (const secret of ['Answer 42', 'make answer.js export 42', 'Do what issue', 'module.exports', 'reasoning']) expect(text).not.toContain(secret);
  }, 180_000);

  it('labels a delivered pull request whose scorer check fails from the check, before its CI is read', async () => {
    // Issue 13's answer is 43, so the base commit's test.js fails on the delivered commit; CI would pass.
    const { fixture, run } = await shipAndScore([{ name: 'test', status: 'completed', conclusion: 'success' }], 13);

    expect(fixture.judgeLaunches()).toEqual([]);
    expect(published(fixture).labels).toEqual([expect.objectContaining({
      label: 'partial', passed: false, decidedBy: 'check', subject: { runId: run, step: 'change', pass: 1 },
    })]);
  }, 180_000);

  it('runs the scorer\'s check on what a workflow step delivered, which decides as for a prompt step', async () => {
    const { fixture, run } = await shipAndScore([{ name: 'test', status: 'completed', conclusion: 'success' }], 13, SHIP_BY_WORKFLOW);

    expect(fixture.judgeLaunches()).toEqual([]);
    expect(published(fixture).labels).toEqual([expect.objectContaining({
      label: 'partial', passed: false, decidedBy: 'check', subject: { runId: run, step: 'change', pass: 1 },
    })]);
  }, 180_000);

  it('hands a delivered pull request whose CI passed to the judge, which decides its label', async () => {
    const { fixture, run } = await shipAndScore([{ name: 'test', status: 'completed', conclusion: 'success' }]);

    expect(fixture.judgeLaunches().map(({ labels }) => labels)).toEqual([['complete', 'partial', 'off-target']]);
    expect(published(fixture).labels).toEqual([expect.objectContaining({
      label: 'complete', passed: true, decidedBy: 'judge', subject: { runId: run, step: 'change', pass: 1 },
    })]);
  }, 180_000);
});
