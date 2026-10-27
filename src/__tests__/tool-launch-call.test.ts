import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { createToolCaller } from '../tool-launch/call.js';
import { getUserConfigPath, type LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

const Invocation = z.object({ args: z.array(z.string()), env: z.record(z.string()), stdin: z.string(), promptFile: z.string().nullable() });

/**
 * A fake tool on disk: it records how it was launched, with the file after `--prompt-file`, prints `stdout` and
 * `stderr`, and writes `lastMessage` to the file after `-o`, as Codex does.
 */
async function fakeTool(name: string, { stdout = '', stderr = '', exitCode = 0, lastMessage }: { stdout?: string; stderr?: string; exitCode?: number; lastMessage?: string }): Promise<{ executable: string; invocation: () => Promise<z.infer<typeof Invocation>> }> {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const executable = path.join(root, name);
  const record = path.join(root, `${name}.json`);
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const promptFile = args.includes('--prompt-file') ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : null;
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: process.env, stdin, promptFile }));
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

function only(tool: string, executable: string) {
  return createToolCaller({ resolveTool: (command) => command === tool ? executable : null, resolveScope: async () => undefined });
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

it.each([
  { stdout: '', stderr: 'Authentication failed\n', exitCode: 2, reason: 'Authentication failed' },
  { stdout: 'Provider rejected the request\n', stderr: '', exitCode: 1, reason: 'Provider rejected the request' },
  { stdout: ' \n', stderr: '\t', exitCode: 3, reason: 'exit code 3' },
])('fails a tool that exits $exitCode with $reason', async ({ stdout, stderr, exitCode, reason }) => {
  const hermes = await fakeTool('hermes', { stdout, stderr, exitCode });

  await expect(only('hermes', hermes.executable).callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ kind: 'call_failed', message: `AI call failed (tool: hermes): ${reason}` });
});

it('fails with no_tool when no tool teamai launches is on PATH', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const caller = createToolCaller({ resolveTool: () => null, resolveScope: async () => undefined });

  await expect(caller.callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ kind: 'no_tool', message: 'No AI tool teamai launches is on PATH. Install one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw, cursor, copilot, qoder, kiro, pi, omp, muse, hermes, or set TEAMAI_AI_TOOL to one you have.' });
});

it('picks the tool again on the next call when no tool was on PATH, so a long-lived process sees one installed since', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'ok' }) });
  let installed = false;
  const caller = createToolCaller({ resolveTool: (command) => installed && command === 'claude' ? claude.executable : null, resolveScope: async () => undefined });

  await expect(caller.callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ kind: 'no_tool' });
  installed = true;

  expect(await caller.callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ text: 'ok', tool: 'claude' });
});

it('runs TClaude as Claude Code and TCodex as Codex, each from its own executable', async () => {
  const tclaude = await fakeTool('tclaude', { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'from tclaude' }) });
  const tcodex = await fakeTool('tcodex', { lastMessage: 'from tcodex' });

  expect(await only('tclaude', tclaude.executable).callTool('hi', { launchedBy: 'codebase' })).toEqual({ text: 'from tclaude', tool: 'tclaude' });
  expect(await only('tcodex', tcodex.executable).callTool('hi', { launchedBy: 'codebase' })).toEqual({ text: 'from tcodex', tool: 'tcodex' });
  expect((await tclaude.invocation()).args).toEqual(['-p', '--output-format', 'json']);
  expect((await tcodex.invocation()).args.slice(0, 2)).toEqual(['exec', '--json']);
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

/** What `pi -p --mode json` prints: the turn's events, the assistant's reply in its `message_end`. */
function piEvents(assistant: Record<string, unknown>): string {
  return [
    { type: 'session', version: 3, id: 'session-1' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Classify' }] } },
    { type: 'message_end', message: { role: 'assistant', model: 'gpt-5.4', ...assistant } },
    { type: 'agent_settled', aborted: false },
  ].map((event) => JSON.stringify(event)).join('\n');
}

it('runs pi with the prompt on stdin, in an ephemeral session, and reads the assistant\'s reply and usage', async () => {
  const pi = await fakeTool('pi', { stdout: piEvents({ content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'skills' }], usage: { input: 30, output: 2, cacheRead: 8, totalTokens: 40 }, stopReason: 'stop' }) });

  const answer = await only('pi', pi.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'skills', tool: 'pi', tokens: { input: 30, output: 2, cachedInput: 8 } });
  const { args, stdin } = await pi.invocation();
  expect(args).toEqual(['-p', '--mode', 'json', '--no-session']);
  expect(stdin).toBe('Classify');
});

it('fails with the error pi reports on its reply, though pi exits 0', async () => {
  const pi = await fakeTool('pi', { stdout: piEvents({ content: [], stopReason: 'error', errorMessage: 'OpenAI API error (400): model_not_found' }) });

  await expect(only('pi', pi.executable).callTool('Classify', { launchedBy: 'recall-promote' })).rejects.toMatchObject({ kind: 'call_failed', message: 'AI call failed (tool: pi): OpenAI API error (400): model_not_found' });
});

it('runs omp as it runs pi, its fork, and reads the same events', async () => {
  const omp = await fakeTool('omp', { stdout: piEvents({ content: [{ type: 'text', text: 'docs' }], usage: { input: 5, output: 1 }, stopReason: 'stop' }) });

  const answer = await only('omp', omp.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'docs', tool: 'omp', tokens: { input: 5, output: 1 } });
  const { args, stdin } = await omp.invocation();
  expect(args).toEqual(['-p', '--mode', 'json', '--no-session']);
  expect(stdin).toBe('Classify');
});

/** What `muse exec --json` prints: an envelope per record, the answer in the run's terminal record. */
function museRecords(terminal: Record<string, unknown>): string {
  const record = (payloadType: string, payload: Record<string, unknown>) => JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: 'session-1' }, payload_type: payloadType, payload });
  return [
    record('turn.input.user', { kind: 'turn_input_user', prompt: 'Classify' }),
    record('run.output.delta', { kind: 'run_output_delta', text: 'rul' }),
    record('run.usage', { kind: 'run_usage', models: [{ model: 'm', input_tokens: 11, cached_tokens: 2, output_tokens: 3 }] }),
    record('run.terminal.completed', { kind: 'run_terminal', ...terminal }),
  ].join('\n');
}

it('runs muse exec with the prompt in a file, and reads the answer and usage of the run', async () => {
  const muse = await fakeTool('muse', { stdout: museRecords({ terminal: 'completed', text: 'rules', reason: null }) });

  const answer = await only('muse', muse.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'rules', tool: 'muse', tokens: { input: 11, output: 3, cachedInput: 2 } });
  const { args, stdin, promptFile } = await muse.invocation();
  expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  expect(args).toContain('--no-session-log');
  expect(promptFile).toBe('Classify');
  expect(stdin).toBe('');
});

it('fails with the reason a muse run ends without completing', async () => {
  const muse = await fakeTool('muse', { stdout: museRecords({ terminal: 'failed', text: null, reason: 'provider refused the request' }), exitCode: 1 });

  await expect(only('muse', muse.executable).callTool('Classify', { launchedBy: 'recall-promote' })).rejects.toMatchObject({ kind: 'call_failed', message: 'AI call failed (tool: muse): provider refused the request' });
});

it('runs Cursor through its cursor-agent executable, read-only, with the prompt on stdin', async () => {
  const cursor = await fakeTool('cursor-agent', { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'skills', session_id: 's1' }) });
  const caller = createToolCaller({ resolveTool: (command) => command === 'cursor-agent' ? cursor.executable : null, resolveScope: async () => undefined });

  const answer = await caller.callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'skills', tool: 'cursor' });
  const { args, stdin } = await cursor.invocation();
  expect(args).toEqual(['-p', '--output-format', 'json', '--mode', 'ask', '--trust']);
  expect(stdin).toBe('Classify');
});

it('runs Copilot with the prompt as its -p argument, silent, and reads the reply it prints', async () => {
  const copilot = await fakeTool('copilot', { stdout: 'docs\n' });

  const answer = await only('copilot', copilot.executable).callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'docs', tool: 'copilot' });
  const { args, stdin } = await copilot.invocation();
  expect(args).toEqual(['-p', 'Classify', '-s']);
  expect(stdin).toBe('');
});

it.each([
  { tool: 'qoder', executable: 'qodercli', args: ['-p', 'Classify'] },
  { tool: 'kiro', executable: 'kiro-cli', args: ['chat', '--no-interactive', 'Classify'] },
  { tool: 'hermes', executable: 'hermes', args: ['-z', 'Classify'] },
])('runs $tool through $executable with the prompt as an argument, and reads the reply it prints', async ({ tool, executable, args }) => {
  const fake = await fakeTool(executable, { stdout: 'rules\n' });
  const caller = createToolCaller({ resolveTool: (command) => command === executable ? fake.executable : null, resolveScope: async () => undefined });

  const answer = await caller.callTool('Classify', { launchedBy: 'recall-promote' });

  expect(answer).toEqual({ text: 'rules', tool });
  expect((await fake.invocation()).args).toEqual(args);
});

it('runs the tool TEAMAI_AI_TOOL names, though an earlier tool in the launch order is on PATH', async () => {
  const claude = await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) });
  const codex = await fakeTool('codex', { lastMessage: 'from codex' });
  const onPath: Record<string, string> = { claude: claude.executable, codex: codex.executable };
  vi.stubEnv('TEAMAI_AI_TOOL', 'codex');

  const answer = await createToolCaller({ resolveTool: (command) => onPath[command] ?? null, resolveScope: async () => undefined }).callTool('hi', { launchedBy: 'codebase' });

  expect(answer).toMatchObject({ text: 'from codex', tool: 'codex' });
});

/** A project install whose own config sets `project`, and ~/.teamai/config.yaml with `machine`; each written only when given. */
async function aiToolFiles({ project, machine }: { project?: string; machine?: string }, name = 'project'): Promise<{ scope: LocalConfig; projectFile: string; machineFile: string }> {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const dataHome = path.join(root, 'partitions', name);
  await fs.mkdir(dataHome, { recursive: true });
  const projectFile = path.join(dataHome, 'config.yaml');
  const machineFile = getUserConfigPath();
  await fs.mkdir(path.dirname(machineFile), { recursive: true });
  await fs.rm(machineFile, { force: true });
  onTestFinished(() => fs.rm(machineFile, { force: true }));
  const install = `repo:\n  localPath: ${root}\n  remote: local\nusername: member\nscope: workspace\n`;
  await fs.writeFile(projectFile, install + (project ? `ai:\n  tool: ${project}\n` : ''));
  if (machine) await fs.writeFile(machineFile, `ai:\n  tool: ${machine}\n`);
  const scope: LocalConfig = { repo: { localPath: root, remote: 'local' }, username: 'member', scope: 'project', projectRoot: root, dataHome, additionalRoles: [] };
  return { scope, projectFile, machineFile };
}

/** claude, codex and opencode on PATH, each answering with its own name. */
async function threeTools(): Promise<(command: string) => string | null> {
  const onPath: Record<string, string> = {
    claude: (await fakeTool('claude', { stdout: JSON.stringify({ type: 'result', result: 'from claude' }) })).executable,
    codex: (await fakeTool('codex', { lastMessage: 'from codex' })).executable,
    opencode: (await fakeTool('opencode', { stdout: JSON.stringify({ type: 'text', part: { text: 'from opencode' } }) })).executable,
  };
  return (command) => onPath[command] ?? null;
}

it.each([
  { env: 'codex', project: 'opencode', machine: 'claude', tool: 'codex', source: 'TEAMAI_AI_TOOL' },
  { env: '', project: 'opencode', machine: 'codex', tool: 'opencode', source: 'ai.tool (project)' },
  { env: '', project: undefined, machine: 'codex', tool: 'codex', source: 'ai.tool (machine)' },
  { env: '', project: undefined, machine: undefined, tool: 'claude', source: 'LAUNCH_ORDER' },
])('takes TEAMAI_AI_TOOL, then the project\'s ai.tool, then the machine\'s: $env / $project / $machine runs $tool, from $source', async ({ env, project, machine, tool, source }) => {
  vi.stubEnv('TEAMAI_AI_TOOL', env);
  const { scope } = await aiToolFiles({ project, machine });
  const debug = vi.spyOn(log, 'debug');
  onTestFinished(() => debug.mockRestore());

  const answer = await createToolCaller({ resolveTool: await threeTools(), resolveScope: async () => scope }).callTool('hi', { launchedBy: 'codebase' });

  expect(answer).toMatchObject({ tool, text: `from ${tool}` });
  expect(debug.mock.calls.flat()).toContainEqual(expect.stringMatching(new RegExp(`using ${tool} \\(.*\\), from ${source.replace(/[()]/g, '\\$&')}$`)));
});

it('takes only the machine\'s ai.tool for a call with no scope', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  await aiToolFiles({ project: 'opencode', machine: 'codex' });

  const answer = await createToolCaller({ resolveTool: await threeTools(), resolveScope: async () => undefined }).callTool('hi', { launchedBy: 'codebase' });

  expect(answer).toMatchObject({ tool: 'codex' });
});

it.each([
  { case: 'holds only ai', content: 'ai:\n  tool: codex\n' },
  { case: 'also has an unrelated key the full config refuses', content: 'username: 42\nai:\n  tool: codex\n' },
])('reads ai.tool from a ~/.teamai/config.yaml that $case', async ({ content }) => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const { machineFile } = await aiToolFiles({});
  await fs.writeFile(machineFile, content);

  const answer = await createToolCaller({ resolveTool: await threeTools(), resolveScope: async () => undefined }).callTool('hi', { launchedBy: 'codebase' });

  expect(answer).toMatchObject({ tool: 'codex' });
});

it('picks once per scope, so a process that works in two projects runs each project\'s tool', async () => {
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const first = await aiToolFiles({ project: 'opencode' }, 'first');
  const second = await aiToolFiles({ project: 'codex' }, 'second');
  let scope = first.scope;
  const caller = createToolCaller({ resolveTool: await threeTools(), resolveScope: async () => scope });

  expect(await caller.callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ tool: 'opencode' });
  scope = second.scope;
  expect(await caller.callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ tool: 'codex' });
  scope = first.scope;
  expect(await caller.callTool('hi', { launchedBy: 'codebase' })).toMatchObject({ tool: 'opencode' });
});

it.each([
  { level: 'TEAMAI_AI_TOOL', named: 'gemini', message: () => 'TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches. Set it to one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw, cursor, copilot, qoder, kiro, pi, omp, muse, hermes. Or unset it.' },
  { level: 'TEAMAI_AI_TOOL', named: 'kiro', message: () => 'TEAMAI_AI_TOOL is "kiro", which is not on PATH. Install kiro, or unset TEAMAI_AI_TOOL to use the next setting or the first installed tool.' },
  { level: 'TEAMAI_AI_TOOL', named: 'trae', message: () => 'TEAMAI_AI_TOOL is "trae", which is not a tool teamai launches.' },
  { level: 'project', named: 'gemini', message: (file: string) => `ai.tool in ${file} is "gemini", which is not a tool teamai launches. Set it to one of: claude, claude-internal, tclaude, codex, codex-internal, tcodex, opencode, codebuddy, workbuddy, openclaw, cursor, copilot, qoder, kiro, pi, omp, muse, hermes. Or remove it.` },
  { level: 'project', named: 'kiro', message: (file: string) => `ai.tool in ${file} is "kiro", which is not on PATH. Install kiro, or remove it to use the next setting or the first installed tool.` },
  { level: 'machine', named: 'kiro', message: (file: string) => `ai.tool in ${file} is "kiro", which is not on PATH. Install kiro, or remove it to use the next setting or the first installed tool.` },
] as const)('fails the call when $level names $named, naming the setting to change, rather than run another tool', async ({ level, named, message }) => {
  vi.stubEnv('TEAMAI_AI_TOOL', level === 'TEAMAI_AI_TOOL' ? named : '');
  const { scope, projectFile, machineFile } = await aiToolFiles({ project: level === 'project' ? named : undefined, machine: level === 'machine' ? named : 'opencode' });
  const caller = createToolCaller({ resolveTool: await threeTools(), resolveScope: async () => scope });

  await expect(caller.callTool('hi', { launchedBy: 'codebase' })).rejects.toMatchObject({ name: 'CallError', kind: 'override_invalid', message: expect.stringContaining(message(level === 'project' ? projectFile : machineFile)) });
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

it('stops a call that outlives its timeout and fails with the timeout', async () => {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const hanging = path.join(root, 'claude-hang');
  await fs.writeFile(hanging, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });

  await expect(only('claude', hanging).callTool('hi', { launchedBy: 'codebase', timeout: 600 })).rejects.toMatchObject({ kind: 'call_failed', message: 'AI call timed out after 1s (tool: claude)' });
});

it.runIf(process.platform !== 'win32')("keeps a call in teamai's process group, so Ctrl-C in the terminal stops it too", async () => {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const reporting = path.join(root, 'claude-group');
  await fs.writeFile(reporting, `#!${process.execPath}
const group = require('child_process').execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
process.stdout.write(JSON.stringify({ type: 'result', result: group }));
`, { mode: 0o755 });
  const { execFileSync } = await import('node:child_process');
  const ours = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();

  const { text } = await only('claude', reporting).callTool('hi', { launchedBy: 'codebase' });

  expect(text).toBe(ours);
});

it('runs no more calls of a batch at once than its concurrency', async () => {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-call-'));
  const running = path.join(root, 'running');
  await fs.mkdir(running);
  const counting = path.join(root, 'claude-count');
  // Each call marks itself running, answers with how many calls run beside it, and unmarks itself before it exits.
  await fs.writeFile(counting, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const mark = path.join(${JSON.stringify(running)}, String(process.pid));
fs.writeFileSync(mark, '');
setTimeout(() => {
  const count = fs.readdirSync(${JSON.stringify(running)}).length;
  fs.rmSync(mark);
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: String(count) }));
}, 150);\n`, { mode: 0o755 });

  const counts = await only('claude', counting).callToolParallel(Array.from({ length: 5 }, (_, index) => ({ prompt: String(index), parse: Number })), { launchedBy: 'enrich-with-ai', concurrency: 2 });

  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
});

it('runs every call of a batch, then fails with each failure', async () => {
  const { callToolParallel } = only('claude', await echoingClaude());

  const batch = callToolParallel(['a', 'fail', 'c'].map((prompt) => ({ prompt, parse: (text: string) => text })), { launchedBy: 'import-local' });

  await expect(batch).rejects.toMatchObject({ message: '1 AI task(s) failed', errors: [expect.objectContaining({ message: 'AI call failed (tool: claude): refused' })] });
});
