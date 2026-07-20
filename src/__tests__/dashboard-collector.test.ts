import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseHookEvent,
  readLastAssistantOutput,
  countInterventions,
  appendEvent,
  readEvents,
  rebuildSessions,
  aggregateSessionInterventions,
  compactEvents,
} from '../dashboard-collector.js';
import type { DashboardEvent } from '../types.js';

// ─── Transcript fixtures for intervention scanning ──────
const INTERRUPT_LINE = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
});
const INTERRUPT_TOOL_LINE = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
});
const REJECT_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      is_error: true,
      tool_use_id: 'toolu_1',
      content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit).",
    }],
  },
});
const NORMAL_USER_LINE = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'text', text: 'please continue' }] },
});
const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'done' }] },
});
const TOOL_ERROR_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', is_error: true, tool_use_id: 'toolu_2', content: 'Error: command not found' }],
  },
});

// Use a temp dir for each test to avoid cross-test interference
let tmpDir: string;
let originalHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-test-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseHookEvent ─────────────────────────────────────

describe('parseHookEvent', () => {
  it('parses SessionStart event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'sess-123',
      cwd: '/home/jeff/project',
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('session_start');
    expect(event!.sessionId).toBe('sess-123');
    expect(event!.tool).toBe('claude');
    expect(event!.cwd).toBe('/home/jeff/project');
  });

  it('parses PostToolUse event with tool_name', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-123',
      tool_name: 'Edit',
      cwd: '/home/jeff/project',
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('tool_use');
    expect(event!.toolName).toBe('Edit');
  });

  it('parses UserPromptSubmit event with prompt', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-123',
      prompt: 'Fix the login bug in auth.ts',
    });
    const event = await parseHookEvent(raw, 'claude-internal');
    expect(event!.type).toBe('prompt_submit');
    expect(event!.promptSummary).toBe('Fix the login bug in auth.ts');
    expect(event!.tool).toBe('claude-internal');
  });

  it('truncates long prompts to 200 chars', async () => {
    const longPrompt = 'x'.repeat(500);
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-123',
      prompt: longPrompt,
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.promptSummary!.length).toBe(200);
  });

  it('parses Stop event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-123',
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('stop');
  });

  it('returns null for empty input', async () => {
    expect(await parseHookEvent('', 'claude')).toBeNull();
    expect(await parseHookEvent('   ', 'claude')).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    expect(await parseHookEvent('not json', 'claude')).toBeNull();
  });

  it('parses Cursor camelCase sessionStart event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'sessionStart',
      session_id: 'sess-cursor-1',
      cwd: '/home/jeff/project',
    });
    const event = await parseHookEvent(raw, 'cursor');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('session_start');
    expect(event!.sessionId).toBe('sess-cursor-1');
    expect(event!.tool).toBe('cursor');
  });

  it('parses Cursor camelCase stop event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'stop',
      session_id: 'sess-cursor-2',
    });
    const event = await parseHookEvent(raw, 'cursor');
    expect(event!.type).toBe('stop');
  });

  it('parses Cursor camelCase postToolUse event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'postToolUse',
      session_id: 'sess-cursor-3',
      tool_name: 'Read',
    });
    const event = await parseHookEvent(raw, 'cursor');
    expect(event!.type).toBe('tool_use');
    expect(event!.toolName).toBe('Read');
  });

  it('parses Cursor beforeSubmitPrompt event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'beforeSubmitPrompt',
      session_id: 'sess-cursor-4',
      prompt: 'Fix the bug in auth.ts',
    });
    const event = await parseHookEvent(raw, 'cursor');
    expect(event!.type).toBe('prompt_submit');
    expect(event!.promptSummary).toBe('Fix the bug in auth.ts');
  });

  it('returns null for unknown hook event', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'UnknownEvent',
      session_id: 'sess-123',
    });
    expect(await parseHookEvent(raw, 'claude')).toBeNull();
  });

  it('falls back to PID+cwd when session_id missing', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      cwd: '/home/jeff/project',
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.sessionId).toMatch(/^pid-\d+-\/home\/jeff\/project$/);
  });

  it('uses CLAUDE_SESSION_ID env as fallback', async () => {
    process.env.CLAUDE_SESSION_ID = 'env-sess-456';
    try {
      const raw = JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: '/home/jeff/project',
      });
      const event = await parseHookEvent(raw, 'claude');
      expect(event!.sessionId).toBe('env-sess-456');
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
  });

  it('captures stoppedOutput from transcript_path', async () => {
    // Create a mock transcript file
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const transcriptLines = [
      JSON.stringify({ type: 'human', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'AI response here' }] } }),
    ];
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-transcript',
      transcript_path: transcriptPath,
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('stop');
    expect(event!.stoppedOutput).toBe('AI response here');
    expect(event!.transcriptPath).toBe(transcriptPath);
  });
});

// ─── readLastAssistantOutput ──────────────────────────────

describe('readLastAssistantOutput', () => {
  it('reads last assistant message from transcript', async () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'human', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'First response' }] } }),
      JSON.stringify({ type: 'human', message: { content: [{ type: 'text', text: 'Follow up' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Final response' }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const output = await readLastAssistantOutput(transcriptPath);
    expect(output).toBe('Final response');
  });

  it('returns empty string for nonexistent file', async () => {
    const output = await readLastAssistantOutput('/nonexistent/path/transcript.jsonl');
    expect(output).toBe('');
  });

  it('returns empty string for empty file', async () => {
    const transcriptPath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const output = await readLastAssistantOutput(transcriptPath);
    expect(output).toBe('');
  });

  it('truncates output to 500 chars', async () => {
    const transcriptPath = path.join(tmpDir, 'long.jsonl');
    const longText = 'x'.repeat(1000);
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } });
    fs.writeFileSync(transcriptPath, line + '\n');

    const output = await readLastAssistantOutput(transcriptPath);
    expect(output.length).toBe(500);
  });

  it('skips malformed lines gracefully', async () => {
    const transcriptPath = path.join(tmpDir, 'malformed.jsonl');
    const lines = [
      'NOT JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Valid response' }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const output = await readLastAssistantOutput(transcriptPath);
    expect(output).toBe('Valid response');
  });

  it('redacts secrets in the assistant output before returning', async () => {
    const transcriptPath = path.join(tmpDir, 'secret.jsonl');
    const text = 'Here is the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 use it';
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    fs.writeFileSync(transcriptPath, line + '\n');

    const output = await readLastAssistantOutput(transcriptPath);
    expect(output).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(output).toContain('<REDACTED:gh_tok>');
  });
});

// ─── JSONL persistence ──────────────────────────────────

describe('appendEvent / readEvents', () => {
  it('appends and reads events', async () => {
    const event: DashboardEvent = {
      type: 'session_start',
      timestamp: '2026-03-24T22:00:00Z',
      sessionId: 'sess-001',
      tool: 'claude',
      cwd: '/home/jeff/project',
    };
    await appendEvent(event);
    await appendEvent({ ...event, type: 'tool_use', toolName: 'Edit' });

    const eventsPath = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
    const events = await readEvents(eventsPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('session_start');
    expect(events[1].toolName).toBe('Edit');
  });

  it('returns empty array when file does not exist', async () => {
    const events = await readEvents('/nonexistent/path/events.jsonl');
    expect(events).toEqual([]);
  });

  it('skips corrupted lines', async () => {
    const eventsPath = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ type: 'session_start', timestamp: 'T1', sessionId: 's1', tool: 'claude' }),
      'CORRUPTED LINE',
      JSON.stringify({ type: 'stop', timestamp: 'T2', sessionId: 's1', tool: 'claude' }),
    ].join('\n') + '\n');

    const events = await readEvents(eventsPath);
    expect(events).toHaveLength(2);
  });
});

// ─── rebuildSessions ────────────────────────────────────

describe('rebuildSessions', () => {
  const now = new Date().toISOString();

  it('creates session from session_start event', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].cwd).toBe('/proj');
  });

  it('updates session on tool_use', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'tool_use', timestamp: now, sessionId: 's1', tool: 'claude', toolName: 'Bash' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].lastTool).toBe('Bash');
    expect(sessions[0].status).toBe('running');
  });

  it('captures first prompt as summary', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's1', tool: 'claude', promptSummary: 'Fix the bug' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's1', tool: 'claude', promptSummary: 'Second prompt' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].promptSummary).toBe('Fix the bug');
  });

  it('stop event marks session as waiting_for_input (not stopped)', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('waiting_for_input');
  });

  it('stop then prompt_submit returns to running', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's1', tool: 'claude', promptSummary: 'Next question' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].status).toBe('running');
  });

  it('stop then tool_use returns to running', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
      { type: 'tool_use', timestamp: now, sessionId: 's1', tool: 'claude', toolName: 'Read' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].status).toBe('running');
  });

  it('process_exit marks session as stopped', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
      { type: 'process_exit', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('stopped');
  });

  it('keeps process_exit stopped sessions for 30 seconds', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'process_exit', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('stopped');
  });

  it('removes process_exit stopped sessions after 30 seconds', () => {
    const oldTime = new Date(Date.now() - 35 * 1000).toISOString(); // 35 sec ago
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: oldTime, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'process_exit', timestamp: oldTime, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(0);
  });

  it('propagates monitorPid from session_start', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj', monitorPid: 12345 },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].monitorPid).toBe(12345);
  });

  it('sessions without monitorPid still work (backward compat)', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].monitorPid).toBeUndefined();
    expect(sessions[0].status).toBe('waiting_for_input');
  });

  it('collects all prompts in session', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's1', tool: 'claude', promptSummary: 'First prompt' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's1', tool: 'claude', promptSummary: 'Second prompt' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].prompts).toEqual(['First prompt', 'Second prompt']);
    expect(sessions[0].promptSummary).toBe('First prompt');
  });

  it('captures stoppedOutput from stop event', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude', stoppedOutput: 'AI final output' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].stoppedOutput).toBe('AI final output');
  });

  it('sorts active sessions before stopped sessions', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'process_exit', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'session_start', timestamp: now, sessionId: 's2', tool: 'claude', cwd: '/proj2' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe('s2'); // active first
    expect(sessions[1].sessionId).toBe('s1'); // stopped last
  });

  it('marks idle sessions after timeout', () => {
    const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: oldTime, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].status).toBe('idle');
  });

  it('removes stale sessions after 30 min', () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // 31 min ago
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: staleTime, sessionId: 's1', tool: 'claude', cwd: '/proj' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(0);
  });

  it('handles multiple concurrent sessions', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj-a' },
      { type: 'session_start', timestamp: now, sessionId: 's2', tool: 'claude-internal', cwd: '/proj-b' },
      { type: 'tool_use', timestamp: now, sessionId: 's1', tool: 'claude', toolName: 'Edit' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(2);
    const s1 = sessions.find(s => s.sessionId === 's1');
    const s2 = sessions.find(s => s.sessionId === 's2');
    expect(s1!.cwd).toBe('/proj-a');
    expect(s2!.cwd).toBe('/proj-b');
  });

  it('sorts by total runtime descending', () => {
    // s1 started 5 min ago (longer runtime), s2 started 1 min ago (shorter runtime)
    const t1 = new Date(Date.now() - 5 * 60000).toISOString();
    const t2 = new Date(Date.now() - 60000).toISOString();
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: t1, sessionId: 's1', tool: 'claude', cwd: '/proj-a' },
      { type: 'session_start', timestamp: t2, sessionId: 's2', tool: 'claude', cwd: '/proj-b' },
    ];
    const sessions = rebuildSessions(events);
    // s1 has longer total runtime, should come first
    expect(sessions[0].sessionId).toBe('s1');
  });
});

// ─── countInterventions (Issue #34) ─────────────────────

describe('countInterventions', () => {
  function writeTranscript(name: string, lines: string[]): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  }

  it('counts user interrupts (both variants)', async () => {
    const p = writeTranscript('t1.jsonl', [ASSISTANT_LINE, INTERRUPT_LINE, INTERRUPT_TOOL_LINE]);
    const iv = await countInterventions(p);
    expect(iv.interrupt).toBe(2);
    expect(iv.toolReject).toBe(0);
  });

  it('counts tool rejections', async () => {
    const p = writeTranscript('t2.jsonl', [ASSISTANT_LINE, REJECT_LINE, ASSISTANT_LINE, REJECT_LINE]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(2);
    expect(iv.interrupt).toBe(0);
  });

  it('does not count ordinary tool errors as rejections, but counts them as toolError', async () => {
    const p = writeTranscript('t3.jsonl', [TOOL_ERROR_LINE, NORMAL_USER_LINE, ASSISTANT_LINE]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(0);
    expect(iv.interrupt).toBe(0);
    expect(iv.toolError).toBe(1);
  });

  it('counts multiple genuine tool errors (retry struggle signal)', async () => {
    const p = writeTranscript('t3b.jsonl', [
      TOOL_ERROR_LINE, ASSISTANT_LINE, TOOL_ERROR_LINE, ASSISTANT_LINE, TOOL_ERROR_LINE,
    ]);
    const iv = await countInterventions(p);
    expect(iv.toolError).toBe(3);
    expect(iv.toolReject).toBe(0);
  });

  it('separates rejections from errors in a mixed transcript', async () => {
    const p = writeTranscript('t3c.jsonl', [REJECT_LINE, TOOL_ERROR_LINE, REJECT_LINE, TOOL_ERROR_LINE]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(2);
    expect(iv.toolError).toBe(2);
  });

  it('counts a mix of interrupts and rejections', async () => {
    const p = writeTranscript('t4.jsonl', [INTERRUPT_LINE, REJECT_LINE, NORMAL_USER_LINE, ASSISTANT_LINE, REJECT_LINE]);
    const iv = await countInterventions(p);
    expect(iv.interrupt).toBe(1);
    expect(iv.toolReject).toBe(2);
  });

  it('returns zeros for nonexistent file', async () => {
    const iv = await countInterventions('/nonexistent/transcript.jsonl');
    expect(iv).toEqual({ interrupt: 0, toolReject: 0, toolError: 0 });
  });

  it('returns zeros for empty file', async () => {
    const p = writeTranscript('empty.jsonl', []);
    fs.writeFileSync(p, '');
    const iv = await countInterventions(p);
    expect(iv).toEqual({ interrupt: 0, toolReject: 0, toolError: 0 });
  });

  it('skips malformed lines gracefully', async () => {
    const p = writeTranscript('t5.jsonl', ['NOT JSON', INTERRUPT_LINE, '{bad', REJECT_LINE]);
    const iv = await countInterventions(p);
    expect(iv.interrupt).toBe(1);
    expect(iv.toolReject).toBe(1);
  });
});

// ─── parseHookEvent: interventions on Stop ──────────────

describe('parseHookEvent interventions', () => {
  it('attaches intervention snapshot from transcript on Stop', async () => {
    const transcriptPath = path.join(tmpDir, 'stop-transcript.jsonl');
    fs.writeFileSync(transcriptPath, [ASSISTANT_LINE, INTERRUPT_LINE, REJECT_LINE].join('\n') + '\n');
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-iv',
      transcript_path: transcriptPath,
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.interventions).toEqual({ interrupt: 1, toolReject: 1, toolError: 0 });
  });

  it('attaches toolError-only snapshot when transcript has plain tool failures', async () => {
    const transcriptPath = path.join(tmpDir, 'stop-toolerror.jsonl');
    fs.writeFileSync(transcriptPath, [ASSISTANT_LINE, TOOL_ERROR_LINE, TOOL_ERROR_LINE].join('\n') + '\n');
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-te',
      transcript_path: transcriptPath,
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.interventions).toEqual({ interrupt: 0, toolReject: 0, toolError: 2 });
  });

  it('omits interventions field when transcript has none', async () => {
    const transcriptPath = path.join(tmpDir, 'clean-transcript.jsonl');
    fs.writeFileSync(transcriptPath, [ASSISTANT_LINE, NORMAL_USER_LINE].join('\n') + '\n');
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-clean',
      transcript_path: transcriptPath,
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.interventions).toBeUndefined();
  });
});

// ─── rebuildSessions: intervention aggregation ──────────

describe('rebuildSessions interventions', () => {
  const now = new Date().toISOString();

  it('defaults to zero interventions', () => {
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/p' },
    ]);
    expect(sessions[0].interventions).toEqual({ interrupt: 0, toolReject: 0, correction: 0 });
    expect(sessions[0].interventionCount).toBe(0);
  });

  it('takes interrupt/toolReject from the latest stop snapshot (idempotent)', () => {
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude', interventions: { interrupt: 1, toolReject: 0 } },
      { type: 'tool_use', timestamp: now, sessionId: 's1', tool: 'claude', toolName: 'Bash' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude', interventions: { interrupt: 2, toolReject: 1 } },
    ]);
    // Latest snapshot wins — not summed
    expect(sessions[0].interventions.interrupt).toBe(2);
    expect(sessions[0].interventions.toolReject).toBe(1);
    expect(sessions[0].interventionCount).toBe(3);
  });

  it('counts a correction: prompt within window with keyword', () => {
    const t0 = new Date();
    const stopT = t0.toISOString();
    const promptT = new Date(t0.getTime() + 10_000).toISOString(); // +10s
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: stopT, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: stopT, sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: promptT, sessionId: 's1', tool: 'claude', promptSummary: '不对，重来' },
    ]);
    expect(sessions[0].interventions.correction).toBe(1);
    expect(sessions[0].interventionCount).toBe(1);
  });

  it('does not count a normal follow-up prompt as correction', () => {
    const t0 = new Date();
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 5_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '继续下一步，部署到测试环境' },
    ]);
    expect(sessions[0].interventions.correction).toBe(0);
  });

  it('does not count a correction-keyword prompt outside the time window', () => {
    const t0 = new Date();
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 120_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '错了，改一下' },
    ]);
    expect(sessions[0].interventions.correction).toBe(0);
  });

  it('aggregates all three intervention types together', () => {
    const t0 = new Date();
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', interventions: { interrupt: 1, toolReject: 2 } },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 3_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: 'wrong, redo it' },
    ]);
    expect(sessions[0].interventions).toEqual({ interrupt: 1, toolReject: 2, correction: 1 });
    expect(sessions[0].interventionCount).toBe(4);
  });
});

// ─── aggregateSessionInterventions ──────────────────────

describe('aggregateSessionInterventions', () => {
  const now = new Date().toISOString();

  it('returns counts per session without timeout filtering', () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago (would be dropped by rebuild)
    const map = aggregateSessionInterventions([
      { type: 'session_start', timestamp: stale, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: stale, sessionId: 's1', tool: 'claude', interventions: { interrupt: 3, toolReject: 0 } },
      { type: 'session_start', timestamp: now, sessionId: 's2', tool: 'claude', cwd: '/p' },
    ]);
    // s1 retained even though stale
    expect(map.get('s1')).toEqual({ interrupt: 3, toolReject: 0, correction: 0 });
    expect(map.get('s2')).toEqual({ interrupt: 0, toolReject: 0, correction: 0 });
  });

  it('consumes each stop once for correction detection', () => {
    const t0 = new Date();
    const map = aggregateSessionInterventions([
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 1_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '不对' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 2_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '不对' },
    ]);
    // Only the first prompt consumes the stop
    expect(map.get('s1')!.correction).toBe(1);
  });
});

// ─── compactEvents ──────────────────────────────────────

describe('compactEvents', () => {
  it('does not compact when below threshold', async () => {
    const eventsPath = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    const event = { type: 'session_start', timestamp: new Date().toISOString(), sessionId: 's1', tool: 'claude' };
    fs.writeFileSync(eventsPath, JSON.stringify(event) + '\n');

    await compactEvents(eventsPath);

    const content = fs.readFileSync(eventsPath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });
});
