import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CopilotAdapter } from './session-adapter.js';
import { ToolUnavailableError } from '@teamai/tool-core/sessions/base';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version: '0.0.411' | '1.0.107' = '1.0.107', workspaceOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-copilot-session-'));
  roots.push(root);
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const cwd = path.join(root, 'work', 'app');
  const dir = path.join(root, id);
  const file = path.join(dir, 'events.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const event = (type: string, data: object, n: number) => ({
    type, data, id: `event-${n}`, timestamp: `2026-11-08T02:00:0${n}.000Z`, parentId: n ? `event-${n - 1}` : null,
  });
  const records = [
    event('session.start', {
      sessionId: id, copilotVersion: version, startTime: '2026-11-08T02:00:00.000Z',
      context: workspaceOnly ? {} : { cwd },
    }, 0),
    event('session.model_change', { newModel: version.startsWith('0.') ? 'gpt-4.1' : 'auto' }, 1),
    ...(version.startsWith('1.') ? [event('session.auto_mode_resolved', { chosenModel: 'gpt-5' }, 2)] : []),
    event('user.message', { content: 'Fix the parser', messageId: 'user-1' }, 3),
    event('assistant.message', {
      messageId: 'assistant-1', model: 'gpt-5', content: '',
      toolRequests: [{ toolCallId: 'call-1', name: 'view', arguments: { path: 'a.ts' } }],
    }, 4),
    event('tool.execution_start', { toolCallId: 'call-1', toolName: 'view', arguments: { path: 'a.ts' } }, 5),
    event('tool.execution_complete', {
      toolCallId: 'call-1', success: true, result: { content: 'source', detailedContent: 'ignored' },
    }, 6),
    event('assistant.message', { messageId: 'assistant-2', content: 'Done', toolRequests: [] }, 7),
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${JSON.stringify(cwd)}\n`, 'utf8');

  return { adapter: new CopilotAdapter(root), cwd, file, id, root };
}

describe('CopilotAdapter', () => {
  it.each(['0.0.411', '1.0.107'] as const)('reads Copilot CLI %s messages and tools in event order', async (version) => {
    const { adapter, cwd, file, id } = fixture(version);
    const [listed] = await adapter.listConversations(cwd);

    expect(listed).toMatchObject({ sessionId: id, title: 'Fix the parser', cwd, filePath: file, messageCount: 4 });
    const session = await adapter.readSession({ sessionId: id, filePath: file });
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.messages[1]!.content).toEqual([
      { type: 'tool_call', callId: 'call-1', toolName: 'view', arguments: { path: 'a.ts' } },
    ]);
    expect(session.messages[2]!.content).toEqual([
      { type: 'tool_result', callId: 'call-1', content: 'source', isError: false },
    ]);
    expect(session.metadata).toEqual({ model: 'gpt-5', version });
  });

  it('recovers the project from workspace.yaml and matches symlinked cwd values', async () => {
    const { adapter, cwd, id } = fixture('1.0.107', true);
    const linked = path.join(path.dirname(cwd), 'linked-app');
    fs.symlinkSync(cwd, linked, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await adapter.existingSessionId(id, linked)).toBe(id);
    expect(await adapter.listConversations(linked)).toHaveLength(1);
  });

  it('lists the other sessions when one events log has a malformed line', async () => {
    const { adapter, cwd, file, id, root } = fixture();
    const brokenId = '223e4567-e89b-12d3-a456-426614174000';
    const [sessionStart, , , userMessage] = fs.readFileSync(file, 'utf8').split('\n');
    fs.mkdirSync(path.join(root, brokenId));
    fs.writeFileSync(path.join(root, brokenId, 'events.jsonl'), `${[sessionStart, '{"type":"user.message"', userMessage].join('\n')}\n`, 'utf8');

    const listed = await adapter.listConversations(cwd);

    expect(listed.map((session) => session.sessionId)).toEqual([id]);
  });

  it('rejects unsafe ids and is read-only', async () => {
    const { adapter, id } = fixture();
    expect(await adapter.existingSessionId('../session')).toBeUndefined();
    await expect(adapter.writeSession({ sessionId: id, title: '', cwd: '', platform: 'x', createdAt: '', updatedAt: '', messages: [] }))
      .rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.deleteSession(id)).resolves.toBe(false);
  });
});
