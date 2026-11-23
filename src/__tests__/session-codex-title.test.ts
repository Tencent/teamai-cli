import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import { typedIn } from '../skill-use.js';
import { getAdapter } from '../session-flow/adapters/index.js';

const ID = '019a0000-0000-7000-8000-0000000000cc';

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-title-')));
  mocks.home = path.join(root, 'home');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plantRollout(cwd: string, typed: string, events: object[] = []): void {
  const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-00-${ID}.jsonl`), [
    { type: 'session_meta', payload: { id: ID, timestamp: '2026-10-20T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.163.0' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nAlways write tests.\n</INSTRUCTIONS>` }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: typed }] } },
    ...events,
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } },
  ].map((record) => `${JSON.stringify({ timestamp: '2026-10-20T10:00:01.000Z', ...record })}\n`).join(''));
}

describe('Codex session titles', () => {
  it.each([
    { type: 'user_message', message: 'Fix the retry loop.' },
    { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Fix the retry loop.' }] } },
  ])('preserves injected text without treating it as typed input with $type events', async (payload) => {
    plantRollout(path.join(root, 'app'), 'Fix the retry loop.', [{ type: 'event_msg', payload }]);
    const read = await getAdapter('codex').readSession({ sessionId: ID });

    expect(read.messages[0]?.metadata?.synthetic).toBe(true);
    expect(read.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Always write tests.') });
    expect(read.messages.flatMap((message) => message.content.map((block) => typedIn(message, block))).filter(Boolean))
      .toEqual(['Fix the retry loop.']);
  });

  it('are the member\'s own first line, also when it starts with the file it names', async () => {
    const cwd = path.join(root, 'app');
    plantRollout(cwd, '/work/app/src/client.ts drops the retry header\nFix it and add a test.');
    const codex = getAdapter('codex');

    const [listed] = await codex.listConversations();
    const read = await codex.readSession({ sessionId: ID });

    expect(listed?.title).toBe('/work/app/src/client.ts drops the retry header');
    expect(read.title).toBe('/work/app/src/client.ts drops the retry header');
  });
});
