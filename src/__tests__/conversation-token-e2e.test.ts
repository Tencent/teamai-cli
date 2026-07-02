import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  dashboardReport,
  readEvents,
  rebuildSessions,
  aggregateSessionMetrics,
} from '../dashboard-collector.js';
import { computePromptTokenDelta, mergePromptTokenStats } from '../team-push.js';
import { summarizeConversation } from '../digest.js';
import type { UserStats } from '../types.js';

// ─── End-to-end: conversation-turn count + token usage ───
//
//  hook STDIN ──dashboardReport()──▶ events.jsonl ──rebuildSessions──▶ session cards
//                                          │
//                                          ▼
//                       aggregate → delta → stats/<user>.yaml → digest
//

let tmpDir: string;
let originalHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ct-e2e-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runHook(payload: Record<string, unknown>, tool = 'claude'): Promise<void> {
  const raw = JSON.stringify(payload);
  const fake = Readable.from([Buffer.from(raw, 'utf-8')]) as Readable & { isTTY?: boolean };
  fake.isTTY = false;
  const orig = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    await dashboardReport(tool);
  } finally {
    Object.defineProperty(process, 'stdin', orig);
  }
}

/**
 * Write a transcript that mirrors the real Claude Code schema, including the
 * quirk that a single assistant turn (one message.id) is split across multiple
 * content-block lines that each repeat the SAME usage object.
 */
function writeTranscript(): string {
  const p = path.join(tmpDir, 'transcript.jsonl');
  const usage1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
  const usage2 = { input_tokens: 20, output_tokens: 80, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 };
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'create hello.txt' }] } }),
    // Turn 1: one message id, two content-block lines (text + tool_use), same usage repeated.
    JSON.stringify({ type: 'assistant', message: { id: 'msg_A', usage: usage1, content: [{ type: 'text', text: 'sure' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_A', usage: usage1, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
    // Turn 2: different message id.
    JSON.stringify({ type: 'assistant', message: { id: 'msg_B', usage: usage2, content: [{ type: 'text', text: 'done' }] } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('conversation + token metric — end to end', () => {
  it('captures prompt count + deduped token usage through the full pipeline', async () => {
    const sessionId = 'ct-e2e-1';
    const cwd = '/home/jeff/project';
    const transcriptPath = writeTranscript();

    // A realistic hook sequence: two human turns, one tool use, then stop.
    await runHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd });
    await runHook({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: 'create hello.txt' });
    await runHook({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd, tool_name: 'Write' });
    await runHook({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: 'now add a comment' });
    await runHook({ hook_event_name: 'Stop', session_id: sessionId, cwd, transcript_path: transcriptPath });

    // Events persisted; Stop carries the deduped token snapshot.
    const events = await readEvents();
    const stopEvent = events.find((e) => e.type === 'stop')!;
    // msg_A counted once (not twice) + msg_B:
    expect(stopEvent.tokens).toEqual({ input: 120, output: 130, cacheRead: 2500, cacheCreation: 200 });

    // Dashboard rebuild surfaces prompt count + tokens on the card.
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.promptCount).toBe(2);
    expect(s.tokens).toEqual({ input: 120, output: 130, cacheRead: 2500, cacheCreation: 200 });

    // Team reporting: delta → stats → digest.
    const metrics = aggregateSessionMetrics(events);
    const { delta, nextReported } = computePromptTokenDelta(metrics, {});
    expect(delta.prompts).toBe(2);
    expect(delta.tokens).toEqual({ input: 120, output: 130, cacheRead: 2500, cacheCreation: 200 });

    const merged = mergePromptTokenStats(undefined, undefined, delta);
    const userStats: UserStats = {
      username: 'jeff',
      updatedAt: new Date().toISOString(),
      skills: {},
      prompts: merged.prompts,
      tokens: merged.tokens,
    };
    const summary = summarizeConversation([userStats])!;
    expect(summary.totalPrompts).toBe(2);
    expect(summary.totalTokens).toBe(120 + 130 + 2500 + 200);
    expect(summary.ranked[0].username).toBe('jeff');

    // Idempotent: re-reporting the same events yields no new delta.
    const second = computePromptTokenDelta(metrics, nextReported);
    expect(second.delta.prompts).toBe(0);
    expect(second.delta.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it('degrades gracefully for tools with no transcript (Cursor): prompts only, zero tokens', async () => {
    const sessionId = 'ct-e2e-cursor';
    const cwd = '/home/jeff/project';

    await runHook({ hook_event_name: 'sessionStart', session_id: sessionId, cwd }, 'cursor');
    await runHook({ hook_event_name: 'beforeSubmitPrompt', session_id: sessionId, cwd, prompt: 'hi' }, 'cursor');
    await runHook({ hook_event_name: 'stop', session_id: sessionId, cwd }, 'cursor');

    const events = await readEvents();
    const sessions = rebuildSessions(events);
    const s = sessions[0];
    expect(s.promptCount).toBe(1);
    expect(s.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });
});
