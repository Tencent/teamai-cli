import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseHookEvent,
  appendEvent,
  readEvents,
  rebuildSessions,
  compactEvents,
} from '../dashboard-collector.js';
import type { DashboardEvent } from '../types.js';

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
  it('parses SessionStart event', () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'sess-123',
      cwd: '/home/jeff/project',
    });
    const event = parseHookEvent(raw, 'claude');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('session_start');
    expect(event!.sessionId).toBe('sess-123');
    expect(event!.tool).toBe('claude');
    expect(event!.cwd).toBe('/home/jeff/project');
  });

  it('parses PostToolUse event with tool_name', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'sess-123',
      tool_name: 'Edit',
      cwd: '/home/jeff/project',
    });
    const event = parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('tool_use');
    expect(event!.toolName).toBe('Edit');
  });

  it('parses UserPromptSubmit event with prompt', () => {
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-123',
      prompt: 'Fix the login bug in auth.ts',
    });
    const event = parseHookEvent(raw, 'claude-internal');
    expect(event!.type).toBe('prompt_submit');
    expect(event!.promptSummary).toBe('Fix the login bug in auth.ts');
    expect(event!.tool).toBe('claude-internal');
  });

  it('truncates long prompts to 200 chars', () => {
    const longPrompt = 'x'.repeat(500);
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-123',
      prompt: longPrompt,
    });
    const event = parseHookEvent(raw, 'claude');
    expect(event!.promptSummary!.length).toBe(200);
  });

  it('parses Stop event', () => {
    const raw = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-123',
    });
    const event = parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('stop');
  });

  it('returns null for empty input', () => {
    expect(parseHookEvent('', 'claude')).toBeNull();
    expect(parseHookEvent('   ', 'claude')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseHookEvent('not json', 'claude')).toBeNull();
  });

  it('returns null for unknown hook event', () => {
    const raw = JSON.stringify({
      hook_event_name: 'UnknownEvent',
      session_id: 'sess-123',
    });
    expect(parseHookEvent(raw, 'claude')).toBeNull();
  });

  it('falls back to PID+cwd when session_id missing', () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      cwd: '/home/jeff/project',
    });
    const event = parseHookEvent(raw, 'claude');
    expect(event!.sessionId).toMatch(/^pid-\d+-\/home\/jeff\/project$/);
  });

  it('uses CLAUDE_SESSION_ID env as fallback', () => {
    process.env.CLAUDE_SESSION_ID = 'env-sess-456';
    try {
      const raw = JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: '/home/jeff/project',
      });
      const event = parseHookEvent(raw, 'claude');
      expect(event!.sessionId).toBe('env-sess-456');
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
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

  it('removes stopped sessions', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/proj' },
      { type: 'stop', timestamp: now, sessionId: 's1', tool: 'claude' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(0);
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

  it('sorts by lastActivity descending', () => {
    const t1 = new Date(Date.now() - 60000).toISOString();
    const t2 = new Date().toISOString();
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: t1, sessionId: 's1', tool: 'claude', cwd: '/proj-a' },
      { type: 'session_start', timestamp: t2, sessionId: 's2', tool: 'claude', cwd: '/proj-b' },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions[0].sessionId).toBe('s2');
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
