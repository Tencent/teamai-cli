import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../session-flow/adapters/pi.js';
import { ToolUnavailableError } from '../session-flow/adapters/base.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(platform: 'pi' | 'omp', extra: Record<string, unknown>[] = []): { adapter: PiAdapter; file: string; cwd: string; id: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-${platform}-`));
  roots.push(root);
  const dir = path.join(root, '--work-app--');
  fs.mkdirSync(dir, { recursive: true });
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const cwd = path.join(root, 'work', 'app');
  const file = path.join(dir, `2026-01-02T03-04-05_${id}.jsonl`);
  const records = [
    ...(platform === 'omp' ? [{ type: 'title', v: 1, title: 'OMP title', updatedAt: '2026-01-02T03:04:00Z', pad: '' }] : []),
    { type: 'session', version: 3, id, timestamp: '2026-01-02T03:04:00Z', cwd },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-02T03:04:01Z', message: { role: 'user', content: 'Fix the parser', timestamp: 1767323041000 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-02T03:04:02Z', message: { role: 'assistant', model: 'provider/model-a', timestamp: 1767323042000, content: [
      { type: 'thinking', thinking: 'inspect', thinkingSignature: 'sig' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
    ] } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-01-02T03:04:03Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: false, timestamp: 1767323043000, content: [{ type: 'text', text: 'source' }] } },
    // An abandoned branch must not appear in the normalized conversation.
    { type: 'message', id: 'side', parentId: 'u1', timestamp: '2026-01-02T03:04:04Z', message: { role: 'assistant', model: 'provider/model-old', timestamp: 1767323044000, content: [{ type: 'text', text: 'abandoned' }] } },
    { type: 'message', id: 'a2', parentId: 'r1', timestamp: '2026-01-02T03:04:05Z', message: { role: 'assistant', model: 'provider/model-b', timestamp: 1767323045000, content: [{ type: 'text', text: 'done' }] }, activeLeafId: 'a2' },
    ...extra,
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n{partial`, 'utf8');
  return { adapter: new PiAdapter(platform, root), file, cwd, id };
}

describe('PiAdapter', () => {
  it.each(['pi', 'omp'] as const)('lists and reads the active v3 branch for %s', async (platform) => {
    const { adapter, file, cwd, id } = fixture(platform);
    const [meta] = await adapter.listConversations(cwd);
    expect(meta).toMatchObject({ sessionId: id, cwd, platform, messageCount: 4, filePath: file });
    expect(meta.title).toBe(platform === 'omp' ? 'OMP title' : 'Fix the parser');

    const session = await adapter.readSession({ sessionId: id, filePath: file });
    expect(session.messages).toHaveLength(4);
    expect(JSON.stringify(session.messages)).not.toContain('abandoned');
    expect(session.messages[1]!.content).toEqual([
      { type: 'thinking', text: 'inspect', signature: 'sig' },
      { type: 'tool_call', callId: 'call-1', toolName: 'read', arguments: { path: 'a.ts' } },
    ]);
    expect(session.messages[2]!.content[0]).toEqual({ type: 'tool_result', callId: 'call-1', content: 'source', isError: false });
    expect(session.metadata?.model).toBe('provider/model-b');
  });

  it('uses OMP title changes after the fixed first-line title slot', async () => {
    const { adapter, id } = fixture('omp', [{ type: 'title_change', id: 't1', parentId: 'a2', timestamp: '2026-01-02T03:04:06Z', title: 'Renamed', activeLeafId: 't1' }]);
    expect((await adapter.listConversations())[0]!.title).toBe('Renamed');
    expect((await adapter.readSession({ sessionId: id })).title).toBe('Renamed');
  });

  it('uses the latest model event in active-branch order', async () => {
    const { adapter, id } = fixture('pi', [{
      type: 'model_change', id: 'm1', parentId: 'a2', timestamp: '2026-01-02T03:04:06Z',
      provider: 'provider-b', modelId: 'model-c', activeLeafId: 'm1',
    }]);
    expect((await adapter.readSession({ sessionId: id })).metadata?.model).toBe('provider-b/model-c');
  });

  it('falls back to the newest entry when activeLeafId is dangling', async () => {
    const { adapter, id } = fixture('pi', [{
      type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-01-02T03:04:06Z', activeLeafId: 'missing',
      message: { role: 'assistant', model: 'provider/model-c', content: 'latest' },
    }]);
    const session = await adapter.readSession({ sessionId: id });
    expect(session.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'latest' }]);
  });

  it('filters by the cwd stored in the header and rejects unsafe ids', async () => {
    const { adapter, id, cwd } = fixture('pi');
    expect(await adapter.existingSessionId(id, cwd)).toBe(id);
    expect(await adapter.existingSessionId(id, path.join(cwd, 'other'))).toBeUndefined();
    expect(await adapter.existingSessionId('../session')).toBeUndefined();
  });

  it('is read-only and never deletes a native session', async () => {
    const { adapter, id } = fixture('pi');
    await expect(adapter.writeSession({ sessionId: id, title: '', cwd: '', platform: 'x', createdAt: '', updatedAt: '', messages: [] }))
      .rejects.toBeInstanceOf(ToolUnavailableError);
    await expect(adapter.deleteSession(id)).resolves.toBe(false);
  });
});
