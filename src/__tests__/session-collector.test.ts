import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
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
    vi.restoreAllMocks();
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

  it('keeps both sessions when one writer pauses after reading the monthly log', async () => {
    const file = path.join(dir, '2026-03.md');
    fs.writeFileSync(file, '# Session log — 2026-03\n\n');
    const readFile = fs.promises.readFile;
    let release!: () => void;
    let readStarted!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    let first = true;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      const content = await readFile(...args);
      if (args[0] === file && first) {
        first = false;
        readStarted();
        await paused;
      }
      return content;
    });
    const a = collectSession(SID, sampleEvents())!;
    const b = { ...a, sessionId: 'other-session' };
    const firstWrite = appendMonthlyLog(dir, a);
    await started;
    const secondWrite = appendMonthlyLog(dir, b);
    // Without serialization, the second writer commits while the first still
    // holds its stale snapshot. With serialization, it waits for the first.
    await Promise.race([secondWrite, new Promise((resolve) => setTimeout(resolve, 100))]);
    release();
    await Promise.all([firstWrite, secondWrite]);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain(`<!-- teamai:session ${SID} -->`);
    expect(content).toContain('<!-- teamai:session other-session -->');
    expect(content.match(/# Session log/g)).toHaveLength(1);
  });

  it('deduplicates concurrent saves of the same session', async () => {
    const s = collectSession(SID, sampleEvents())!;
    const written = await Promise.all(Array.from({ length: 6 }, () => appendMonthlyLog(dir, s)));
    expect(written.filter((file) => file !== null)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, '2026-03.md'), 'utf8').match(/<!-- teamai:session /g)).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(['2026-03.md']);
  });

  it('preserves an existing log when reading it fails and allows a retry', async () => {
    const file = path.join(dir, '2026-03.md');
    const original = '# Session log — 2026-03\n\nexisting session\n';
    fs.writeFileSync(file, original);
    const failure = Object.assign(new Error('read failed'), { code: 'EIO' });
    const read = vi.spyOn(fs.promises, 'readFile').mockRejectedValue(failure);
    const s = collectSession(SID, sampleEvents())!;
    await expect(appendMonthlyLog(dir, s)).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['2026-03.md']);
    read.mockRestore();
    expect(await appendMonthlyLog(dir, s)).toBe(file);
  });

  it('preserves the original log and releases the lock when replacement fails', async () => {
    const file = path.join(dir, '2026-03.md');
    const original = '# existing session\n';
    fs.writeFileSync(file, original);
    const rename = vi.spyOn(fse, 'rename').mockRejectedValue(Object.assign(new Error('rename failed'), { code: 'EIO' }));
    const s = collectSession(SID, sampleEvents())!;
    await expect(appendMonthlyLog(dir, s)).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['2026-03.md']);
    rename.mockRestore();
    expect(await appendMonthlyLog(dir, s)).toBe(file);
  });

  it('reports lock contention without changing another holder or the log', async () => {
    const file = path.join(dir, '2026-03.md');
    const lock = `${file}.lock`;
    const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'other-holder' });
    fs.writeFileSync(file, '# existing session\n');
    fs.writeFileSync(lock, owner);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5_000);
    await expect(appendMonthlyLog(dir, collectSession(SID, sampleEvents())!)).rejects.toThrow('Retry teamai session save later');
    expect(fs.readFileSync(file, 'utf8')).toBe('# existing session\n');
    expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
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
