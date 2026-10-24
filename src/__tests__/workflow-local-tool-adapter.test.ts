import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createLocalToolAdapter, type ToolSpawn } from '../workflow/local-tool-adapter.js';

const files: string[] = [];

function child(stdout: string | Buffer[]) {
  const stdoutEmitter = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  const childProcess = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  childProcess.stdout = stdoutEmitter;
  childProcess.stderr = stderr;
  queueMicrotask(() => {
    childProcess.emit('spawn');
    for (const chunk of typeof stdout === 'string' ? [Buffer.from(stdout)] : stdout) stdoutEmitter.emit('data', chunk);
    childProcess.emit('close', 0);
  });
  return childProcess;
}

/** What `claude -p --output-format stream-json --verbose` prints: an `init` event naming the session's model, then the result. */
function claudeStream(model: string | undefined, result: Record<string, unknown>): string {
  const init = { type: 'system', subtype: 'init', session_id: 'session-1', ...(model ? { model } : {}) };
  return `${JSON.stringify(init)}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...result })}\n`;
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe('local tool adapter', () => {
  it('preserves UTF-8 split across stdout chunks in the result and persisted fallback', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-utf8-${Date.now()}.json`);
    files.push(resultPath);
    const output = { summary: '检查完成 café 😀' };
    const bytes = Buffer.from(claudeStream('claude-sonnet', { result: JSON.stringify(output) }));
    const chunks = Array.from(bytes, (_byte, index) => bytes.subarray(index, index + 1));
    const adapter = createLocalToolAdapter(() => child(chunks) as ReturnType<ToolSpawn>, () => 'claude');

    const result = await adapter.run('claude', { prompt: 'Review.', cwd: os.tmpdir(), resultPath });

    expect(result).toMatchObject({ started: true, exitCode: 0, output });
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toEqual({ output });
  });

  it('starts the resolved executable and ignores token counts written into result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-result-${Date.now()}.json`);
    files.push(resultPath);
    await fs.writeFile(resultPath, JSON.stringify({
      output: { ok: true },
      model: 'invented',
      session: 'invented-session',
      tokens: { input: 999, output: 999 },
    }));
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', {
      session_id: 'session-1',
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      result: JSON.stringify({ ok: false }),
    }))) as unknown as ToolSpawn;
    const resolveTool = vi.fn(() => 'C:\\npm\\claude.cmd');
    const adapter = createLocalToolAdapter(spawnTool, resolveTool);

    const result = await adapter.run('claude-internal', {
      prompt: 'Review the change.',
      cwd: os.tmpdir(),
      resultPath,
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

  it('passes maxTurns to headless Claude as --max-turns', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-turns-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', { result: JSON.stringify({ ok: true }) }))) as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => 'claude');

    await adapter.run('claude', { prompt: 'Plan.', cwd: os.tmpdir(), resultPath, maxTurns: 3 });

    expect(spawnTool).toHaveBeenCalledWith('claude', expect.arrayContaining(['-p', '--max-turns', '3']), expect.anything());
  });

  it('writes the Claude stdout fallback when the tool does not write result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-fallback-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream('claude-sonnet', {
      session_id: 'session-1',
      usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      result: JSON.stringify({ ok: true }),
    }))) as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => 'claude');

    const result = await adapter.run('claude', {
      prompt: 'Review the change.',
      cwd: os.tmpdir(),
      resultPath,
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
    await fs.writeFile(resultPath, JSON.stringify({
      output: { ok: true },
      model: 'invented',
      session: 'invented-session',
      tokens: { input: 999, output: 999 },
    }));
    const codexStdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1', model: 'gpt-5.4' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, cached_input_tokens: 3, output_tokens: 2 } }),
    ].join('\n');
    const spawnTool = vi.fn(() => child(codexStdout)) as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => '/usr/bin/codex');

    const codex = await adapter.run('codex-internal', {
      prompt: 'Review the change.',
      cwd: os.tmpdir(),
      resultPath,
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
    await fs.writeFile(opencodePath, JSON.stringify({ output: { ok: true }, tokens: { input: 999 } }));
    const opencodeStdout = [
      JSON.stringify({ type: 'session.created', properties: { info: { id: 'ses_1' } } }),
      JSON.stringify({ type: 'message.updated', properties: { info: { sessionID: 'ses_1', modelID: 'claude-sonnet-4' } } }),
      JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'step-finish', tokens: { input: 11, output: 4, cache: { read: 6 } } } } }),
    ].join('\n');
    const opencodeSpawn = vi.fn(() => child(opencodeStdout)) as unknown as ToolSpawn;
    const opencode = createLocalToolAdapter(opencodeSpawn, () => '/usr/bin/opencode');

    const opened = await opencode.run('opencode', {
      prompt: 'Review the change.',
      cwd: os.tmpdir(),
      resultPath: opencodePath,
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

  it('reports tool_unavailable without spawning when the executable cannot be resolved', async () => {
    const spawnTool = vi.fn() as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => null);

    const result = await adapter.run('codex', {
      prompt: 'Review',
      cwd: os.tmpdir(),
      resultPath: path.join(os.tmpdir(), 'missing-result.json'),
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
    const run = { prompt: 'Review', cwd: os.tmpdir(), resultPath: path.join(os.tmpdir(), 'never-result.json') };

    expect(await createLocalToolAdapter(missing, () => 'claude').run('claude', run))
      .toMatchObject({ started: false, failure: { code: 'tool_unavailable' } });
    expect(await createLocalToolAdapter(missingBehindShell, () => 'claude').run('claude', run))
      .toMatchObject({ started: false, failure: { code: 'tool_unavailable' } });
    expect(await createLocalToolAdapter(throws, () => 'claude').run('claude', run))
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

    const result = await createLocalToolAdapter(spawnTool, () => 'claude').run('claude', { prompt: 'Review', cwd: os.tmpdir(), resultPath });

    expect(result).toMatchObject({ started: true, output: { ok: true }, session: 'session-1' });
    expect(result.started && result.model).toBe(model ?? undefined);
  });
  it('tells the tool\'s session-start hook which workflow launch started it (#1176)', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-launch-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(claudeStream(undefined, { result: '{}' }))) as unknown as ToolSpawn;

    await createLocalToolAdapter(spawnTool, () => 'claude').run('claude', {
      prompt: 'Review', cwd: os.tmpdir(), resultPath, launch: { by: 'workflow', tool: 'claude', checkout: 'checkout-1' },
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

    expect(await createLocalToolAdapter(claude, () => 'claude').run('tclaude', { prompt: 'Review', cwd: os.tmpdir(), resultPath, agent }))
      .toMatchObject({ started: true, applied: 'main' });
    expect(await createLocalToolAdapter(codex, () => 'codex').run('codex-internal', { prompt: 'Review', cwd: os.tmpdir(), resultPath, agent }))
      .toMatchObject({ started: true, applied: 'prompt' });
    expect(await createLocalToolAdapter(claude, () => 'claude').run('claude', { prompt: 'Review', cwd: os.tmpdir(), resultPath }))
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

      const result = await createLocalToolAdapter(undefined, () => executable).run('opencode', {
        prompt: 'Review', cwd: root, resultPath: path.join(root, 'result.json'),
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

    const result = await createLocalToolAdapter(failsAfterSpawn, () => 'claude').run('claude', {
      prompt: 'Review', cwd: os.tmpdir(), resultPath: path.join(os.tmpdir(), 'never-result.json'), agent: { name: 'reviewer', instructions: 'Read only.' },
    });

    expect(result).toMatchObject({ started: true, applied: 'main', failure: { code: 'tool_failed' } });
  });
});

describe('interactive tool invocations', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('opens %s in the foreground with the initial prompt and optional result file', async (tool) => {
    const resultPath = path.join(os.tmpdir(), `teamai-interactive-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child('')) as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => tool);
    expect(await adapter.runInteractive(tool, { prompt: 'Work with me.', cwd: os.tmpdir(), resultPath, model: { name: 'example', effort: 'high' } })).toMatchObject({ started: true, exitCode: 0 });
    const args = vi.mocked(spawnTool).mock.calls[0]![1];
    expect(args).toContain('--model');
    expect(args).toContain('example');
    expect(args.at(-1)).toContain('Work with me.');
    expect(args.at(-1)).toContain(resultPath);
    expect(args).not.toContain('exec');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('run');
    if (tool === 'opencode') expect(args).toContain('--prompt');
    if (tool === 'codex') expect(args).toContain('model_reasoning_effort=high');
    expect(vi.mocked(spawnTool).mock.calls[0]![2]).toMatchObject({ cwd: os.tmpdir(), stdio: 'inherit', detached: false });
  });

  it.each(['claude', 'codex'] as const)('resumes an interactive %s session', async (tool) => {
    const resultPath = path.join(os.tmpdir(), `teamai-interactive-resume-${tool}-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child('')) as unknown as ToolSpawn;
    const adapter = createLocalToolAdapter(spawnTool, () => tool);
    expect(await adapter.runInteractive(tool, { prompt: 'Again.', cwd: os.tmpdir(), resultPath, resume: 'sess-1' })).toMatchObject({ started: true, exitCode: 0 });
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
  const adapter = createLocalToolAdapter(spawnTool, () => process.execPath);
  expect(await adapter.run('codex', { prompt: 'Wait.', cwd: os.tmpdir(), resultPath }, controller.signal)).toMatchObject({ started: true, exitCode: 1 });
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
  const adapter = createLocalToolAdapter(spawnTool, () => 'claude');
  expect(await adapter.runInteractive('claude', { prompt: 'Pair.', cwd: os.tmpdir(), resultPath })).toMatchObject({
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
  const adapter = createLocalToolAdapter(spawnTool, () => process.execPath);
  expect(await adapter.runInteractive('claude', { prompt: 'Wait.', cwd: os.tmpdir(), resultPath }, controller.signal)).toMatchObject({ started: true, exitCode: 1 });
  expect(stopped).toBe(signalName);
});
