import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MuseAdapter } from './session-adapter.js';
import { ToolUnavailableError } from '@teamai/tool-core/sessions/base';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Records = {
  record: (payloadType: string, payload: object, stream?: string) => object;
  run: (event: object) => object;
  cwd: string;
};

function fixture(edit?: (records: object[], make: Records) => object[]): { adapter: MuseAdapter; file: string; cwd: string; id: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-muse-'));
  roots.push(root);
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const cwd = path.join(root, 'work', 'app');
  const dir = path.join(root, '2026', '11', '03', id);
  const file = path.join(dir, 'session.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  let sequence = 0;
  const record = (payloadType: string, payload: object, stream = id): object => ({
    schema_version: 1, id: `record-${++sequence}`, stream: { kind: 'session', id: stream }, sequence,
    recorded_at: 1793671200000000 + sequence * 1000, record_type: 'event', payload_type: payloadType, payload,
  });
  const run = (event: object): object => record('runtime.session', { kind: 'run', run_id: 'run-1', event });
  const records = [
    record('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: cwd, model_id: 'muse-spark' } }),
    run({ kind: 'started', prompt: 'Fix the parser' }),
    // A record of another stream is not this session's conversation.
    record('runtime.session', { kind: 'run', run_id: 'child', event: { kind: 'started', prompt: 'subagent noise' } }, 'child-stream'),
    run({ kind: 'reasoning_committed', message_id: 'a1', text: 'Inspect first' }),
    run({ kind: 'assistant_tool_calls_committed', message_id: 'a1', tool_calls: [
      { id: 'tool-1', call_id: 'call-1', name: 'read_file', args: JSON.stringify({ path: 'a.ts' }) },
    ] }),
    run({ kind: 'tool_result_batch_committed', batch_id: 'batch-1', results: [
      { tool_call_index: 0, tool_call_id: 'call-1', text: 'source' },
    ] }),
    run({ kind: 'assistant_message_committed', message_id: 'a2', text: 'Done' }),
    run({ kind: 'model_completed', model: 'muse-spark-2', usage: {} }),
  ];
  const written = edit ? edit(records, { record, run, cwd }) : records;
  fs.writeFileSync(file, `${written.map((value) => JSON.stringify(value)).join('\n')}\n{partial`, 'utf8');

  return { adapter: new MuseAdapter(root), file, cwd, id };
}

describe('MuseAdapter', () => {
  it('lists and reads the root Muse event stream in record order', async () => {
    const { adapter, file, cwd, id } = fixture();
    const [listed] = await adapter.listConversations(cwd);

    expect(listed).toMatchObject({ sessionId: id, title: 'Fix the parser', cwd, platform: 'muse', messageCount: 5, filePath: file });
    const session = await adapter.readSession({ sessionId: id, filePath: file });
    expect(JSON.stringify(session.messages)).not.toContain('subagent noise');
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
    expect(session.messages[2]!.content).toEqual([
      { type: 'tool_call', callId: 'call-1', toolName: 'read_file', arguments: { path: 'a.ts' } },
    ]);
    expect(session.messages[3]!.content).toEqual([
      { type: 'tool_result', callId: 'call-1', content: 'source', isError: false },
    ]);
    expect(session.metadata?.model).toBe('muse-spark-2');
  });

  it('archives a steering prompt as a user message in order and leaves other inbox deliveries out', async () => {
    const queued = (source: string, fields: object): object => ({ kind: 'inbox_item_queued', source: { source }, ...fields });
    const { adapter, file, id } = fixture((records, { run }) => [
      ...records.slice(0, 2),
      run(queued('user_steer', { summary: 'steer', payload: { prompt: 'Also cover the lexer' } })),
      run(queued('background_task_terminal', { body: 'background task finished' })),
      run(queued('scheduled', { payload: { prompt: 'scheduled reminder' } })),
      run(queued('user_steer', { payload: null, body: 'Keep the old API' })),
      ...records.slice(2),
    ]);
    const session = await adapter.readSession({ sessionId: id, filePath: file });
    const userTexts = session.messages.flatMap((message) => message.role === 'user'
      ? message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
      : []);

    expect(userTexts).toEqual(['Fix the parser', 'Also cover the lexer', 'Keep the old API']);
    expect(JSON.stringify(session.messages)).not.toMatch(/background task finished|scheduled reminder/);
  });

  it('keeps a model recorded as { model_id }', async () => {
    const { adapter, file, id } = fixture((records, { run }) => [
      ...records.slice(0, -1),
      run({ kind: 'model_completed', model: { model_id: 'muse-spark-3' }, usage: {} }),
    ]);

    expect((await adapter.readSession({ sessionId: id, filePath: file })).metadata?.model).toBe('muse-spark-3');
  });

  it('attributes a session whose workspace is recorded only in a checkpoint', async () => {
    const { adapter, cwd, id } = fixture((records, { record, run, cwd: app }) => [
      record('runtime.session.metadata', { kind: 'metadata', record: { model_id: 'muse-spark' } }),
      ...records.slice(1),
      record('runtime.session', { kind: 'context', event: { kind: 'context_projection_checkpoint', session_metadata: { workspace_root: app } } }),
      run({ kind: 'assistant_message_committed', message_id: 'a3', text: 'After checkpoint' }),
    ]);

    expect(await adapter.existingSessionId(id, cwd)).toBe(id);
  });

  it('prefers a metadata record\'s top-level workspace over its nested one', async () => {
    const { adapter, cwd, id } = fixture((records, { record, cwd: app }) => [
      record('runtime.session.metadata', { kind: 'metadata', workspace_root: app, record: { workspace_root: path.join(app, 'nested') } }),
      ...records.slice(1),
    ]);

    expect(await adapter.existingSessionId(id, cwd)).toBe(id);
    expect(await adapter.listConversations(path.join(cwd, 'nested'))).toEqual([]);
  });

  it('filters by recorded workspace and rejects unsafe ids', async () => {
    const { adapter, cwd, id } = fixture();
    expect(await adapter.existingSessionId(id, cwd)).toBe(id);
    expect(await adapter.listConversations(path.join(cwd, 'other'))).toEqual([]);
    expect(await adapter.existingSessionId('../session')).toBeUndefined();
  });

  it('matches a symlinked project path to the recorded physical workspace', async () => {
    const { adapter, cwd, id } = fixture();
    const linked = path.join(path.dirname(cwd), 'linked-app');
    fs.symlinkSync(cwd, linked, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await adapter.existingSessionId(id, linked)).toBe(id);
    expect(await adapter.listConversations(linked)).toHaveLength(1);
  });

  it('does not enumerate subagent logs', async () => {
    const { adapter, file } = fixture();
    const child = path.join(path.dirname(file), 'subagent', 'child', 'session.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.copyFileSync(file, child);

    expect(await adapter.listConversations()).toHaveLength(1);
  });

  it('is read-only and never deletes a native session', async () => {
    const { adapter, id } = fixture();
    await expect(adapter.writeSession({ sessionId: id, title: '', cwd: '', platform: 'x', createdAt: '', updatedAt: '', messages: [] }))
      .rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.deleteSession(id)).resolves.toBe(false);
  });
});
