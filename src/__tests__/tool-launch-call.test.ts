import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createToolCaller } from '../tool-launch/call.js';
import { LocalConfigSchema, type LocalConfig } from '../types.js';

let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

const Invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string() });

/**
 * A fake tool on disk: it records how it was launched, prints `stdout` and `stderr`, and writes `lastMessage` to the
 * file after `-o`, as Codex does.
 */
async function fakeTool(name: string, { stdout = '', stderr = '', exitCode = 0, lastMessage }: { stdout?: string; stderr?: string; exitCode?: number; lastMessage?: string }): Promise<{ executable: string; invocation: () => Promise<z.infer<typeof Invocation>> }> {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const executable = path.join(root, name);
  const record = path.join(root, `${name}.json`);
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: process.env, stdin }));
  const last = ${JSON.stringify(lastMessage ?? null)};
  if (last !== null && args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], last);
  process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${exitCode});
});\n`, { mode: 0o755 });
  return { executable, invocation: async () => Invocation.parse(JSON.parse(await fs.readFile(record, 'utf8'))) };
}

/** A fake Claude that answers each prompt with the prompt itself, and fails a prompt that says `fail`. */
async function echoingClaude(): Promise<string> {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const executable = path.join(root, 'claude-echo');
  await fs.writeFile(executable, `#!${process.execPath}
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  const failed = stdin === 'fail';
  process.stdout.write(JSON.stringify({ type: 'result', is_error: failed, result: failed ? 'refused' : 'echo ' + stdin }));
  process.exit(failed ? 1 : 0);
});\n`, { mode: 0o755 });
  return executable;
}

function localConfig(fields: Record<string, unknown>): LocalConfig {
  return LocalConfigSchema.parse({ repo: { localPath: '/team', remote: 'https://example.com/team/repo.git' }, username: 'member', ...fields });
}

function only(tool: string, executable: string) {
  return createToolCaller({ resolveTool: (command) => command === tool ? executable : null, loadConfig: async () => null });
}

it('runs Claude headless with the prompt on stdin and returns its answer and tokens', async () => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'skills', session_id: 's1', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 } }) });
  vi.stubEnv('TEAMAI_LAUNCHED_TOOL', 'codex');
  vi.stubEnv('TEAMAI_LAUNCHED_CHECKOUT', '/outer-step');
  vi.stubEnv('TEAMAI_MODE', 'unattended');

  const answer = await only('claude', claude.executable).callTool('Classify this entry', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'skills', tool: 'claude', tokens: { input: 12, output: 3, cachedInput: 5 } });
  const { args, env, stdin } = await claude.invocation();
  expect(args).toEqual(['-p', '--output-format', 'json']);
  expect(stdin).toBe('Classify this entry');
  expect(env).toMatchObject({ TEAMAI_LAUNCHED_BY: 'recall-promote', TEAMAI_MODE: 'unattended', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1' });
  expect(env).not.toHaveProperty('TEAMAI_LAUNCHED_TOOL');
  expect(env).not.toHaveProperty('TEAMAI_LAUNCHED_CHECKOUT');
});

it('fails with the error Claude reports in its result, not its stderr tag', async () => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'There\'s an issue with the selected model (x).' }), stderr: '[claude-code:unrecognized_model] {}', exitCode: 1 });

  await expect(only('claude', claude.executable).callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ kind: 'call_failed', message: 'AI call failed (tool: claude): There\'s an issue with the selected model (x).' });
});

it('fails with no_tool when no tool teamai launches is on PATH', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const caller = createToolCaller({ resolveTool: () => null, loadConfig: async () => null });

  await expect(caller.callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ kind: 'no_tool', message: 'No AI tool teamai launches is on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw, or set TEAMAI_AI_TOOL to one you have.' });
});

it('runs Codex with the prompt on stdin, reads its last message from the -o file and its tokens from the turn', async () => {
  const codex = await fakeTool('codex', {
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'docs' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 2 } }),
    ].join('\n'),
    lastMessage: 'docs\n',
  });

  const answer = await only('codex', codex.executable).callTool('Classify this entry', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'docs', tool: 'codex', tokens: { input: 20, output: 2, cachedInput: 4 } });
  const { args, stdin } = await codex.invocation();
  expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  // Outside a git repo, as a CI job's bare checkout or a temp dir can be, Codex refuses to run without it.
  expect(args).toContain('--skip-git-repo-check');
  expect(args.at(-1)).toBe('-');
  expect(stdin).toBe('Classify this entry');
});

it('runs OpenCode with the prompt on stdin and joins the text parts it prints, with the step tokens', async () => {
  const opencode = await fakeTool('opencode', {
    stdout: [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'first line' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'second line' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 30, output: 6, cache: { read: 7 } } } }),
    ].join('\n'),
  });

  const answer = await only('opencode', opencode.executable).callTool('Summarize', { launchedBy: 'deep-enrich' });

  expect(answer).toEqual({ text: 'first line\nsecond line', tool: 'opencode', tokens: { input: 30, output: 6, cachedInput: 7 } });
  const { args, stdin } = await opencode.invocation();
  expect(args).toEqual(['run', '--format', 'json']);
  expect(stdin).toBe('Summarize');
});

it('runs WorkBuddy through the CodeBuddy adapter, which prints Claude\'s result record', async () => {
  const workbuddy = await fakeTool('workbuddy', { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'rules', usage: { input_tokens: 9, output_tokens: 1 } }) });

  const answer = await only('workbuddy', workbuddy.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'rules', tool: 'workbuddy', tokens: { input: 9, output: 1 } });
  expect((await workbuddy.invocation()).args).toEqual(['-p', '--output-format', 'json']);
});

it('runs OpenClaw as one embedded exec turn, with the prompt on stdin, and reads the JSON envelope', async () => {
  const openclaw = await fakeTool('openclaw', { stdout: JSON.stringify({ ok: true, status: 'ok', final: 'skills', usage: { input: 40, output: 3, total: 43 }, model: 'm', sessionId: 's' }, null, 2) });

  const answer = await only('openclaw', openclaw.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'skills', tool: 'openclaw', tokens: { input: 40, output: 3 } });
  const { args, stdin } = await openclaw.invocation();
  expect(args).toEqual(['agent', 'exec', '--json', '--message-file', '-']);
  expect(stdin).toBe('Classify');
});

it('fails with the error in OpenClaw\'s envelope', async () => {
  const openclaw = await fakeTool('openclaw', { stdout: JSON.stringify({ ok: false, status: 'error', error: { message: 'no provider key', kind: 'incomplete_turn' } }), exitCode: 1 });

  await expect(only('openclaw', openclaw.executable).callTool('Classify', { launchedBy: 'recall-promote' })).rejects.toThrow('AI call failed (tool: openclaw): no provider key');
});

it('runs the tool TEAMAI_AI_TOOL names, though an earlier tool in the launch order is on PATH', async () => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) });
  const codex = await fakeTool('codex', { lastMessage: 'from codex' });
  const onPath: Record<string, string> = { claude: claude.executable, codex: codex.executable };
  vi.stubEnv('TEAMAI_AI_TOOL', 'codex');

  const answer = await createToolCaller({ resolveTool: (command) => onPath[command] ?? null, loadConfig: async () => null }).callTool('hi', { launchedBy: 'codebase' });

  expect(answer).toMatchObject({ text: 'from codex', tool: 'codex' });
});

it('runs the tool ai.tool names when TEAMAI_AI_TOOL is unset, and TEAMAI_AI_TOOL over it', async () => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) });
  const codex = await fakeTool('codex', { lastMessage: 'from codex' });
  const opencode = await fakeTool('opencode', { stdout: JSON.stringify({ type: 'text', part: { text: 'from opencode' } }) });
  const onPath: Record<string, string> = { claude: claude.executable, codex: codex.executable, opencode: opencode.executable };
  const caller = () => createToolCaller({ resolveTool: (command) => onPath[command] ?? null, loadConfig: async () => localConfig({ ai: { tool: 'opencode' } }) });
  vi.stubEnv('TEAMAI_AI_TOOL', '');

  expect(await caller().callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ tool: 'opencode' });
  vi.stubEnv('TEAMAI_AI_TOOL', 'codex');
  expect(await caller().callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ tool: 'codex' });
});

it.each([
  { source: 'TEAMAI_AI_TOOL', named: 'gemini', message: 'TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches. Set it to one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw. Or unset it.' },
  { source: 'TEAMAI_AI_TOOL', named: 'codex', message: 'TEAMAI_AI_TOOL is "codex", which is not on PATH. Install codex, or unset TEAMAI_AI_TOOL to use the first installed tool.' },
  { source: 'TEAMAI_AI_TOOL', named: 'cursor', message: 'TEAMAI_AI_TOOL is "cursor", which is not a tool teamai launches.' },
  { source: 'ai.tool', named: 'gemini', message: 'ai.tool in /home/member/.teamai/config.yaml is "gemini", which is not a tool teamai launches. Set it to one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw. Or remove it.' },
  { source: 'ai.tool', named: 'codex', message: 'ai.tool in /home/member/.teamai/config.yaml is "codex", which is not on PATH. Install codex, or remove ai.tool to use the first installed tool.' },
] as const)('fails the call when $source names $named, rather than run another tool', async ({ source, named, message }) => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) });
  vi.stubEnv('TEAMAI_AI_TOOL', source === 'TEAMAI_AI_TOOL' ? named : '');
  vi.stubEnv('HOME', '/home/member');
  const caller = createToolCaller({ resolveTool: (command) => command === 'claude' ? claude.executable : null, loadConfig: async () => localConfig(source === 'ai.tool' ? { ai: { tool: named } } : {}) });

  await expect(caller.callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ name: 'CallError', kind: 'override_invalid', message: expect.stringContaining(message) });
});

it('fails a batch with the override error itself, before it runs any call', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', 'gemini');
  const { callToolParallel } = only('claude', await echoingClaude());

  await expect(callToolParallel(['a', 'b'].map((prompt) => ({ prompt, parse: (text: string) => text })), { launchedBy: 'import-local' })).rejects.toMatchObject({ name: 'CallError', kind: 'override_invalid' });
});

it('runs a batch of calls in input order and parses each answer', async () => {
  const { callToolParallel } = only('claude', await echoingClaude());

  const answers = await callToolParallel(['a', 'b', 'c', 'd'].map((prompt) => ({ prompt, parse: (text: string) => text.toUpperCase() })), { launchedBy: 'enrich-with-ai', concurrency: 2 });

  expect(answers).toEqual(['ECHO A', 'ECHO B', 'ECHO C', 'ECHO D']);
});

it('runs every call of a batch, then fails with each failure', async () => {
  const { callToolParallel } = only('claude', await echoingClaude());

  const batch = callToolParallel(['a', 'fail', 'c'].map((prompt) => ({ prompt, parse: (text: string) => text })), { launchedBy: 'import-local' });

  await expect(batch).rejects.toMatchObject({ message: '1 AI task(s) failed', errors: [expect.objectContaining({ message: 'AI call failed (tool: claude): refused' })] });
});
