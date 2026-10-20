/**
 * claude-tool-result-images.test.ts — images returned inside a Claude Code tool_result
 * (e.g. Read on a screenshot) must reach the IR instead of being dropped silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { encodeCwdClaude } from '../session-flow/fs.js';

const SID = 'c0ffee00-0000-4000-8000-000000000001';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

function writeFixture(cwd: string): void {
  const base = { isSidechain: false, cwd, sessionId: SID, version: '2.1.221', userType: 'external', timestamp: '2026-10-01T10:00:00.000Z' };
  const records = [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'what is in shot.png?' }] } },
    {
      ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/proj/shot.png' } }] },
    },
    {
      ...base, type: 'user', uuid: 'u2', parentUuid: 'a1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
        }],
      },
    },
  ];
  const dir = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tr-img-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('claude-code tool_result images', () => {
  it('reads an image returned by a tool into a user message after the tool_result', async () => {
    const cwd = path.join(mocks.home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    writeFixture(cwd);

    const session = await new ClaudeCodeAdapter().readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['tool_call']],
      ['user', ['tool_result']],
      ['user', ['image']],
    ]);
    expect(session.messages[3].content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG });
  });

  it('puts the images after every tool_result of a parallel round', async () => {
    const cwd = path.join(mocks.home, 'work');
    const base = { isSidechain: false, cwd, sessionId: SID, version: '2.1.221', userType: 'external', timestamp: '2026-10-01T10:00:00.000Z' };
    const read = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/proj/${id}.png` } });
    const result = (id: string) => ({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }],
    });
    const records = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'compare them' }] } },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [read('t1')] } },
      { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [read('t2')] } },
      { ...base, type: 'user', uuid: 'u2', parentUuid: 'a2', message: result('t1') },
      { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', message: result('t2') },
      { ...base, type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'text', text: 'same' }] } },
    ];
    const dir = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const session = await new ClaudeCodeAdapter().readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['tool_call']],
      ['assistant', ['tool_call']],
      ['user', ['tool_result']],
      ['user', ['tool_result']],
      ['user', ['image', 'image']],
      ['assistant', ['text']],
    ]);
  });

  it('keeps the image when the session is written back to claude-code', async () => {
    const cwd = path.join(mocks.home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    writeFixture(cwd);

    const adapter = new ClaudeCodeAdapter();
    const session = await adapter.readSession({ sessionId: SID, projectPath: cwd });
    const target = path.join(mocks.home, 'work2');
    const id = await adapter.writeSession(session, target);
    const metas = await adapter.listConversations(target);
    const written = metas.find((m) => m.sessionId === id)?.filePath;
    expect(written).toBeDefined();
    expect(fs.readFileSync(written as string, 'utf-8')).toContain(PNG);
  });
});
