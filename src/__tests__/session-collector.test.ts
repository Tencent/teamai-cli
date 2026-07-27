import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectSession,
  isValuable,
  renderSessionMarkdown,
  appendMonthlyLog,
  pruneMonthlyLogs,
  monthKey,
} from '../session-collector.js';
import type { DashboardEvent } from '../types.js';

function ev(partial: Partial<DashboardEvent> & { type: DashboardEvent['type']; timestamp: string; sessionId: string }): DashboardEvent {
  return { tool: 'claude', ...partial } as DashboardEvent;
}

const SID = 'aaaabbbb-1111-2222-3333-444455556666';

function sampleEvents(): DashboardEvent[] {
  return [
    ev({ type: 'session_start', timestamp: '2026-03-10T09:00:00.000Z', sessionId: SID, cwd: '/home/u/proj' }),
    ev({ type: 'prompt_submit', timestamp: '2026-03-10T09:00:05.000Z', sessionId: SID, promptSummary: 'help me fix the bug' }),
    ev({ type: 'tool_use', timestamp: '2026-03-10T09:00:10.000Z', sessionId: SID, toolName: 'Edit' }),
    ev({ type: 'tool_use', timestamp: '2026-03-10T09:00:12.000Z', sessionId: SID, toolName: 'Bash' }),
    ev({ type: 'tool_use', timestamp: '2026-03-10T09:00:14.000Z', sessionId: SID, toolName: 'Edit' }),
    ev({ type: 'tool_use', timestamp: '2026-03-10T09:00:16.000Z', sessionId: SID, toolName: 'Read' }),
    ev({ type: 'stop', timestamp: '2026-03-10T09:05:00.000Z', sessionId: SID, interventions: { interrupt: 1, toolReject: 0 }, prompts: 1 }),
  ];
}

describe('collectSession', () => {
  it('returns null for an unknown session id', () => {
    expect(collectSession('nope', sampleEvents())).toBeNull();
  });

  it('folds tool counts, interventions, and timing for one session', () => {
    const s = collectSession(SID, sampleEvents())!;
    expect(s.toolCounts).toEqual({ Edit: 2, Bash: 1, Read: 1 });
    expect(s.toolTotal).toBe(4);
    expect(s.distinctTools).toBe(3);
    expect(s.interventions.interrupt).toBe(1);
    expect(s.interventionCount).toBe(1);
    expect(s.prompts).toBe(1);
    expect(s.startedAt).toBe('2026-03-10T09:00:00.000Z');
    expect(s.endedAt).toBe('2026-03-10T09:05:00.000Z');
    expect(s.cwd).toBe('/home/u/proj');
  });

  it('only counts events for the requested session', () => {
    const events = [
      ...sampleEvents(),
      ev({ type: 'tool_use', timestamp: '2026-03-10T09:01:00.000Z', sessionId: 'other', toolName: 'Grep' }),
    ];
    const s = collectSession(SID, events)!;
    expect(s.toolCounts.Grep).toBeUndefined();
  });

  it('redacts secrets in the first prompt', () => {
    const events = [
      ev({ type: 'prompt_submit', timestamp: '2026-03-10T09:00:05.000Z', sessionId: SID, promptSummary: 'deploy with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }),
      ev({ type: 'stop', timestamp: '2026-03-10T09:00:06.000Z', sessionId: SID }),
    ];
    const s = collectSession(SID, events)!;
    expect(s.firstPrompt).toContain('<REDACTED:gh_tok>');
    expect(s.firstPrompt).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
});

describe('isValuable', () => {
  it('is valuable with any intervention', () => {
    expect(isValuable({ interventionCount: 1, distinctTools: 1 })).toBe(true);
  });
  it('is valuable with 3+ distinct tools', () => {
    expect(isValuable({ interventionCount: 0, distinctTools: 3 })).toBe(true);
  });
  it('is not valuable for trivial sessions', () => {
    expect(isValuable({ interventionCount: 0, distinctTools: 1 })).toBe(false);
  });
});

describe('renderSessionMarkdown', () => {
  it('renders a self-contained block with heading and stats', () => {
    const s = collectSession(SID, sampleEvents())!;
    const md = renderSessionMarkdown(s);
    expect(md).toContain('### 2026-03-10 · aaaabbbb · claude');
    expect(md).toContain('Tools: 4 (3 distinct)');
    expect(md).toContain('interrupt 1');
  });

  it('omits the first-prompt line by default', () => {
    const s = collectSession(SID, sampleEvents())!;
    expect(renderSessionMarkdown(s)).not.toContain('First ask:');
  });

  it('includes the first-prompt line only when includePrompt is set', () => {
    const s = collectSession(SID, sampleEvents())!;
    expect(renderSessionMarkdown(s, { includePrompt: true })).toContain('First ask: help me fix the bug');
  });
});

describe('appendMonthlyLog / pruneMonthlyLogs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sesslog-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a monthly file with a header on first write', async () => {
    const s = collectSession(SID, sampleEvents())!;
    const file = await appendMonthlyLog(dir, s);
    expect(file).toBe(path.join(dir, '2026-03.md'));
    const content = fs.readFileSync(file!, 'utf-8');
    expect(content).toContain('# Session log — 2026-03');
    expect(content).toContain('aaaabbbb');
  });

  it('is idempotent for the same session', async () => {
    const s = collectSession(SID, sampleEvents())!;
    expect(await appendMonthlyLog(dir, s)).not.toBeNull();
    expect(await appendMonthlyLog(dir, s)).toBeNull();
    const content = fs.readFileSync(path.join(dir, '2026-03.md'), 'utf-8');
    // Header appears once; the session is recorded once (its full-id marker).
    expect(content.match(/# Session log/g)!.length).toBe(1);
    expect(content.match(/<!-- teamai:session /g)!.length).toBe(1);
  });

  it('records two distinct sessions that share an 8-char id prefix', async () => {
    // Same shortId ("aaaabbbb"), different full ids: the old `· <shortId> ·`
    // marker would have collapsed these into one. The full-id marker keeps them.
    const COLLIDING = 'aaaabbbb-9999-8888-7777-666655554444';
    const a = collectSession(SID, sampleEvents())!;
    const b = collectSession(COLLIDING, [
      ev({ type: 'session_start', timestamp: '2026-03-10T10:00:00.000Z', sessionId: COLLIDING }),
      ev({ type: 'tool_use', timestamp: '2026-03-10T10:00:10.000Z', sessionId: COLLIDING, toolName: 'Edit' }),
      ev({ type: 'stop', timestamp: '2026-03-10T10:05:00.000Z', sessionId: COLLIDING, prompts: 1 }),
    ])!;
    expect(await appendMonthlyLog(dir, a)).not.toBeNull();
    expect(await appendMonthlyLog(dir, b)).not.toBeNull(); // not dropped as a dup
    const content = fs.readFileSync(path.join(dir, '2026-03.md'), 'utf-8');
    expect(content.match(/<!-- teamai:session /g)!.length).toBe(2);
  });

  it('prunes months older than the retention window but keeps recent ones', async () => {
    fs.writeFileSync(path.join(dir, '2025-01.md'), '# old\n');
    fs.writeFileSync(path.join(dir, '2026-03.md'), '# recent\n');
    fs.writeFileSync(path.join(dir, 'not-a-log.txt'), 'ignore me\n');
    const removed = await pruneMonthlyLogs(dir, new Date('2026-03-20T00:00:00.000Z'), 90);
    expect(removed).toEqual(['2025-01.md']);
    expect(fs.existsSync(path.join(dir, '2026-03.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'not-a-log.txt'))).toBe(true);
  });

  it('monthKey derives YYYY-MM from the end timestamp', () => {
    const s = collectSession(SID, sampleEvents())!;
    expect(monthKey(s)).toBe('2026-03');
  });
});
