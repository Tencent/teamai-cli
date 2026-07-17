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
  aggregateSessionInterventions,
} from '../dashboard-collector.js';
import { computeInterventionDelta, mergeInterventionStats } from '../team-push.js';
import { summarizeInterventions } from '../digest.js';
import type { UserStats } from '../types.js';

// ─── End-to-end: simulate the real Claude Code hook pipeline ───
//
//  hook STDIN ──dashboardReport()──▶ events.jsonl ──rebuildSessions──▶ session cards
//                                          │
//                                          ▼
//                          aggregate → delta → stats/<user>.yaml → digest
//

let tmpDir: string;
let originalHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-iv-e2e-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Drive the production hook entry point with a JSON payload over a fake STDIN. */
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

function writeTranscript(): string {
  const p = path.join(tmpDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'build the feature' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }),
    // user pressed ESC mid-turn
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    // user denied a tool call
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          is_error: true,
          tool_use_id: 'toolu_x',
          content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit).",
        }],
      },
    }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('Human Intervention metric — end to end', () => {
  it('captures interrupt + tool_reject + correction through the full pipeline', async () => {
    const sessionId = 'e2e-sess-1';
    const cwd = '/home/jeff/project';
    const transcriptPath = writeTranscript();

    // 1. A realistic hook sequence for one session.
    await runHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd });
    await runHook({ hook_event_name: 'PostToolUse', session_id: sessionId, cwd, tool_name: 'Edit' });
    await runHook({ hook_event_name: 'Stop', session_id: sessionId, cwd, transcript_path: transcriptPath });
    // user re-prompts to course-correct right after the stop (within the window)
    await runHook({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt: '不对，重做一下' });

    // 2. Events were persisted to the real JSONL log.
    const events = await readEvents();
    expect(events.length).toBe(4);
    const stopEvent = events.find((e) => e.type === 'stop');
    expect(stopEvent!.interventions).toEqual({ interrupt: 1, toolReject: 1, toolError: 0 });

    // 3. Dashboard rebuild surfaces the per-session intervention badge data.
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.interventions).toEqual({ interrupt: 1, toolReject: 1, correction: 1 });
    expect(s.interventionCount).toBe(3);
    // Re-prompt after stop returns the session to running.
    expect(s.status).toBe('running');

    // 4. Team reporting: compute delta, fold into a stats record, then digest it.
    const current = aggregateSessionInterventions(events);
    const { delta } = computeInterventionDelta(current, {});
    expect(delta).toEqual({ sessions: 1, interrupt: 1, toolReject: 1, correction: 1 });

    const userStats: UserStats = {
      username: 'jeff',
      updatedAt: new Date().toISOString(),
      skills: {},
      interventions: mergeInterventionStats(undefined, delta),
    };
    const summary = summarizeInterventions([userStats])!;
    expect(summary.totalSessions).toBe(1);
    expect(summary.totalInterventions).toBe(3);
    expect(summary.avgPerSession).toBeCloseTo(3);
    expect(summary.ranked[0].username).toBe('jeff');
  });

  it('re-running the report on the same events yields no new delta (idempotent)', async () => {
    const sessionId = 'e2e-sess-2';
    const transcriptPath = writeTranscript();
    await runHook({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: '/p' });
    await runHook({ hook_event_name: 'Stop', session_id: sessionId, cwd: '/p', transcript_path: transcriptPath });

    const events = await readEvents();
    const current = aggregateSessionInterventions(events);
    const first = computeInterventionDelta(current, {});
    expect(first.delta.sessions).toBe(1);

    // Second report uses the snapshot from the first — nothing new.
    const second = computeInterventionDelta(current, first.nextReported);
    expect(second.delta).toEqual({ sessions: 0, interrupt: 0, toolReject: 0, correction: 0 });
  });
});
