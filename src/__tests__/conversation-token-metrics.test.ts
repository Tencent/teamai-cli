import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanTranscriptStop,
  aggregateSessionMetrics,
  rebuildSessions,
} from '../dashboard-collector.js';
import { computePromptTokenDelta, mergePromptTokenStats } from '../team-push.js';
import { summarizeConversation, formatTokenCount } from '../digest.js';
import type { DashboardEvent, SessionMetrics, TokenUsage, UserStats } from '../types.js';

let tmpDir: string;
let originalHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-convtok-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// An assistant transcript line carrying token usage for one message id.
function assistantLine(id: string, usage: Partial<Record<string, number>>, blockType = 'text'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
      content: [{ type: blockType, text: 'x' }],
    },
  });
}

function writeTranscript(lines: string[]): string {
  const p = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// ─── scanTranscriptStop: token summing + dedup ──────────

describe('scanTranscriptStop — token usage', () => {
  it('sums input/output/cache tokens across assistant messages', async () => {
    const p = writeTranscript([
      assistantLine('msg_1', { input: 100, output: 20, cacheRead: 50, cacheCreation: 10 }),
      assistantLine('msg_2', { input: 40, output: 5, cacheRead: 0, cacheCreation: 3 }),
    ]);
    const { tokens } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 140, output: 25, cacheRead: 50, cacheCreation: 13 });
  });

  it('deduplicates usage by message.id (multi-line turns count once)', async () => {
    // Claude Code repeats the same usage on every content-block line of one turn.
    const dup = assistantLine('msg_dup', { input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
    const dupToolBlock = assistantLine('msg_dup', { input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 }, 'tool_use');
    const p = writeTranscript([dup, dupToolBlock, dup]);
    const { tokens } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 1000, output: 200, cacheRead: 300, cacheCreation: 50 });
  });

  it('returns zero tokens for a transcript with no usage', async () => {
    const p = writeTranscript([JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })]);
    const { tokens } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it('ignores non-numeric / missing usage fields gracefully', async () => {
    const p = writeTranscript([
      JSON.stringify({ type: 'assistant', message: { id: 'm', usage: { input_tokens: 'oops', output_tokens: 7 }, content: [] } }),
    ]);
    const { tokens } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 0, output: 7, cacheRead: 0, cacheCreation: 0 });
  });

  it('parses CodeBuddy index.json (requests[].usage + user messages)', async () => {
    // CodeBuddy persists a single index.json, not Claude JSONL. Tokens live in
    // requests[].usage.{inputTokens,outputTokens}; prompts = user messages.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cb-'));
    const p = path.join(dir, 'index.json');
    fs.writeFileSync(p, JSON.stringify({
      messages: [
        { id: 'a', role: 'user' },
        { id: 'b', role: 'assistant' },
        { id: 'c', role: 'tool' },
        { id: 'd', role: 'user' },
      ],
      requests: [
        { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { usage: { inputTokens: 215609, outputTokens: 2967, totalTokens: 218576 } },
      ],
    }));
    const { tokens, prompts } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 215609, output: 2967, cacheRead: 0, cacheCreation: 0 });
    expect(prompts).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries CodeBuddy index.json until usage is flushed after Stop', async () => {
    // CodeBuddy writes requests[].usage a moment AFTER firing the Stop hook, so the
    // first read sees zero usage. The scanner must retry until usage appears —
    // otherwise single-turn sessions would record 0 tokens permanently.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cb-race-'));
    const p = path.join(dir, 'index.json');
    const messages = [{ id: 'a', role: 'user' }];
    // Initial snapshot: message present, usage not yet flushed (all zero).
    fs.writeFileSync(p, JSON.stringify({ messages, requests: [{ usage: { inputTokens: 0, outputTokens: 0 } }] }));
    // Flush real usage shortly after the scan starts (mimics CodeBuddy's late write).
    const timer = setTimeout(() => {
      fs.writeFileSync(p, JSON.stringify({ messages, requests: [{ usage: { inputTokens: 1200, outputTokens: 88 } }] }));
    }, 300);

    const { tokens, prompts } = await scanTranscriptStop(p);
    clearTimeout(timer);
    expect(tokens).toEqual({ input: 1200, output: 88, cacheRead: 0, cacheCreation: 0 });
    expect(prompts).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to requestId for dedup when message.id is missing', async () => {
    const line = (extra: object) => JSON.stringify({
      type: 'assistant',
      requestId: 'req_1',
      message: { usage: { input_tokens: 100, output_tokens: 10 }, content: [extra] },
    });
    // Same requestId across two content-block lines → counted once.
    const p = writeTranscript([line({ type: 'text', text: 'a' }), line({ type: 'tool_use', id: 't' })]);
    const { tokens } = await scanTranscriptStop(p);
    expect(tokens).toEqual({ input: 100, output: 10, cacheRead: 0, cacheCreation: 0 });
  });
});

// ─── scanTranscriptStop: human prompt counting ──────────

describe('scanTranscriptStop — prompt counting', () => {
  const userText = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });
  const userString = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
  const toolResult = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
  const interruptLine = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  const metaLine = (text: string) => JSON.stringify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } });
  const sidechainLine = (text: string) => JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'text', text }] } });

  it('counts genuine human turns and excludes tool_results, interrupts, meta/sidechain', async () => {
    const p = writeTranscript([
      userText('first real prompt'),
      toolResult(),               // not a human turn
      userString('second prompt'), // plain string content counts
      interruptLine(),            // interrupt, not a prompt
      metaLine('injected reminder'), // meta, excluded
      sidechainLine('sub-agent'), // sidechain, excluded
      userText('third prompt'),
    ]);
    const { prompts, interrupt } = await scanTranscriptStop(p);
    expect(prompts).toBe(3);
    expect(interrupt).toBe(1);
  });

  it('excludes <task-notification> system messages from prompt count', async () => {
    const taskNotif = '<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_01X</tool-use-id>\n<output-file>/tmp/out</output-file>\n</task-notification>';
    const p = writeTranscript([
      userText('real prompt from user'),
      userString(taskNotif),       // system-injected, not human
      userText(taskNotif),         // also system-injected in array form
      userText('another real prompt'),
    ]);
    const { prompts } = await scanTranscriptStop(p);
    expect(prompts).toBe(2);
  });
});

// ─── aggregateSessionMetrics: prompts + tokens ──────────

describe('aggregateSessionMetrics', () => {
  it('counts prompt_submit events as conversation turns', () => {
    const ts = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'do a' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'do b' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'do c' },
    ];
    const m = aggregateSessionMetrics(events).get('s1')!;
    expect(m.prompts).toBe(3);
  });

  it('takes the latest Stop token snapshot (idempotent)', () => {
    const ts = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', tokens: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 } },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', tokens: { input: 30, output: 4, cacheRead: 2, cacheCreation: 1 } },
    ];
    const m = aggregateSessionMetrics(events).get('s1')!;
    expect(m.tokens).toEqual({ input: 30, output: 4, cacheRead: 2, cacheCreation: 1 });
  });

  it('prefers the Stop prompt snapshot over the live submit count (max)', () => {
    const ts = new Date().toISOString();
    // Only 2 prompt_submit events survive in the log, but the transcript snapshot
    // says 12 — the durable snapshot wins.
    const events: DashboardEvent[] = [
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'a' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'b' },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', prompts: 12 },
    ];
    expect(aggregateSessionMetrics(events).get('s1')!.prompts).toBe(12);
  });

  it('uses live submit count before any Stop snapshot exists', () => {
    const ts = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'a' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'b' },
    ];
    expect(aggregateSessionMetrics(events).get('s1')!.prompts).toBe(2);
  });

  // Regression for the PR #78 review: a session compacted out of events.jsonl and
  // resumed under the same id must keep reporting new prompts. The Stop transcript
  // snapshot (compaction-proof) keeps cur.prompts above the reported baseline so the
  // delta stays positive — unlike the old compactable prompt_submit count.
  it('keeps prompts reportable after compaction + same-session resume', () => {
    const ts = new Date().toISOString();
    // Post-compaction + resume: only the resumed events remain in the log, but the
    // Stop snapshot reflects the full transcript (10 old + 2 new = 12 prompts).
    const resumedEvents: DashboardEvent[] = [
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'new-1' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'new-2' },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', prompts: 12 },
    ];
    const metrics = aggregateSessionMetrics(resumedEvents);
    expect(metrics.get('s1')!.prompts).toBe(12);

    // Baseline already reported 10 prompts before compaction.
    const reported = { s1: { prompts: 10, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } };
    const { delta } = computePromptTokenDelta(metrics, reported);
    expect(delta.prompts).toBe(2); // the 2 post-resume turns are still reported
  });
});

// ─── rebuildSessions: promptCount + tokens on the card ──

describe('rebuildSessions — conversation + token fields', () => {
  it('exposes promptCount and tokens on the session', () => {
    const ts = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'a' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'b' },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', tokens: { input: 200, output: 30, cacheRead: 10, cacheCreation: 5 } },
    ];
    const session = rebuildSessions(events).find((s) => s.sessionId === 's1')!;
    expect(session.promptCount).toBe(2);
    expect(session.tokens).toEqual({ input: 200, output: 30, cacheRead: 10, cacheCreation: 5 });
  });

  it('defaults to zero tokens for tools without a transcript', () => {
    const ts = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'cursor', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'cursor', promptSummary: 'a' },
    ];
    const session = rebuildSessions(events).find((s) => s.sessionId === 's1')!;
    expect(session.promptCount).toBe(1);
    expect(session.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });
});

// ─── computePromptTokenDelta / mergePromptTokenStats ────

function metrics(prompts: number, tokens: TokenUsage): SessionMetrics {
  return { interrupt: 0, toolReject: 0, correction: 0, prompts, tokens };
}

describe('computePromptTokenDelta', () => {
  it('counts a brand-new session fully', () => {
    const current = new Map([['s1', metrics(3, { input: 100, output: 20, cacheRead: 5, cacheCreation: 2 })]]);
    const { delta, nextReported } = computePromptTokenDelta(current, {});
    expect(delta.prompts).toBe(3);
    expect(delta.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheCreation: 2 });
    expect(nextReported.s1).toEqual({ prompts: 3, tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 2 } });
  });

  it('is idempotent — re-reporting the same snapshot yields zero delta', () => {
    const cur = metrics(3, { input: 100, output: 20, cacheRead: 5, cacheCreation: 2 });
    const reported = { s1: { prompts: cur.prompts, tokens: cur.tokens } };
    const { delta } = computePromptTokenDelta(new Map([['s1', cur]]), reported);
    expect(delta.prompts).toBe(0);
    expect(delta.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });

  it('reports only the positive change since last report', () => {
    const current = new Map([['s1', metrics(5, { input: 300, output: 40, cacheRead: 10, cacheCreation: 4 })]]);
    const reported = { s1: { prompts: 2, tokens: { input: 100, output: 40, cacheRead: 10, cacheCreation: 1 } } };
    const { delta } = computePromptTokenDelta(current, reported);
    expect(delta.prompts).toBe(3);
    expect(delta.tokens).toEqual({ input: 200, output: 0, cacheRead: 0, cacheCreation: 3 });
  });

  it('never produces negative deltas if a snapshot shrinks', () => {
    const current = new Map([['s1', metrics(1, { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 })]]);
    const reported = { s1: { prompts: 9, tokens: { input: 999, output: 0, cacheRead: 0, cacheCreation: 0 } } };
    const { delta } = computePromptTokenDelta(current, reported);
    expect(delta.prompts).toBe(0);
    expect(delta.tokens.input).toBe(0);
  });
});

describe('mergePromptTokenStats', () => {
  it('initializes from undefined existing', () => {
    const out = mergePromptTokenStats(undefined, undefined, { prompts: 3, tokens: { input: 10, output: 2, cacheRead: 1, cacheCreation: 0 } });
    expect(out).toEqual({ prompts: 3, tokens: { input: 10, output: 2, cacheRead: 1, cacheCreation: 0 } });
  });

  it('accumulates onto existing totals', () => {
    const out = mergePromptTokenStats(
      5,
      { input: 100, output: 10, cacheRead: 5, cacheCreation: 2 },
      { prompts: 2, tokens: { input: 50, output: 5, cacheRead: 0, cacheCreation: 1 } },
    );
    expect(out).toEqual({ prompts: 7, tokens: { input: 150, output: 15, cacheRead: 5, cacheCreation: 3 } });
  });
});

// ─── digest: summarizeConversation + formatTokenCount ───

describe('formatTokenCount', () => {
  it('formats small / K / M ranges', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(2_000_000)).toBe('2.0M');
  });
});

describe('summarizeConversation', () => {
  function user(username: string, prompts: number, tokens: TokenUsage): UserStats {
    return { username, updatedAt: '', skills: {}, prompts, tokens };
  }

  it('returns null when no user reported prompts or tokens', () => {
    expect(summarizeConversation([{ username: 'a', updatedAt: '', skills: {} }])).toBeNull();
  });

  it('totals prompts and tokens and ranks users by token usage', () => {
    const stats = [
      user('alice', 10, { input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 }),
      user('bob', 4, { input: 5000, output: 500, cacheRead: 0, cacheCreation: 0 }),
    ];
    const s = summarizeConversation(stats)!;
    expect(s.totalPrompts).toBe(14);
    expect(s.tokens).toEqual({ input: 6000, output: 600, cacheRead: 0, cacheCreation: 0 });
    expect(s.totalTokens).toBe(6600);
    expect(s.ranked[0].username).toBe('bob'); // higher token usage first
  });
});
