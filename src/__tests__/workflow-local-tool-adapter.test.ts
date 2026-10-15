import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalToolAdapter, type ToolSpawn } from '../workflow/local-tool-adapter.js';

const files: string[] = [];

function child(stdout: string) {
  const stdoutEmitter = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  const childProcess = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  childProcess.stdout = stdoutEmitter;
  childProcess.stderr = stderr;
  queueMicrotask(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    childProcess.emit('close', 0);
  });
  return childProcess;
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe('local tool adapter', () => {
  it('starts the resolved executable and ignores token counts written into result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-result-${Date.now()}.json`);
    files.push(resultPath);
    await fs.writeFile(resultPath, JSON.stringify({
      output: { ok: true },
      model: 'invented',
      session: 'invented-session',
      tokens: { input: 999, output: 999 },
    }));
    const spawnTool = vi.fn(() => child(JSON.stringify({
      model: 'claude-sonnet',
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
      expect.arrayContaining(['-p', '--output-format', 'json']),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(result).toMatchObject({
      output: { ok: true },
      model: 'claude-sonnet',
      session: 'session-1',
      tokens: { input: 4, output: 2, cachedInput: 1 },
    });
    expect(result.model).not.toBe('invented');
    expect(JSON.parse(await fs.readFile(resultPath, 'utf8'))).toMatchObject({
      output: { ok: true },
      tokens: { input: 999, output: 999 },
    });
  });

  it('writes the Claude stdout fallback when the tool does not write result.json', async () => {
    const resultPath = path.join(os.tmpdir(), `teamai-workflow-fallback-${Date.now()}.json`);
    files.push(resultPath);
    const spawnTool = vi.fn(() => child(JSON.stringify({
      model: 'claude-sonnet',
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
    expect(result.failure).toMatchObject({ code: 'tool_unavailable' });
  });
});
