import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sqlite3: 'sqlite3', rows: [] as unknown[], sql: [] as string[] }));

vi.mock('@teamai/tool-core/sessions/sqlite', async (importOriginal) => ({
  ...await importOriginal<typeof import('@teamai/tool-core/sessions/sqlite')>(),
  findSqlite3: () => mocks.sqlite3 || null,
}));

import { parseZCodeFile, ZCodeAdapter } from './session-adapter.js';
import { ToolUnavailableError } from '@teamai/tool-core/sessions/base';
import { HOST_PROCESSES, type Processes } from '@teamai/shared/exec';

const fixture = path.join(import.meta.dirname, 'fixtures', 'zcode-model-io.jsonl');
const roots: string[] = [];

const processes: Processes = {
  ...HOST_PROCESSES,
  exec: async (_command, args) => {
    if (args[1]?.startsWith('.backup ')) return { code: 0, stdout: '', stderr: '', signal: null };
    mocks.sql.push(args[2]!);

    return { code: 0, stdout: JSON.stringify(mocks.rows), stderr: '', signal: null };
  },
};

beforeEach(() => {
  mocks.sqlite3 = 'sqlite3';
  mocks.rows = [];
  mocks.sql.length = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function adapterFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-adapter-'));
  roots.push(root);
  const cliHome = path.join(root, 'cli');
  const rollout = path.join(cliHome, 'rollout');
  const db = path.join(cliHome, 'db', 'db.sqlite');
  const cwd = path.join(root, 'work', 'app');
  const id = '00000000-0000-0000-0000-000000000000';
  const file = path.join(rollout, `model-io-sess_${id}.jsonl`);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.mkdirSync(rollout, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(db, 'fixture');
  fs.writeFileSync(`${db}-shm`, '');
  fs.copyFileSync(fixture, file);
  mocks.rows = [{
    id: `sess_${id}`, directory: cwd, title: 'List files', time_created: 1_794_709_200_000,
    time_updated: 1_794_709_205_000, time_archived: null,
  }];

  return { adapter: new ZCodeAdapter(cliHome, processes), cwd, db, file, id };
}

describe('ZCode model-I/O parser', () => {
  it('reconstructs full and delta turns with reasoning, images and tool calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-session-'));
    roots.push(root);
    const file = path.join(root, 'model-io-sess_00000000-0000-0000-0000-000000000000.jsonl');
    fs.copyFileSync(fixture, file);

    const parsed = parseZCodeFile(file)!;

    expect(parsed).toMatchObject({
      sessionId: '00000000-0000-0000-0000-000000000000', model: 'example-model',
      provider: 'example-provider', createdAt: '2026-11-15T10:00:00.000Z', updatedAt: '2026-11-15T10:00:05.000Z',
    });
    expect(parsed.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(parsed.messages[1]!.content).toEqual([
      { type: 'thinking', text: 'Use Bash' },
      { type: 'tool_call', callId: 'call_1', toolName: 'Bash', arguments: { command: 'ls' } },
    ]);
    expect(parsed.messages[2]!.content).toEqual([
      { type: 'tool_result', callId: 'call_1', content: 'a.txt', isError: false },
    ]);
    expect(parsed.messages[4]!.content).toEqual([
      { type: 'text', text: 'Open it' },
      { type: 'image', mimeType: 'image/png', data: 'YQ==', filePath: 'C:\\tmp\\a.png', label: 'a.png' },
    ]);
    expect(parsed.messages[5]!.content).toEqual([
      { type: 'thinking', text: 'Read it' },
      { type: 'text', text: 'contents' },
      { type: 'tool_call', callId: 'call_2', toolName: 'Read', arguments: { file_path: 'C:\\tmp\\a.txt' } },
    ]);
  });

  it('keeps pre-compaction history while merging the shorter request window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-compaction-'));
    roots.push(root);
    const id = '00000000-0000-0000-0000-000000000000';
    const file = path.join(root, `model-io-sess_${id}.jsonl`);
    const record = (turn: number, messages: unknown[], kind: 'full' | 'delta', offset: number, text: string) => ({
      type: 'model_io', sessionId: `sess_${id}`, turnId: `turn_${turn}`, requestId: `req_${turn}`, attempt: 1,
      model: { modelId: 'model', providerId: 'provider' }, startedAt: `2026-11-15T10:00:0${turn}.000Z`,
      completedAt: `2026-11-15T10:00:0${turn}.500Z`, request: { messages, messagesKind: kind, messageOffset: offset },
      response: { text, reasoningText: '', toolCalls: [], modelId: 'model' },
    });
    const lines = [
      record(1, [{ role: 'user', content: [{ type: 'text', text: 'early' }, { type: 'image', dataUrl: 'data:image/png;base64,YQ==' }] }], 'full', 0, 'first'),
      record(2, [{ role: 'assistant', content: 'first' }, { role: 'user', content: 'middle' }], 'delta', 1, 'second'),
      record(3, [{ role: 'system', content: 'compacted summary' }, { role: 'assistant', content: 'second' }, { role: 'user', content: 'late' }], 'delta', 0, 'third'),
    ];
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));

    const parsed = parseZCodeFile(file)!;
    const texts = parsed.messages.flatMap(({ content }) => content.flatMap((block) => block.type === 'text' ? [block.text] : []));

    expect(texts).toEqual(['early', 'first', 'middle', 'second', 'late', 'third']);
    expect(parsed.messages[0]!.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' });
  });

  it('ignores non-session files and mismatched session ids', () => {
    expect(parseZCodeFile(fixture)).toBeUndefined();
  });

  it('lists by authoritative cwd and reads the matching rollout', async () => {
    const { adapter, cwd, file, id } = adapterFixture();
    const [listed] = await adapter.listConversations(cwd);

    expect(listed).toMatchObject({
      sessionId: id, title: 'List files', cwd, platform: 'zcode', filePath: file,
      createdAt: '2026-11-15T02:20:00.000Z', updatedAt: '2026-11-15T02:20:05.000Z',
    });
    expect(await adapter.listConversations(path.dirname(cwd))).toEqual([]);
    const session = await adapter.readSession({ sessionId: id, projectPath: cwd, filePath: file });
    expect(session.messages.at(-1)?.content).toEqual([
      { type: 'thinking', text: 'Read it' },
      { type: 'text', text: 'contents' },
      { type: 'tool_call', callId: 'call_2', toolName: 'Read', arguments: { file_path: 'C:\\tmp\\a.txt' } },
    ]);
    expect(session.metadata).toEqual({ model: 'example-model', provider: 'example-provider' });
    expect(mocks.sql[0]).toContain('time_deleted IS NULL AND time_archived IS NULL');
  });

  it('includes archived sessions only when requested and keeps the store read-only', async () => {
    const { adapter, id } = adapterFixture();
    mocks.rows = [];
    expect(await adapter.listConversations()).toEqual([]);
    await adapter.listConversations(undefined, { archived: true });
    expect(mocks.sql.at(-1)).not.toContain('time_archived IS NULL');
    mocks.sqlite3 = '';
    await expect(adapter.listConversations()).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.writeSession({
      sessionId: id, title: '', cwd: '', platform: 'zcode', createdAt: '', updatedAt: '', messages: [],
    })).rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.deleteSession(id)).resolves.toBe(false);
  });
});
