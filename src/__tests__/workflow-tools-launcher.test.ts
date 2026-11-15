import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, constants, openSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { type ToolSpawn } from '@teamai/runtime-tools';
import { launchEnv } from '../launch-context.js';
import { expectedOutput } from '../workflow/output.js';
import { hostLauncher } from './helpers/host-launcher.js';

const files: string[] = [];

function child(stdout: string | Buffer[], exitCode = 0) {
  const stdoutEmitter = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  const childProcess = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  childProcess.stdout = stdoutEmitter;
  childProcess.stderr = stderr;
  queueMicrotask(() => {
    childProcess.emit('spawn');
    for (const chunk of typeof stdout === 'string' ? [Buffer.from(stdout)] : stdout) stdoutEmitter.emit('data', chunk);
    childProcess.emit('close', exitCode);
  });
  return childProcess;
}

/** A tool that writes `body` to `resultPath` as it starts, then runs as `spawned` does. */
function writing(resultPath: string, body: unknown, spawned: () => ReturnType<typeof child>) {
  return () => {
    writeFileSync(resultPath, JSON.stringify(body));
    return spawned();
  };
}

/**
 * A tool that prints `lines` and then works on until it is stopped, as a tool in the middle of its work does: a real
 * process, started with the options the launcher starts a tool with (in a process group of its own), so the launcher's
 * stop reaches it as it reaches a tool. Stopped, it takes `closesAfterMs` to close.
 */
function workingTool(lines: readonly string[], { closesAfterMs = 0 }: { closesAfterMs?: number } = {}): ToolSpawn {
  const script = `for (const line of JSON.parse(process.argv[1])) process.stdout.write(line + '\\n');
const closesAfterMs = Number(process.argv[2]);
if (closesAfterMs > 0) process.on('SIGTERM', () => setTimeout(() => process.exit(143), closesAfterMs));
setInterval(() => {}, 1000);`;

  return (_command, _args, options) => spawn(process.execPath, ['-e', script, JSON.stringify(lines), String(closesAfterMs)], options);
}

/** A tool that prints nothing and exits on its own after `exitsAfterMs`, which needs no stop. */
function exitingChild(exitsAfterMs: number) {
  const childProcess = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume: () => undefined }) });
  queueMicrotask(() => childProcess.emit('spawn'));
  setTimeout(() => childProcess.emit('close', 0), exitsAfterMs);
  return childProcess;
}

/** What `claude -p --output-format stream-json --verbose` prints: an `init` event naming the session's model, then the result. */
function claudeStream(model: string | undefined, result: Record<string, unknown>): string {
  const init = { type: 'system', subtype: 'init', session_id: 'session-1', ...(model ? { model } : {}) };
  return `${JSON.stringify(init)}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...result })}\n`;
}

/** What a step that declares no output asks its tool for. */
const expected = expectedOutput(undefined);

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })));
});

describe('the tools launcher', () => {
  it.each([
    ['leaves failure out', {}, undefined],
    ['writes failure as null', { failure: null }, undefined],
    ['writes a failure', { failure: { code: 'blocked', message: 'No access.' } }, { code: 'blocked', message: 'No access.' }],
  ])('reads the result file a tool wrote when it %s', async (_case, written, failure) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-failure-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const output = { summary: 'Done.' };
    const adapter = hostLauncher(writing(resultPath, { output, ...written }, () => child(claudeStream('claude-sonnet', { result: 'Wrote the result file.' }))) as unknown as ToolSpawn, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(result).toMatchObject({ started: true, exitCode: 0, output });
    expect(result.failure).toEqual(failure);
  });

  it.skipIf(process.platform === 'win32')('fails the step at once when the tool left a FIFO at its result path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-workflow-fifo-'));
    files.push(dir);
    const resultPath = path.join(dir, 'result.json');
    execFileSync('mkfifo', [resultPath]);
    const adapter = hostLauncher(() => child(claudeStream('claude-sonnet', { result: 'Done.' })) as ReturnType<ToolSpawn>, () => 'claude');
    const late = new Promise<'still waiting'>((resolve) => { setTimeout(() => resolve('still waiting'), 2_000).unref(); });

    const settled = await Promise.race([adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {} }), late]);

    // A read the FIFO still holds ends once a writer opens it and closes, so a failing run leaves no stuck read.
    if (settled === 'still waiting') closeSync(openSync(resultPath, constants.O_WRONLY | constants.O_NONBLOCK));
    expect(settled).toMatchObject({ started: true, failure: { code: 'tool_failed', message: `claude left a pipe at its result path, ${resultPath}, not a regular file, so teamai did not read it` } });
  });

  it('asks the tool to leave failure out of the result file unless the step failed', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-instruction-${Date.now()}.json`);
    files.push(resultPath);
    let prompt = '';
    const adapter = hostLauncher((_command, args) => {
      prompt = args.join(' ');
      return child(claudeStream('claude-sonnet', { result: '{}' })) as ReturnType<ToolSpawn>;
    }, () => 'claude');

    await adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(prompt).toContain('Leave failure out unless the step failed');
    expect(prompt).not.toContain('"code":"optional"');
  });

  it('preserves UTF-8 split across stdout chunks in the result and persisted fallback', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-utf8-${Date.now()}.json`);
    files.push(resultPath);
    const output = { summary: '检查完成 café 😀' };
    const bytes = Buffer.from(claudeStream('claude-sonnet', { result: JSON.stringify(output) }));
    const chunks = Array.from(bytes, (_byte, index) => bytes.subarray(index, index + 1));
    const adapter = hostLauncher(() => child(chunks) as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(result).toMatchObject({ started: true, exitCode: 0, output });
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toEqual({ output });
  });

  it('masks the run\'s secrets in the result it keeps from stdout, before anything else reads the file', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-masked-${Date.now()}.json`);
    files.push(resultPath);
    const stdout = claudeStream('claude-sonnet', { result: JSON.stringify({ summary: 'Used tm-deploy-credential-2291 to deploy.' }) });
    const adapter = hostLauncher(() => child(stdout) as ReturnType<ToolSpawn>, () => 'claude');

    await adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: { DEPLOY_TOKEN: 'tm-deploy-credential-2291' } });

    const kept = await fs.readFile(resultPath, 'utf8');
    expect(kept).toContain('to deploy.');
    expect(kept).not.toContain('tm-deploy-credential-2291');
  });

  it('starts the resolved executable and ignores token counts written into result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-result-${Date.now()}.json`);
    files.push(resultPath);
    const written = { output: { ok: true }, model: 'invented', session: 'invented-session', tokens: { input: 999, output: 999 } };
    const spawnTool = vi.fn(writing(resultPath, written, () => child(claudeStream('claude-sonnet', {
      session_id: 'session-1',
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      result: JSON.stringify({ ok: false }),
    })))) as unknown as ToolSpawn;
    const resolveTool = vi.fn(() => 'C:\\npm\\claude.cmd');
    const adapter = hostLauncher(spawnTool, resolveTool);

    const result = await adapter.run('claude-internal', {
      prompt: 'Review the change.', expected,
      cwd: os.tmpdir(),
      resultPath, secrets: {},
    });

    expect(resolveTool).toHaveBeenCalledWith('claude-internal');
    expect(spawnTool).toHaveBeenCalledWith(
      'C:\\npm\\claude.cmd',
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose']),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(result).toMatchObject({
      output: { ok: true },
      model: 'claude-sonnet',
      session: 'session-1',
      tokens: { input: 4, output: 2, cachedInput: 1 },
    });
    expect(result.started && result.model).not.toBe('invented');
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toMatchObject({
      output: { ok: true },
      tokens: { input: 999, output: 999 },
    });
  });

  it('starts a tool instance\'s own command where the PATH-only lookup finds it, never where the tool lookup does', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-instance-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', { result: '{}' }))) as unknown as ToolSpawn;
    // On Windows the tool lookup searches the checkout first, where a step may have written acme-claude.cmd.
    const adapter = hostLauncher(spawnTool, (command) => `C:\\checkout\\${command}.cmd`, (command) => (command === 'acme-claude' ? 'C:\\Tools\\acme\\acme-claude.cmd' : null));

    await adapter.run('claude', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, instance: { name: 'acme-claude', command: 'acme-claude' } });

    expect(spawnTool).toHaveBeenCalledWith('C:\\Tools\\acme\\acme-claude.cmd', expect.any(Array), expect.anything());
  });

  it.each([
    ['its own command', { name: 'acme-claude', command: 'acme-claude' }],
    ['the command of the tool it extends', { name: 'claude-work' }],
  ])('names a tool instance that runs %s by the instance\'s name when the step fails', async (_case, instance) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-instance-failed-${Date.now()}.json`);
    files.push(resultPath);
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet' });
    const adapter = hostLauncher(() => child(`${init}\n`) as unknown as ReturnType<ToolSpawn>, () => 'claude', (command) => command);

    const result = await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, instance });

    expect(result.failure).toEqual({ code: 'tool_failed', message: `${instance.name} did not write a valid workflow result` });
  });

  // OpenCode works in PWD rather than its cwd, so a trial launched with the caller's PWD edits the caller's checkout.
  it('tells the tool its working directory through PWD as well as its cwd', async () => {
    const cwd = path.join(os.tmpdir(), 'teamai-trial-clone');
    const spawnTool = vi.fn(() => child('{}')) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => 'opencode');

    await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd, env: { ...process.env, PWD: '/member/checkout' }, resultPath: path.join(cwd, 'result.json'), secrets: {} });

    expect(spawnTool).toHaveBeenCalledWith('opencode', expect.any(Array), expect.objectContaining({ cwd, env: expect.objectContaining({ PWD: cwd }) }));
  });

  it('runs a WorkBuddy step on CodeBuddy\'s Claude-like flags, without --effort, and reads its session and tokens', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-codebuddy-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('glm-5', { session_id: 'session-2', usage: { input_tokens: 7, output_tokens: 3 }, result: JSON.stringify({ ok: true }) }))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => '/bin/workbuddy');

    const result = await adapter.run('workbuddy', { prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, model: { name: 'glm-5', effort: 'high' }, resume: 'session-1', maxTurns: 3 });

    const args = vi.mocked(spawnTool).mock.calls[0]?.[1] ?? [];
    expect(args.slice(0, 1)).toEqual(['-p']);
    for (const [flag, value] of [['--output-format', 'stream-json'], ['--model', 'glm-5'], ['--resume', 'session-1'], ['--max-turns', '3']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--effort');
    expect(result).toMatchObject({ output: { ok: true }, session: 'session-2', tokens: { input: 7, output: 3 } });
  });

  it('runs an agy step in print mode with its model, effort, agent and conversation, and reads its stream-json events', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-agy-${Date.now()}.json`);
    files.push(resultPath);
    // As agy 1.4.8 prints `--output-format=stream-json`: the init event names the model, the result the conversation and usage.
    const stdout = [
      { event: 'init', conversation_id: 'conv-2', init: { model: 'gemini-3.8-flash-high', cwd: os.tmpdir() } },
      { event: 'step_update', step_update: { conversation_id: 'conv-2', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '{"ok":true}' } },
      { event: 'result', result: { conversation_id: 'conv-2', status: 'SUCCESS', response: '{"ok":true}', usage: { input_tokens: 15000, output_tokens: 40, cache_read_tokens: 9000 } } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    const spawnTool = vi.fn(() => child(stdout)) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => '/bin/agy');

    const result = await adapter.run('agy', {
      prompt: 'Review.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, model: { name: 'gemini-3.8-flash', effort: 'high' }, resume: 'conv-1',
      agent: { name: 'reviewer', instructions: 'Review the change.' },
    });

    const args = vi.mocked(spawnTool).mock.calls[0]?.[1] ?? [];
    for (const [flag, value] of [['--model', 'gemini-3.8-flash'], ['--effort', 'high'], ['--conversation', 'conv-1'], ['--agent', 'reviewer']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
    expect(args).toContain('--output-format=stream-json');
    // `--print=` keeps the prompt attached: agy takes a bare `-p`'s next argument as the prompt even when it is a flag.
    expect(args.at(-1)).toMatch(/^--print=Review\.\n\nWrite the workflow result as JSON to /);
    expect(result).toMatchObject({ output: { ok: true }, model: 'gemini-3.8-flash-high', session: 'conv-2', tokens: { input: 15000, output: 40, cachedInput: 9000 } });
  });

  // Each flag as the tool's own --help or docs name its mode for editing and running commands without asking.
  it.each([
    ['claude', ['--permission-mode', 'bypassPermissions']],
    ['claude-internal', ['--permission-mode', 'bypassPermissions']],
    ['codebuddy', ['--permission-mode', 'bypassPermissions']],
    ['workbuddy', ['--permission-mode', 'bypassPermissions']],
    ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
    ['opencode', ['--auto']],
    ['agy', ['--dangerously-skip-permissions']],
  ] as const)('launches %s unattended with %j, headless and interactive, and never without asking for it', async (tool, flags) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-unattended-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child('')) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => `/bin/${tool}`);
    const input = { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, resume: 'session-1' };

    await adapter.run(tool, { ...input, unattended: true });
    await adapter.runInteractive(tool, { ...input, unattended: true });
    await adapter.run(tool, input);

    const [headless, interactive, asked] = vi.mocked(spawnTool).mock.calls.map((call) => call[1]);
    for (const args of [headless, interactive]) {
      const at = args?.indexOf(flags[0]) ?? -1;
      expect(args?.slice(at, at + flags.length)).toEqual([...flags]);
    }
    expect(asked).not.toContain(flags[0]);
  });

  it('passes maxTurns to headless Claude as --max-turns', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-turns-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', { result: JSON.stringify({ ok: true }) }))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => 'claude');

    await adapter.run('claude', { prompt: 'Plan.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, maxTurns: 3 });

    expect(spawnTool).toHaveBeenCalledWith('claude', expect.arrayContaining(['-p', '--max-turns', '3']), expect.anything());
  });

  // Claude's default mode asks before every write, so an attended step asked for this one and an unattended one failed.
  // CodeBuddy takes the same --allowedTools rule (codebuddy.ai/docs/cli/iam: `Edit(//abs/path)`).
  // The result file's directory is the attempt's out/, where the step also leaves the evidence archived with its session.
  it.each([['headless', 'claude', false], ['interactive', 'claude', true], ['headless', 'codebuddy', false], ['interactive', 'codebuddy', true]] as const)('lets %s %s write in the result file\'s directory, and only there, without asking', async (_, tool, interactive) => {
    const out = path.join(os.tmpdir(), `teamai-workflow-grant-${tool}-${String(interactive)}-${Date.now()}`);
    const resultPath = path.join(out, 'result.json');
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(interactive ? '' : claudeStream('claude-sonnet', { result: JSON.stringify({ ok: true }) }))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => tool);
    const input = { prompt: 'Plan.', expected, cwd: os.tmpdir(), resultPath, secrets: {} };

    await (interactive ? adapter.runInteractive(tool, input) : adapter.run(tool, input));

    const args = vi.mocked(spawnTool).mock.calls[0]?.[1] ?? [];
    // One argument: the flag is variadic, so a separate value would take the interactive prompt after it as a rule too.
    expect(args).toContain(`--allowedTools=Edit(/${out}/**)`);
    expect(interactive ? args.at(-1) : args[args.indexOf('-p') + 1]).toContain('Plan.');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it.each([
    ['stopped at its --max-turns cap', 'error_max_turns', 1, true],
    ['ran to the end', 'success', 0, undefined],
  ])('says whether headless Claude %s', async (_, subtype, exitCode, stoppedAtMaxTurns) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-turns-${subtype}-${Date.now()}.json`);
    files.push(resultPath);
    const adapter = hostLauncher(() => child(claudeStream('claude-sonnet', { subtype, is_error: exitCode !== 0 }), exitCode) as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Plan.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, maxTurns: 3 });

    expect(result).toMatchObject({ started: true, exitCode });
    expect(result.started && result.stoppedBy).toBe(stoppedAtMaxTurns ? 'max_turns' : undefined);
  });

  it.each([
    // As Claude streams with --include-partial-messages: an assistant event repeats the usage of its message's start, and
    // the message's message_delta states its final usage.
    ['headless Claude, counting each message at its final usage', 'claude', [
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 500 } } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 500 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 500 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 30, output_tokens: 50, cache_read_input_tokens: 500 } } }),
    ]],
    // A message_delta may state only what changed since the message's start; the rest keeps the start's value.
    ['headless Claude, whose message_delta states only output tokens', 'claude', [
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } }),
    ]],
    ['OpenCode, counting each finished step', 'opencode', [
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 10, output: 20, cache: { read: 500 } } } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 30, output: 50, cache: { read: 500 } } } }),
    ]],
  ] as const)('stops %s, once the tokens its stdout states pass the budget, and reports them', async (_, tool, lines) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-budget-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const adapter = hostLauncher(workingTool(lines), () => tool);

    const result = await adapter.run(tool, { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, budget: 100 });

    expect(result).toMatchObject({ started: true, stoppedBy: 'budget', tokens: { input: 40, output: 70, cachedInput: 1000 } });
  });

  it('stops a tool still running at its timeout, and says the timeout stopped it', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-timeout-${Date.now()}.json`);
    files.push(resultPath);
    const adapter = hostLauncher(workingTool([]), () => 'codex');

    const result = await adapter.run('codex', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, timeoutMs: 20 });

    expect(result).toMatchObject({ started: true, stoppedBy: 'timeout' });
  });

  it('keeps the model and session of a Claude stopped before its final result, and states no tokens it did not print', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-timeout-init-${Date.now()}.json`);
    files.push(resultPath);
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet' });
    const adapter = hostLauncher(workingTool([init]), () => 'claude');

    // Long enough for a started process to print its init event first.
    const result = await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, timeoutMs: 2_000 });

    expect(result).toMatchObject({ started: true, stoppedBy: 'timeout', model: 'claude-sonnet', session: 'session-1' });
    expect(result.started && result.tokens).toBeUndefined();
  });

  it('keeps the error a failed tool printed out of the result file it falls back to, since it may echo a credential', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-tool-error-${Date.now()}.json`);
    files.push(resultPath);
    const token = 'adapter-test-token-3c1d';
    const refused = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Failed to authenticate. API Error: 401 Invalid bearer token ${token}`, session_id: 'session-1' });
    const adapter = hostLauncher(() => child(`${refused}\n`, 1) as unknown as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, env: { TOY_TEAM: token }, secrets: {} });

    // The driver masks the reason it reports; the file the adapter wrote holds only the status.
    expect(result).toMatchObject({ exitCode: 1, failure: { code: 'tool_failed', message: `claude exited with status 1: Failed to authenticate. API Error: 401 Invalid bearer token ${token}` } });
    expect(await fs.readFile(resultPath, 'utf8')).not.toContain(token);
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toEqual({ failure: { code: 'tool_failed', message: 'claude exited with status 1' } });
  });

  it('fails a Claude that exits 0 after its init event with no final result, as one that wrote no result', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-init-only-${Date.now()}.json`);
    files.push(resultPath);
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet' });
    const adapter = hostLauncher(() => child(`${init}\n`) as unknown as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(result).toMatchObject({ started: true, exitCode: 0, failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('says the budget stopped a tool that passed it, though the tool closed only after its timeout', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-budget-slow-${Date.now()}.json`);
    files.push(resultPath);
    const over = JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 60, output: 60 } } });
    // The timeout comes after the line that passes the budget, and before the tool, stopped for it, closes.
    const adapter = hostLauncher(workingTool([over], { closesAfterMs: 3_000 }), () => 'opencode');

    const result = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, budget: 100, timeoutMs: 2_000 });

    expect(result).toMatchObject({ started: true, stoppedBy: 'budget' });
  });

  it('names no stop for a tool that exited on its own as its timeout came', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-timeout-exit-${Date.now()}.json`);
    files.push(resultPath);
    const adapter = hostLauncher(() => exitingChild(30) as unknown as ReturnType<ToolSpawn>, () => 'codex');

    const result = await adapter.run('codex', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, timeoutMs: 30 });

    expect(result).toMatchObject({ started: true, exitCode: 0 });
    expect(result.started && result.stoppedBy).toBeUndefined();
  });

  it.each([
    ['with a budget, streams partial messages', 100, true],
    ['without one, does not', undefined, false],
  ] as const)('headless Claude %s, whose message_delta events state each message\'s final usage', async (_, budget, streams) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-partial-${String(budget)}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', { result: JSON.stringify({ ok: true }) }))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => 'claude');

    await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, ...(budget !== undefined ? { budget } : {}) });

    const args = vi.mocked(spawnTool).mock.calls[0]?.[1] ?? [];
    expect(args.includes('--include-partial-messages')).toBe(streams);
  });

  it('lets a tool under its budget run to the end, with the tokens it stated', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-budget-under-${Date.now()}.json`);
    files.push(resultPath);
    const stdout = claudeStream('claude-sonnet', { usage: { input_tokens: 40, output_tokens: 60 } });
    const adapter = hostLauncher(() => child(stdout) as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, budget: 100 });

    expect(result).toMatchObject({ started: true, exitCode: 0, tokens: { input: 40, output: 60 } });
    expect(result.started && result.stoppedBy).toBeUndefined();
  });

  it('writes the Claude stdout fallback when the tool does not write result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-fallback-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', {
      session_id: 'session-1',
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      result: JSON.stringify({ ok: true }),
    }))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => 'claude');

    const result = await adapter.run('claude', {
      prompt: 'Review the change.', expected,
      cwd: os.tmpdir(),
      resultPath, secrets: {},
    });

    expect(result).toMatchObject({
      output: { ok: true },
      model: 'claude-sonnet',
      session: 'session-1',
      tokens: { input: 4, output: 2, cachedInput: 1 },
    });
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toEqual({ output: { ok: true } });
  });

  it('reads Codex and OpenCode stdout for model, session, and tokens', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-codex-${Date.now()}.json`);
    files.push(resultPath);
    const written = { output: { ok: true }, model: 'invented', session: 'invented-session', tokens: { input: 999, output: 999 } };
    const codexStdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1', model: 'gpt-5.4' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, cached_input_tokens: 3, output_tokens: 2 } }),
    ].join('\n');
    const spawnTool = vi.fn(writing(resultPath, written, () => child(codexStdout))) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => '/usr/bin/codex');

    const codex = await adapter.run('codex-internal', {
      prompt: 'Review the change.', expected,
      cwd: os.tmpdir(),
      resultPath, secrets: {},
      agent: { name: 'reviewer', instructions: 'Read only.', model: 'gpt-5.4' },
    });

    expect(spawnTool).toHaveBeenCalledWith(
      '/usr/bin/codex',
      expect.arrayContaining(['exec', '--json', '--model', 'gpt-5.4']),
      expect.anything(),
    );
    expect(codex).toMatchObject({
      output: { ok: true },
      model: 'gpt-5.4',
      session: 'thread-1',
      tokens: { input: 8, output: 2, cachedInput: 3 },
    });

    const opencodePath = path.join(os.tmpdir(), `teamai-workflow-opencode-${Date.now()}.json`);
    files.push(opencodePath);
    const opencodeStdout = [
      JSON.stringify({ type: 'session.created', properties: { info: { id: 'ses_1' } } }),
      JSON.stringify({ type: 'message.updated', properties: { info: { sessionID: 'ses_1', modelID: 'claude-sonnet-4' } } }),
      JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'step-finish', tokens: { input: 11, output: 4, cache: { read: 6 } } } } }),
    ].join('\n');
    const opencodeSpawn = vi.fn(writing(opencodePath, { output: { ok: true }, tokens: { input: 999 } }, () => child(opencodeStdout))) as unknown as ToolSpawn;
    const opencode = hostLauncher(opencodeSpawn, () => '/usr/bin/opencode');

    const opened = await opencode.run('opencode', {
      prompt: 'Review the change.', expected,
      cwd: os.tmpdir(),
      resultPath: opencodePath, secrets: {},
      agent: { name: 'reviewer', instructions: 'Read only.' },
    });

    expect(opencodeSpawn).toHaveBeenCalledWith(
      '/usr/bin/opencode',
      expect.arrayContaining(['run', '--format', 'json', '--agent', 'reviewer']),
      expect.anything(),
    );
    expect(opened).toMatchObject({
      output: { ok: true },
      model: 'claude-sonnet-4',
      session: 'ses_1',
      tokens: { input: 11, output: 4, cachedInput: 6 },
    });
  });

  it('adds up the cost OpenCode states on each finished step', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-opencode-cost-${Date.now()}.json`);
    files.push(resultPath);
    const stdout = [
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', cost: 0.25, tokens: { input: 10, output: 2 } } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', cost: 0.5, tokens: { input: 6, output: 1 } } }),
    ].join('\n');
    const adapter = hostLauncher(vi.fn(() => child(stdout)) as unknown as ToolSpawn, () => '/usr/bin/opencode');

    const ran = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran).toMatchObject({ session: 'ses_1', tokens: { input: 16, output: 3 }, cost: { amount: 0.75, unit: 'USD' } });
  });

  // OpenCode 2.2.5 prints `{"type":"error","error":{"type":"provider.<kind>","message":…}}` and exits 1; 1.3.x exits 0.
  it.each([
    ['a rate limit, exiting 1', 'provider.rate-limit', 'Rate limit exceeded', 1],
    ['its free usage limit, exiting 0', 'provider.free-limit', 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.', 0],
    ['a provider quota, exiting 1', 'provider.quota', 'Quota exceeded', 1],
  ])('fails usage_limited when OpenCode stops on %s', async (_case, type, message, exitCode) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-opencode-limit-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const stdout = JSON.stringify({ type: 'error', timestamp: 1794142734400, sessionID: 'ses_1', error: { type, message } });
    const adapter = hostLauncher(vi.fn(() => child(stdout, exitCode)) as unknown as ToolSpawn, () => '/usr/bin/opencode');

    const ran = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran.failure).toEqual({ code: 'usage_limited', message: `opencode hit its usage limit: ${message}` });
  });

  it('keeps tool_failed with OpenCode\'s own reason for an error that is not a limit', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-opencode-error-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_1', error: { type: 'provider.no-route', message: 'Model unavailable: anthropic/claude-nonexistent-9' } });
    const adapter = hostLauncher(vi.fn(() => child(stdout, 1)) as unknown as ToolSpawn, () => '/usr/bin/opencode');

    const ran = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran.failure).toEqual({ code: 'tool_failed', message: 'opencode exited with status 1: Model unavailable: anthropic/claude-nonexistent-9' });
  });

  it('fails a step OpenCode 1.x ended with an error event, though it exited 0', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-opencode-1x-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'Model unavailable: anthropic/claude-nonexistent-9' } } });
    const adapter = hostLauncher(vi.fn(() => child(stdout, 0)) as unknown as ToolSpawn, () => '/usr/bin/opencode');

    const ran = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran.failure).toMatchObject({ code: 'tool_failed' });
  });

  it('keeps tool_failed for an OpenCode 2.x error whose type is no limit, though its message reads like one', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-opencode-typed-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_1', error: { type: 'provider.no-route', message: 'Rate limit reached for anthropic/claude-nonexistent-9 on no route' } });
    const adapter = hostLauncher(vi.fn(() => child(stdout, 1)) as unknown as ToolSpawn, () => '/usr/bin/opencode');

    const ran = await adapter.run('opencode', { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran.failure).toMatchObject({ code: 'tool_failed' });
  });

  // CodeBuddy prints Claude's result record; its limit text here is Claude Code's, as no CodeBuddy install was at hand.
  it.each(['claude', 'codebuddy'] as const)('fails usage_limited when %s says it hit its limit', async (tool) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-${tool}-limit-${Date.now()}-${Math.random()}.json`);
    files.push(resultPath);
    const stdout = claudeStream('claude-sonnet', { subtype: 'success', is_error: true, result: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)' });
    const adapter = hostLauncher(vi.fn(() => child(stdout, 1)) as unknown as ToolSpawn, () => `/usr/bin/${tool}`);

    const ran = await adapter.run(tool, { prompt: 'Fix it.', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(ran.failure).toEqual({ code: 'usage_limited', message: `${tool} hit its usage limit: You've hit your limit · resets 3pm (Europe/Madrid)` });
  });

  it('reports tool_unavailable without spawning when the executable cannot be resolved', async () => {
    const spawnTool = vi.fn() as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => null);

    const result = await adapter.run('codex', {
      prompt: 'Review', expected,
      cwd: os.tmpdir(),
      resultPath: path.join(os.tmpdir(), 'missing-result.json'), secrets: {},
    });

    expect(spawnTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ started: false, failure: { code: 'tool_unavailable' } });
  });

  it('reports a tool that never spawned as not started', async () => {
    const missing = (() => {
      const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume: () => undefined }) });
      queueMicrotask(() => process.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
      return process;
    }) as unknown as ToolSpawn;
    // cross-spawn on Windows starts cmd.exe, then reports the missing command as ENOENT.
    const missingBehindShell = (() => {
      const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume: () => undefined }) });
      queueMicrotask(() => {
        process.emit('spawn');
        process.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
      });
      return process;
    }) as unknown as ToolSpawn;
    const throws = vi.fn(() => { throw new Error('EACCES'); }) as unknown as ToolSpawn;
    const run = { prompt: 'Review', expected, cwd: os.tmpdir(), resultPath: path.join(os.tmpdir(), 'never-result.json'), secrets: {} };

    expect(await hostLauncher(missing, () => 'claude').run('claude', run))
      .toMatchObject({ started: false, failure: { code: 'tool_unavailable' } });
    // An instance that runs the shipped command misses that command, not one named after itself.
    expect(await hostLauncher(missing, () => '/opt/tools/claude').run('claude', { ...run, instance: { name: 'claude-work' } }))
      .toMatchObject({ started: false, failure: { code: 'tool_unavailable', message: 'The claude executable is not available on PATH' } });
    expect(await hostLauncher(missingBehindShell, () => 'claude').run('claude', run))
      .toMatchObject({ started: false, failure: { code: 'tool_unavailable' } });
    expect(await hostLauncher(throws, () => 'claude').run('claude', run))
      .toMatchObject({ started: false, failure: { code: 'tool_failed' } });
  });

  // `modelUsage` keys every model the session billed: a side call or a subagent writes beside the model that ran (#1176).
  it.each([
    ['its init event, beside a subagent that wrote more of the output', 'claude-sonnet-5-5', {
      'claude-haiku-5-5': { inputTokens: 1225, outputTokens: 900 },
      'claude-sonnet-5-5': { inputTokens: 8, outputTokens: 86 },
    }, 'claude-sonnet-5-5'],
    ['nothing without an init event naming one', undefined, { 'claude-opus-4-1-20250805': { inputTokens: 4, outputTokens: 2 } }, undefined],
  ])('reads the Claude model from %s', async (_name, initModel, modelUsage, model) => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-model-usage-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream(initModel, {
      result: JSON.stringify({ ok: true }),
      session_id: 'session-1',
      usage: { input_tokens: 4, output_tokens: 2 },
      modelUsage,
    }))) as unknown as ToolSpawn;

    const result = await hostLauncher(spawnTool, () => 'claude').run('claude', { prompt: 'Review', expected, cwd: os.tmpdir(), resultPath, secrets: {} });

    expect(result).toMatchObject({ started: true, output: { ok: true }, session: 'session-1' });
    expect(result.started && result.model).toBe(model ?? undefined);
  });
  it('tells the tool\'s session-start hook which workflow launch started it (#1176)', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-launch-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream(undefined, { result: '{}' }))) as unknown as ToolSpawn;

    await hostLauncher(spawnTool, () => 'claude').run('claude', {
      prompt: 'Review', expected, cwd: os.tmpdir(), resultPath, secrets: {}, launchEnv: launchEnv({ by: 'workflow', tool: 'claude', checkout: 'checkout-1' }),
    });

    expect(spawnTool).toHaveBeenCalledWith('claude', expect.anything(), expect.objectContaining({
      env: expect.objectContaining({ TEAMAI_LAUNCHED_BY: 'workflow', TEAMAI_LAUNCHED_TOOL: 'claude', TEAMAI_LAUNCHED_CHECKOUT: 'checkout-1' }),
    }));
  });

  it('reports that Claude ran a definition from its own file and Codex from the prompt', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-applied-${Date.now()}.json`);
    files.push(resultPath);
    const agent = { name: 'reviewer', instructions: 'Read only.' };
    const claude = vi.fn(() => child(claudeStream(undefined, { result: '{}' }))) as unknown as ToolSpawn;
    const codex = vi.fn(() => child('{"type":"thread.started","thread_id":"thread-1"}')) as unknown as ToolSpawn;

    expect(await hostLauncher(claude, () => 'claude').run('tclaude', { prompt: 'Review', expected, cwd: os.tmpdir(), resultPath, secrets: {}, agent }))
      .toMatchObject({ started: true, applied: 'main' });
    expect(await hostLauncher(codex, () => 'codex').run('codex-internal', { prompt: 'Review', expected, cwd: os.tmpdir(), resultPath, secrets: {}, agent }))
      .toMatchObject({ started: true, applied: 'prompt' });
    expect(await hostLauncher(claude, () => 'claude').run('claude', { prompt: 'Review', expected, cwd: os.tmpdir(), resultPath, secrets: {} }))
      .not.toHaveProperty('applied');
  });

  it.each([['1.18.23', 'prompt'], ['opencode v2.0.30', 'main']])(
    'reports the OpenCode %s handoff of a run that started and wrote no result',
    async (version, applied) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-workflow-handoff-'));
      onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
      const executable = path.join(root, 'opencode');
      await fs.writeFile(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });

      const result = await hostLauncher(undefined, () => executable).run('opencode', {
        prompt: 'Review', expected, cwd: root, resultPath: path.join(root, 'result.json'), secrets: {},
        agent: { name: 'reviewer', instructions: 'Read only.', settings: { mode: 'subagent' } },
      });

      expect(result).toMatchObject({ started: true, exitCode: 1, applied, failure: { code: 'tool_failed' } });
    },
  );

  it('reports the handoff of a run that started and then failed', async () => {
    const failsAfterSpawn = (() => {
      const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume: () => undefined }) });
      queueMicrotask(() => {
        process.emit('spawn');
        process.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      });
      return process;
    }) as unknown as ToolSpawn;

    const result = await hostLauncher(failsAfterSpawn, () => 'claude').run('claude', {
      prompt: 'Review', expected, cwd: os.tmpdir(), resultPath: path.join(os.tmpdir(), 'never-result.json'), secrets: {}, agent: { name: 'reviewer', instructions: 'Read only.' },
    });

    expect(result).toMatchObject({ started: true, applied: 'main', failure: { code: 'tool_failed' } });
  });
});

describe('interactive tool invocations', () => {
  it.each(['claude', 'codex', 'opencode', 'agy'] as const)('opens %s in the foreground with the initial prompt and optional result file', async (tool) => {
    const resultPath = path.join(os.tmpdir(), `teamai-interactive-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child('')) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => tool);
    expect(await adapter.runInteractive(tool, { prompt: 'Work with me.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, model: { name: 'example', effort: 'high' } })).toMatchObject({ started: true, exitCode: 0 });
    const args = vi.mocked(spawnTool).mock.calls[0]![1];
    expect(args).toContain('--model');
    expect(args).toContain('example');
    expect(args.at(-1)).toContain('Work with me.');
    expect(args.at(-1)).toContain(resultPath);
    expect(args).not.toContain('exec');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('run');
    if (tool === 'opencode') expect(args).toContain('--prompt');
    if (tool === 'agy') expect(args).toContain('--prompt-interactive');
    if (tool === 'codex') expect(args).toContain('model_reasoning_effort=high');
    expect(vi.mocked(spawnTool).mock.calls[0]![2]).toMatchObject({ cwd: os.tmpdir(), stdio: 'inherit', detached: false });
  });

  it.each(['claude', 'codex'] as const)('resumes an interactive %s session', async (tool) => {
    const resultPath = path.join(os.tmpdir(), `teamai-interactive-resume-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child('')) as unknown as ToolSpawn;
    const adapter = hostLauncher(spawnTool, () => tool);
    expect(await adapter.runInteractive(tool, { prompt: 'Again.', expected, cwd: os.tmpdir(), resultPath, secrets: {}, resume: 'sess-1' })).toMatchObject({ started: true, exitCode: 0 });
    const args = vi.mocked(spawnTool).mock.calls[0]![1] as string[];
    expect(args).toContain('sess-1');
    expect(args).toContain(tool === 'claude' ? '--resume' : 'resume');
    expect(args).not.toContain('exec');
    expect(args).not.toContain('-p');
  });
});


it.each([undefined, 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'])('stops a headless prompt with SIGTERM when aborted with %s', async (reason) => {
  const resultPath = path.join(os.tmpdir(), `teamai-abort-tool-${reason}-${Date.now()}.json`);
  files.push(resultPath);
  const controller = new AbortController();
  let stopped: NodeJS.Signals | null = null;
  const spawnTool: ToolSpawn = (_command, _args, options) => {
    const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    tool.on('spawn', () => controller.abort(reason));
    tool.on('close', (_code, signal) => { stopped = signal; });
    return tool;
  };
  const adapter = hostLauncher(spawnTool, () => process.execPath);
  expect(await adapter.run('codex', { prompt: 'Wait.', expected, cwd: os.tmpdir(), resultPath, secrets: {} }, controller.signal)).toMatchObject({ started: true, exitCode: 1 });
  expect(stopped).toBe('SIGTERM');
});


it('reports an interactive tool exit status without requiring a result file', async () => {
  const resultPath = path.join(os.tmpdir(), `teamai-interactive-failure-${Date.now()}.json`);
  files.push(resultPath);
  const spawnTool = vi.fn(() => {
    const tool = new EventEmitter();
    queueMicrotask(() => { tool.emit('spawn'); tool.emit('close', 7); });
    return tool;
  }) as unknown as ToolSpawn;
  const adapter = hostLauncher(spawnTool, () => 'claude');
  expect(await adapter.runInteractive('claude', { prompt: 'Pair.', expected, cwd: os.tmpdir(), resultPath, secrets: {} })).toMatchObject({
    started: true, exitCode: 7, failure: { code: 'tool_failed', message: 'claude exited with status 7' },
  });
});


it.each(['SIGTERM', 'SIGHUP'] as const)('passes %s through to an attached interactive child', async (signalName) => {
  const resultPath = path.join(os.tmpdir(), `teamai-interactive-signal-${signalName}-${Date.now()}.json`);
  files.push(resultPath);
  const controller = new AbortController();
  let stopped: NodeJS.Signals | null = null;
  const spawnTool: ToolSpawn = (_command, _args, options) => {
    const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    tool.on('spawn', () => controller.abort(signalName));
    tool.on('close', (_code, signal) => { stopped = signal; });
    return tool;
  };
  const adapter = hostLauncher(spawnTool, () => process.execPath);
  expect(await adapter.runInteractive('claude', { prompt: 'Wait.', expected, cwd: os.tmpdir(), resultPath, secrets: {} }, controller.signal)).toMatchObject({ started: true, exitCode: 1 });
  expect(stopped).toBe(signalName);
});
