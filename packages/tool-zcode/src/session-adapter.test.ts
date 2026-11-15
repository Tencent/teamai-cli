import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseZCodeFile } from './session-adapter.js';

const fixture = path.join(import.meta.dirname, 'fixtures', 'zcode-model-io.jsonl');

describe('ZCode model-I/O parser', () => {
  it('reconstructs full and delta turns with reasoning, images and tool calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-zcode-session-'));
    const file = path.join(root, 'model-io-sess_00000000-0000-0000-0000-000000000000.jsonl');
    fs.copyFileSync(fixture, file);

    try {
      const parsed = parseZCodeFile(file)!;

      expect(parsed).toMatchObject({
        sessionId: '00000000-0000-0000-0000-000000000000', model: 'example-model',
        provider: 'example-provider', createdAt: '2026-11-15T10:00:00.000Z', updatedAt: '2026-11-15T10:00:05.000Z',
      });
      expect(parsed.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      expect(parsed.messages[1]!.content).toEqual([
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-session files and mismatched session ids', () => {
    expect(parseZCodeFile(fixture)).toBeUndefined();
  });
});
