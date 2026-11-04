import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqlite3: 'sqlite3',
  commands: [] as string[][],
  sql: [] as string[],
  sessions: [] as unknown[],
  messages: [] as unknown[],
}));

vi.mock('../session-flow/sqlite.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session-flow/sqlite.js')>(),
  findSqlite3: () => mocks.sqlite3 || null,
}));
vi.mock('../utils/exec.js', () => ({
  execCommand: async (_command: string, args: string[]) => {
    mocks.commands.push(args);
    if (args[1]?.startsWith('.backup ')) return { code: 0, stdout: '', stderr: '', signal: null };
    const sql = args[2]!;
    mocks.sql.push(sql);

    return {
      code: 0, stdout: JSON.stringify(sql.includes('FROM sessions') ? mocks.sessions : mocks.messages),
      stderr: '', signal: null,
    };
  },
}));

import { HermesAdapter } from '../session-flow/adapters/hermes.js';
import { ToolUnavailableError } from '../session-flow/adapters/base.js';

const roots: string[] = [];

beforeEach(() => {
  mocks.sqlite3 = 'sqlite3';
  mocks.commands.length = 0;
  mocks.sql.length = 0;
  mocks.sessions = [];
  mocks.messages = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { adapter: HermesAdapter; home: string; cwd: string; id: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-'));
  roots.push(home);
  fs.writeFileSync(path.join(home, 'state.db'), 'fixture');
  // Hermes is running, so its WAL index exists.
  fs.writeFileSync(path.join(home, 'state.db-shm'), '');
  const cwd = path.join(home, 'work', 'app');
  fs.mkdirSync(cwd, { recursive: true });
  const id = '20261104_091523_a1b2c3d4';
  mocks.sessions = [{
    id, source: 'cli', model: 'anthropic/claude-sonnet', cwd, title: 'Fix the parser',
    started_at: 1_793_761_200, ended_at: null, last_activity_at: 1_793_761_260, message_count: 5,
  }];
  mocks.messages = [
    { id: 1, role: 'user', content: 'Inspect it', tool_call_id: null, tool_calls: null, tool_name: null,
      timestamp: 1_793_761_201, finish_reason: null, reasoning: null, reasoning_content: null },
    { id: 2, role: 'assistant', content: null, tool_call_id: null, tool_name: null,
      tool_calls: JSON.stringify([{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]),
      timestamp: 1_793_761_202, finish_reason: null, reasoning: 'Need the source', reasoning_content: null },
    { id: 3, role: 'tool', content: 'source', tool_call_id: 'call-1', tool_calls: null, tool_name: 'read_file',
      timestamp: 1_793_761_203, finish_reason: null, reasoning: null, reasoning_content: null },
    { id: 4, role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'Done' }]), tool_call_id: null,
      tool_calls: null, tool_name: null, timestamp: 1_793_761_204, finish_reason: 'stop', reasoning: null, reasoning_content: null },
    { id: 5, role: 'system', content: 'hidden', tool_call_id: null, tool_calls: null, tool_name: null,
      timestamp: 1_793_761_205, finish_reason: null, reasoning: null, reasoning_content: null },
  ];

  return { adapter: new HermesAdapter(home), home, cwd, id };
}

describe('HermesAdapter', () => {
  it('lists only coding surfaces and reads ordered chat-completions messages', async () => {
    const { adapter, home, cwd, id } = fixture();
    const listed = await adapter.listConversations(cwd);

    expect(listed).toEqual([expect.objectContaining({
      sessionId: id, title: 'Fix the parser', cwd, platform: 'hermes', messageCount: 5,
      filePath: path.join(home, 'state.db'),
    })]);
    expect(mocks.sql[0]).toContain("LOWER(source) IN ('acp', 'cli', 'desktop', 'gui', 'oneshot', 'tui')");
    expect(mocks.sql[0]).toContain("LOWER(source) = 'local'");
    expect(mocks.sql[0]).toContain("LOWER(created_source) IN ('acp', 'cli', 'gui', 'oneshot', 'tui')");
    expect(mocks.sql[0]).not.toContain("created_source) IN ('telegram'");
    expect(mocks.commands[0]![0]).toMatch(/^file:.*state\.db\?mode=ro$/);
    expect(mocks.commands[0]![1]).toMatch(/^\.backup ".*state\.db"$/);

    const session = await adapter.readSession({ sessionId: id, projectPath: cwd });
    expect(session.metadata?.model).toBe('anthropic/claude-sonnet');
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.messages[1]!.content).toEqual([
      { type: 'thinking', text: 'Need the source' },
      { type: 'tool_call', callId: 'call-1', toolName: 'read_file', arguments: { path: 'a.ts' } },
    ]);
    expect(session.messages[2]!.content).toEqual([
      { type: 'tool_result', callId: 'call-1', content: 'source', isError: false },
    ]);
    expect(session.messages[3]!.content).toEqual([{ type: 'text', text: 'Done' }]);
    expect(mocks.sql.at(-1)).toContain('(active = 1 OR compacted = 1) ORDER BY id');
  });

  it('keeps compacted turns in row order and falls back to provider reasoning content', async () => {
    const { adapter, cwd, id } = fixture();
    mocks.messages = [
      { id: 17, role: 'user', content: 'Earlier turn', tool_call_id: null, tool_calls: null, tool_name: null,
        timestamp: 200, finish_reason: null, reasoning: null, reasoning_content: null },
      { id: 18, role: 'assistant', content: 'Answer', tool_call_id: null, tool_calls: null, tool_name: null,
        timestamp: 150, finish_reason: 'stop', reasoning: null, reasoning_content: 'Provider thought' },
    ];

    const session = await adapter.readSession({ sessionId: id, projectPath: cwd });

    expect(session.messages.map((message) => message.messageId)).toEqual(['17', '18']);
    expect(session.messages[1]!.content).toEqual([
      { type: 'thinking', text: 'Provider thought' },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('matches a symlinked cwd and rejects unsafe non-Hermes ids', async () => {
    const { adapter, cwd, id } = fixture();
    const linked = path.join(path.dirname(cwd), 'linked-app');
    fs.symlinkSync(cwd, linked, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await adapter.existingSessionId(id, linked)).toBe(id);
    expect(await adapter.listConversations(linked)).toHaveLength(1);
    expect(await adapter.existingSessionId('../state.db')).toBeUndefined();
  });

  it('reports a missing sqlite3 reader and keeps the native store read-only', async () => {
    const { adapter, id } = fixture();
    mocks.sqlite3 = '';

    await expect(adapter.listConversations()).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.writeSession({
      sessionId: id, title: '', cwd: '', platform: 'hermes', createdAt: '', updatedAt: '', messages: [],
    })).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.deleteSession(id)).resolves.toBe(false);
  });
});
