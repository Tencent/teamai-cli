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
