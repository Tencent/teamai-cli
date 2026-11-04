import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { readRun } from '../workflow/store.js';
import { BARRIER, dirs, projectAiTool, workflowFixture } from './helpers/workflow-local-driver-fixture.js';

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const Invocation = z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string()), stdin: z.string(), cwd: z.string() });

/**
 * A tool named `name` in `bin` that records how it was launched and replies with `stdout`, after `before` ran in it,
 * and a reader of the record.
 */
function fakeTool(bin: string, name: string, { stdout, exitCode = 0, before = '' }: { stdout: string; exitCode?: number; before?: string }): () => z.infer<typeof Invocation> {
  const record = path.join(bin, `${name}.json`);
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', async () => {
  ${before}
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd() }));
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${exitCode});
});\n`, { mode: 0o755 });

  return () => Invocation.parse(JSON.parse(fs.readFileSync(record, 'utf8')));
}

const claudeReply = (result: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 12, output_tokens: 3 } });

/** A PATH that holds only `bin`, git, node and the system shell, so no AI tool installed here is found. */
function pathOf(bin: string): string {
  fs.symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  vi.stubEnv('PATH', `${bin}:/bin`);
  vi.stubEnv('TEAMAI_AI_TOOL', '');

  return bin;
}

async function answering(yaml: string): Promise<{ config: Awaited<ReturnType<typeof workflowFixture>>['config']; workspace: string; runId: string; bin: string }> {
  const built = await workflowFixture(yaml);
  const bin = path.join(path.dirname(built.workspace), 'bin');
  fs.mkdirSync(bin);
  pathOf(bin);
  onTestFinished(() => { vi.unstubAllEnvs(); });

  return { ...built, bin };
}

const COLOR = `schemaVersion: v1alpha1
name: build
description: Ask for a color.
steps:
  - id: ask
    answer: Name one color.
    output: { text: string }
    timeout: 600s
outputs: { text: steps.ask.outputs.text }
`;

describe('answer steps on the local driver', () => {
  it('answers on the first tool installed, as a launch hooks skip, and reports its text and tokens', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    const claude = fakeTool(bin, 'claude', { stdout: claudeReply('blue') });
    fakeTool(bin, 'hermes', { stdout: 'red' });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { text: 'blue' } } } });
    expect(claude()).toMatchObject({ stdin: 'Name one color.', env: { TEAMAI_LAUNCHED_BY: 'answer', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1' } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({ steps: [{ id: 'ask', status: 'succeeded', tool: 'claude', tokens: { input: 12, output: 3 } }] });
  });

  it.each([{ names: 'TEAMAI_AI_TOOL' }, { names: "the project's ai.tool" }])('answers on the tool $names names, over the first installed', async ({ names }) => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    fakeTool(bin, 'claude', { stdout: claudeReply('blue') });
    const hermes = fakeTool(bin, 'hermes', { stdout: 'red\n' });

    if (names === 'TEAMAI_AI_TOOL') vi.stubEnv('TEAMAI_AI_TOOL', 'hermes');
    else projectAiTool(config, 'hermes');

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { text: 'red' } } } });
    expect(hermes().args).toEqual(['-z', 'Name one color.']);
  });

  it('asks for the JSON its output declares and reports the object the reply holds', async () => {
    const { config, workspace, runId, bin } = await answering(`schemaVersion: v1alpha1
name: build
description: Ask for a color.
steps:
  - id: ask
    answer: Name one color.
    output: { color: string }
outputs: { color: steps.ask.outputs.color }
`);
    const claude = fakeTool(bin, 'claude', { stdout: claudeReply('```json\n{"color":"blue"}\n```') });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { color: 'blue' } } } });
    expect(claude().stdin).toBe('Name one color.\n\nReply with only a JSON value, with no other text: a value that matches this JSON Schema: `{"type":"object","properties":{"color":{"type":"string"}},"required":["color"]}`');
  });

  it('fails the step tool_failed with the reason the tool gave', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    fakeTool(bin, 'claude', { stdout: '', exitCode: 2, before: "process.stderr.write('Authentication failed\\n');" });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'tool_failed', message: 'AI call failed (tool: claude): Authentication failed' } }],
    });
  });

  it('answers beside a command in the checkout, since it takes no place', async () => {
    const { config, workspace, runId, bin } = await answering(`schemaVersion: v1alpha1
name: build
description: A command and an answer that each wait for the other.
steps:
  - id: left
    needs: []
    command: node barrier.js left right
  - id: right
    needs: []
    answer: Name one color.
    output: { text: string }
`);
    config.workflows = { tools: {}, max_parallel: 2 };
    fs.writeFileSync(path.join(workspace, 'barrier.js'), BARRIER);
    execFileSync('git', ['add', 'barrier.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    const markers = path.join(path.dirname(workspace), 'markers');
    fakeTool(bin, 'claude', { stdout: claudeReply('blue'), before: `
  fs.mkdirSync(${JSON.stringify(markers)}, { recursive: true });
  fs.writeFileSync(path.join(${JSON.stringify(markers)}, 'right.ready'), '');
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(path.join(${JSON.stringify(markers)}, 'left.ready')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));` });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });
});

/**
 * A claude in `bin` that answers "Describe <name>." prompts. It appends `start <name>` and `end <name>`, each with the
 * time, to one log. Between them it waits until two answers have started, or for `waitMs`, so two that run at once
 * both start before either ends. It returns the log's lines, without the times, in the order they were written.
 */
function describingTool(bin: string, waitMs: number): () => string[] {
  const log = path.join(bin, 'answers.log');
  fakeTool(bin, 'claude', { stdout: claudeReply('described'), before: `
  const me = /Describe (\\w+)/.exec(stdin)[1];
  const lines = () => fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n') : [];
  fs.appendFileSync(${JSON.stringify(log)}, 'start ' + me + ' ' + Date.now() + '\\n');
  const deadline = Date.now() + ${waitMs};
  while (lines().filter((line) => line.startsWith('start ')).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(${JSON.stringify(log)}, 'end ' + me + ' ' + Date.now() + '\\n');` });

  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ').slice(0, 2).join(' '));
}

/** A plan of two modules, then one answer per module; `after` adds steps that need only the plan. */
const DESCRIBE = (forEach: string, after = ''): string => `schemaVersion: v1alpha1
name: build
description: Describe each module.
steps:
  - id: plan
    command: echo '{"modules":["api","cli"]}'
    output: { modules: [string] }
  - id: describe
    needs: [plan]
    for_each: ${forEach}
    answer: "Describe {{ item }}."
    output: { text: string }
${after}`;

describe('for_each items on the local driver with no workflows.max_parallel', () => {
  it('answers two items of a for_each with max_parallel 2 at the same time', async () => {
    const { config, workspace, runId, bin } = await answering(DESCRIBE('{ items: steps.plan.outputs.modules, max_parallel: 2 }'));
    const order = describingTool(bin, 10_000);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(order().slice(0, 2).sort()).toEqual(['start api', 'start cli']);
  });

  it('answers the items of a for_each with no max_parallel one at a time', async () => {
    const { config, workspace, runId, bin } = await answering(DESCRIBE('steps.plan.outputs.modules'));
    const order = describingTool(bin, 300);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(order()).toEqual(['start api', 'end api', 'start cli', 'end cli']);
  });

  it('starts no other step while the items run', async () => {
    const lint = `  - id: lint
    needs: [plan]
    command: 'echo "start lint $(date +%s%3N)" >> "$LOG"; echo "end lint $(date +%s%3N)" >> "$LOG"'
`;
    const { config, workspace, runId, bin } = await answering(DESCRIBE('{ items: steps.plan.outputs.modules, max_parallel: 2 }', lint));
    vi.stubEnv('LOG', path.join(bin, 'answers.log'));
    const order = describingTool(bin, 10_000);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const lines = order();
    expect(lines.slice(0, 2).sort()).toEqual(['start api', 'start cli']);
    expect(lines.slice(4)).toEqual(['start lint', 'end lint']);
  });
});
