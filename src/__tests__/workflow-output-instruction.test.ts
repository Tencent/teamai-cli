import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StartDriver } from '../workflow/conformance-interpreter.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { createLocalToolAdapter, type ToolSpawn } from '../workflow/drivers/local/local-tool-adapter.js';
import { startRun } from '../workflow/engine.js';
import { RunIdSchema } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';
import { skillHarness } from './helpers/skill-harness.js';

const PLAN = `schemaVersion: v1alpha1
name: plan-change
description: Plan a change.
steps:
  - id: plan
    prompt: Plan the change.
    output: { summary: string, tasks: [{ id: string, title: string, files: [string], after: [string] }], docs: boolean }
`;

/** The JSON Schema of PLAN's output, written out by hand: every declared field is required, extra keys are allowed. */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          after: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'files', 'after'],
      },
    },
    docs: { type: 'boolean' },
  },
  required: ['summary', 'tasks', 'docs'],
};

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The text each driver hands the agent that works PLAN's prompt step. A new driver fails the type check until it is here. */
const handedToAgent: Record<StartDriver, () => Promise<string>> = {
  local: async () => {
    const harness = await skillHarness({ 'plan-change': PLAN }, { aiTool: 'claude' });
    roots.push(harness.root);
    const started = await startRun(harness.config, 'plan-change', {}, { secrets: await knownSecrets(harness.config), checkout: harness.work });
    if (!('data' in started) || !('run' in started.data)) throw new Error(JSON.stringify(started));
    const prompts: string[] = [];
    // A tool that exits at once and writes nothing: only the prompt it was launched with matters here.
    const spawn: ToolSpawn = (_command, args, options) => {
      prompts.push(args[args.indexOf('-p') + 1] ?? '');
      return spawnProcess(process.execPath, ['-e', ''], options);
    };
    await runLocalDriver(harness.config, String(started.data.run), harness.work, { adapter: createLocalToolAdapter(spawn, () => 'claude') });
    return prompts.join('\n');
  },
  skill: async () => {
    const harness = await skillHarness({ 'plan-change': PLAN });
    roots.push(harness.root);
    const started = await harness.call({ kind: 'start', name: 'plan-change', answers: { confirmed: false }, inputs: undefined });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const chosen = await harness.call({ kind: 'choose', run: RunIdSchema.parse(started.data.turn.run), choice: 'h1' });
    if (!('data' in chosen) || !('turn' in chosen.data)) throw new Error(JSON.stringify(chosen));
    const [dispatch] = chosen.data.turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
    if (!dispatch) throw new Error(JSON.stringify(chosen));
    return fs.readFileSync(dispatch.brief, 'utf8');
  },
};

describe.each(Object.entries(handedToAgent))('a prompt step with an output under the %s driver', (_driver, handed) => {
  it('tells the agent the JSON Schema its output must match', async () => {
    const text = await handed();

    expect(text).toContain('Plan the change.');
    expect(text).toContain(JSON.stringify(PLAN_SCHEMA));
  });
});
