import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createToolCaller } from '../tool-launch/call.js';

let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

const Invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string() });

/** A fake tool on disk: it records how it was launched to `invocation.json`, then prints `stdout`. */
async function fakeTool(name: string, stdout: string, exitCode = 0, stderr = ''): Promise<{ executable: string; invocation: () => Promise<z.infer<typeof Invocation>> }> {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const executable = path.join(root, name);
  const record = path.join(root, `${name}.json`);
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, stdin }));
  process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${exitCode});
});\n`, { mode: 0o755 });
  return { executable, invocation: async () => Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8'))) };
}

it('runs Claude headless with the prompt on stdin and returns its answer and tokens', async () => {
  const claude = await fakeTool('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'skills', session_id: 's1', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 } }));
  vi.stubEnv('TEAMAI_LAUNCHED_TOOL', 'codex');
  vi.stubEnv('TEAMAI_LAUNCHED_CHECKOUT', '/outer-step');
  vi.stubEnv('TEAMAI_MODE', 'unattended');
  const { callTool } = createToolCaller({ resolveTool: (command) => command === 'claude' ? claude.executable : null, loadConfig: async () => null });

  const answer = await callTool('Classify this entry', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'skills', tool: 'claude', tokens: { input: 12, output: 3, cachedInput: 5 } });
  const { args, env, stdin } = await claude.invocation();
  expect(args).toEqual(['-p', '--output-format', 'json']);
  expect(stdin).toBe('Classify this entry');
  expect(env).toMatchObject({ TEAMAI_LAUNCHED_BY: 'recall-promote', TEAMAI_MODE: 'unattended', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1' });
  expect(env).not.toHaveProperty('TEAMAI_LAUNCHED_TOOL');
  expect(env).not.toHaveProperty('TEAMAI_LAUNCHED_CHECKOUT');
});

it('fails with the error Claude reports in its result, not its stderr tag', async () => {
  const claude = await fakeTool('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'There\'s an issue with the selected model (x).' }), 1, '[claude-code:unrecognized_model] {}');
  const { callTool } = createToolCaller({ resolveTool: (command) => command === 'claude' ? claude.executable : null, loadConfig: async () => null });

  await expect(callTool('hi', { launchedBy: 'codebase' })).rejects.toThrow('AI call failed (tool: claude): There\'s an issue with the selected model (x).');
});
