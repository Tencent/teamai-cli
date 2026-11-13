import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { claudeFake } from '@teamai/tool-claude/testing';
import { fakeAgent, type FakeAgent } from '@teamai/tool-testing/fake-agent';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { readRun } from '../workflow/store.js';
import { getUserHome } from '@teamai/shared/home';
import { dirs, projectAiTool, workflowFixture } from './helpers/workflow-local-driver-fixture.js';

const agents: FakeAgent[] = [];

afterEach(async () => {
  const left = (await Promise.all(agents.splice(0).map((agent) => agent.stopLeft()))).flat();

  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

/** Claude in `bin` as its recorded call prints it, keeping its sessions under `home`. */
function claudeIn(bin: string, home: string, options: Omit<Parameters<typeof fakeAgent>[1], 'bin'>): FakeAgent {
  vi.stubEnv('HOME', home);
  const agent = fakeAgent(claudeFake, { bin, ...options });
  agents.push(agent);

  return agent;
}

const COLOR_JSON = `schemaVersion: v1alpha1
name: build
description: Ask for a color.
steps:
  - id: ask
    answer: Name one color.
    output: { color: string }
outputs: { color: steps.ask.outputs.color }
`;

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
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'blue' });
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
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: '```json\n{"color":"blue"}\n```' });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { color: 'blue' } } } });
    expect(claude.calls()[0]?.prompt).toBe('Name one color.\n\nReply with only a JSON value, with no other text: a value that matches this JSON Schema: `{"type":"object","properties":{"color":{"type":"string"}},"required":["color"]}`');
  });

  it('asks once more in the same session when the reply holds no JSON, and reports the value it then gives', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'I would say blue.', answers: [{ when: 'Retries remaining', answer: '{"color":"blue"}' }] });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { color: 'blue' } } } });
    const [first, second] = claude.calls();
    expect(first?.args).toEqual(['-p', '--output-format', 'json']);
    expect(second?.args).toEqual(['-p', '--output-format', 'json', '--resume', expect.any(String)]);
    expect(second?.prompt).toContain('I would say blue.');
  });

  it('asks again when the reply holds JSON that is not the step\'s output', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: '{"colour":"blue"}', answers: [{ when: 'Retries remaining', answer: '{"color":"blue"}' }] });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { color: 'blue' } } } });
    expect(claude.calls()).toHaveLength(2);
  });

  it('fails a reply that lists several values the output takes rather than picking one of them', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'Either works: [{"color":"red"},{"color":"blue"}]' });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({ steps: [{ id: 'ask', status: 'failed', failure: { code: 'invalid_output' } }] });
  });

  it('fails invalid_output with the last reply once asking again gave no value either', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'Blue, I think.' });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(claude.calls()).toHaveLength(2);
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'invalid_output', message: expect.stringContaining('Blue, I think.') } }],
    });
  });

  it('stops a tool that prints nothing for workflows.idle_timeout, and fails the step naming the limit', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    config.workflows = { tools: {}, idle_timeout: '1s' };
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: '{"color":"blue"}', always: ['slow'], slowMs: 20_000 });
    const started = Date.now();

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('printed nothing for 1s') } }],
    });
  });

  it('refuses an idle limit that is no duration, naming the setting to fix', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR_JSON);
    config.workflows = { tools: {}, idle_timeout: 'soon' };
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: '{"color":"blue"}' });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(claude.calls()).toEqual([]);
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'tool_unconfigured', message: expect.stringContaining('workflows.idle_timeout is "soon"') } }],
    });
  });

  it('reads the JSON a reply fences after a line of prose', async () => {
    const { config, workspace, runId, bin } = await answering(`schemaVersion: v1alpha1
name: build
description: Ask for a color.
steps:
  - id: ask
    answer: Name one color.
    output: { color: string }
outputs: { color: steps.ask.outputs.color }
`);
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'Here is the result:\n```json\n{"color":"blue"}\n```\nLet me know if you need more.' });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { color: 'blue' } } } });
  });

  it('fails the step tool_failed with the reason the tool gave', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { before: "process.stderr.write('Authentication failed\\n'); process.exit(2);" });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'tool_failed', message: 'AI call failed (tool: claude): Authentication failed' } }],
    });
  });

  it('fails the step tool_unavailable, as a prompt step does, when the root recorded for the tool is gone', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    const claude = fakeTool(bin, 'claude', { stdout: claudeReply('blue') });
    const gone = path.join(getUserHome(), '.claude-gone');
    config.toolRoots = { claude: gone };

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'tool_unavailable', message: expect.stringContaining(`The claude home recorded on this machine, ${gone}, does not exist`) } }],
    });
    expect(claude).toThrow('ENOENT');
  });

  it('fails an answer that modifies the checkout', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR);
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'blue', before: "fs.writeFileSync('unexpected.md', 'changed');" });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'read_only_dirty' } }],
    });
  });

  it('fails an answer that modifies its own worktree, and leaves the checkout as it was', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR.replace('    timeout: 600s\n', '    workspace: new\n'));
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'blue', before: "fs.writeFileSync('unexpected.md', 'changed');" });

    const done = await runLocalDriver(config, runId, workspace);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, z.string().parse(runId))).toMatchObject({
      steps: [{ id: 'ask', status: 'failed', failure: { code: 'read_only_dirty' } }],
    });
    expect(fs.realpathSync(claude.calls()[0]?.cwd ?? '')).not.toBe(fs.realpathSync(workspace));
    expect(fs.existsSync(path.join(workspace, 'unexpected.md'))).toBe(false);
  });

  it('answers with workspace: new in the directory it runs in when that is no git repository, which it cannot copy', async () => {
    const { config, workspace, runId, bin } = await answering(COLOR.replace('    timeout: 600s\n', '    workspace: new\n'));
    fs.rmSync(path.join(workspace, '.git'), { recursive: true, force: true });
    const claude = claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'blue' });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { text: 'blue' } } } });
    expect(fs.realpathSync(claude.calls()[0]?.cwd ?? '')).toBe(fs.realpathSync(workspace));
  });

  it('waits for a command using the checkout before answering', async () => {
    const { config, workspace, runId, bin } = await answering(`schemaVersion: v1alpha1
name: build
description: A command and an answer that use the checkout.
steps:
  - id: left
    needs: []
    command: node serial.js
  - id: right
    needs: []
    answer: Name one color.
    output: { text: string }
`);
    config.workflows = { tools: {}, max_parallel: 2 };
    const log = path.join(bin, 'order.log');
    fs.writeFileSync(path.join(workspace, 'serial.js'), `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, 'command start\\n');
setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, 'command end\\n'), 200);`);
    execFileSync('git', ['add', 'serial.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'scripts'], { cwd: workspace });
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'blue', before: `fs.appendFileSync(${JSON.stringify(log)}, 'answer\\n');` });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['command start', 'command end', 'answer']);
  });
});

/**
 * A claude in `bin` that answers "Describe <name>." prompts. It appends `start <name>` and `end <name>`, each with the
 * time, to one log. Between them it waits until two answers have started, or for `waitMs`, so two that run at once
 * both start before either ends. It returns the log's lines, without the times, in the order they were written.
 */
function describingTool(bin: string, waitMs: number): () => string[] {
  const log = path.join(bin, 'answers.log');
  claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'described', before: `
  const me = /Describe (\\w+)/.exec(prompt)[1];
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
  it('serializes answer items that share the checkout despite max_parallel 2', async () => {
    const { config, workspace, runId, bin } = await answering(DESCRIBE('{ items: steps.plan.outputs.modules, max_parallel: 2 }'));
    const order = describingTool(bin, 100);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(order()).toEqual(['start api', 'end api', 'start cli', 'end cli']);
  });

  it('answers items that each have a worktree of their own beside each other', async () => {
    const { config, workspace, runId, bin } = await answering(DESCRIBE('{ items: steps.plan.outputs.modules, max_parallel: 2 }\n    workspace: new'));
    const order = describingTool(bin, 5000);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(order().slice(0, 2).sort()).toEqual(['start api', 'start cli']);
  });

  it('answers items beside each other in a directory that is no git repository, where nothing checks them', async () => {
    const { config, workspace, runId, bin } = await answering(DESCRIBE('{ items: steps.plan.outputs.modules, max_parallel: 2 }\n    workspace: new'));
    fs.rmSync(path.join(workspace, '.git'), { recursive: true, force: true });
    const order = describingTool(bin, 5000);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(order().slice(0, 2).sort()).toEqual(['start api', 'start cli']);
  });

  it.each([{ maxParallel: undefined }, { maxParallel: 2 }])('gives each queued answer item its whole timeout, with workflows.max_parallel $maxParallel', async ({ maxParallel }) => {
    const { config, workspace, runId, bin } = await answering(`schemaVersion: v1alpha1
name: build
description: Describe each module.
steps:
  - id: plan
    command: echo '{"modules":["api","cli"]}'
    output: { modules: [string] }
  - id: describe
    needs: [plan]
    for_each: { items: steps.plan.outputs.modules, max_parallel: 2 }
    workflow:
      steps:
        - id: ask
          answer: "Describe {{ item }}."
          output: { text: string }
          timeout: 3s
`);
    if (maxParallel !== undefined) config.workflows = { tools: {}, max_parallel: maxParallel };
    claudeIn(bin, path.join(path.dirname(bin), 'home'), { answer: 'described', before: 'await new Promise((resolve) => setTimeout(resolve, 2000));' });

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
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
    const order = describingTool(bin, 100);

    expect(await runLocalDriver(config, runId, workspace)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const lines = order();
    expect(lines.slice(0, 4)).toEqual(['start api', 'end api', 'start cli', 'end cli']);
    expect(lines.slice(4)).toEqual(['start lint', 'end lint']);
  });
});
