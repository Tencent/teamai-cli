import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  aggregateSessionMetrics,
  compactEvents,
  reconcileRequestLog,
  dedupeEvents,
} from '../dashboard-collector.js';
import type { DashboardEvent } from '../types.js';
import * as pidMonitor from '../pid-monitor.js';
import { _resetState as resetLogger, _setLogFilePath } from '../utils/logger.js';

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

/** Simulate Copilot flushing its current shutdown after SessionEnd fires. */
function appendCopilotShutdownLater(transcript: string, entry: object): NodeJS.Timeout {
  return setTimeout(() => {
    fs.appendFileSync(transcript, `\n${JSON.stringify(entry)}\n`);
  }, 50);
}

function writeResumedCopilotLog(transcript: string, oldInputTokens: number): void {
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: 'session.shutdown', id: 'old-shutdown',
      data: { tokenDetails: { input: { tokenCount: oldInputTokens } } },
    }),
    JSON.stringify({
      type: 'session.resume', id: 'current-resume', parentId: 'old-shutdown',
    }),
  ].join('\n') + '\n');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-test-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  _setLogFilePath(path.join(tmpDir, '.teamai', 'debug.log'));
});

afterEach(() => {
  process.env.HOME = originalHome;
  resetLogger();
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

  it('keeps SessionStart when monitor PID resolution fails', async () => {
    const spy = vi.spyOn(pidMonitor, 'resolveMonitorPid').mockImplementation(() => {
      throw new Error('PID lookup failed');
    });
    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'pid-fallback-session',
      }), 'claude');
      expect(event?.monitorPid).toBe(process.ppid);
    } finally {
      spy.mockRestore();
    }
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

  it('normalizes Copilot lowercase skill tool usage', async () => {
    const event = await parseHookEvent(JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'copilot-session',
      tool_name: 'skill',
    }), 'copilot');
    expect(event?.toolName).toBe('Skill');
  });

  it('retains only the correction signal from Copilot prompts', async () => {
    const sensitivePrompt = 'wrong, use token ghp_private_value instead';
    const event = await parseHookEvent(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'copilot-session',
      prompt: sensitivePrompt,
    }), 'copilot');
    expect(event).toEqual(expect.objectContaining({
      type: 'prompt_submit',
      sessionId: 'copilot-session',
      correction: true,
    }));
    expect(event?.promptSummary).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(sensitivePrompt);
    expect(JSON.stringify(event)).not.toContain('ghp_private_value');
  });

  it('reads only final Copilot token totals and redacts transcript content', async () => {
    const sessionId = 'copilot-stable-session';
    const copilotHome = path.join(tmpDir, '.copilot-token-totals');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const secret = 'TOP-SECRET-COPILOT-PROMPT';
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      JSON.stringify({
        type: 'session.usage_checkpoint',
        data: { prompt: secret, inputTokens: 999_999, request: { authorization: secret } },
      }),
      JSON.stringify({ type: 'assistant.message', data: { content: secret } }),
    ].join('\n'));
    const appendTimer = appendCopilotShutdownLater(transcript, {
      type: 'session.shutdown',
      data: {
        tokenDetails: {
          input: { tokenCount: 101 },
          output: { tokenCount: 29 },
          cache_read: { tokenCount: 17 },
          cache_write: { tokenCount: 3 },
        },
        prompt: secret,
      },
    });
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
        transcript_path: path.join(tmpDir, 'ignored-supplied-path.jsonl'),
      }), 'copilot');

      expect(event).toEqual(expect.objectContaining({
        type: 'session_end',
        sessionId,
        tool: 'copilot',
        tokens: { input: 101, output: 29, cacheRead: 17, cacheCreation: 3 },
        tokenScope: 'session',
      }));
      expect(event?.transcriptPath).toBeUndefined();
      expect(event?.stoppedOutput).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(JSON.stringify(event)).not.toContain(transcript);
      expect(JSON.stringify(event)).not.toContain('999999');
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('finds Copilot shutdown usage when the real SessionEnd payload omits transcriptPath', async () => {
    const sessionId = 'copilot-real-lifecycle';
    const copilotHome = path.join(tmpDir, '.copilot');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const appendTimer = appendCopilotShutdownLater(transcript, {
      type: 'session.shutdown',
      data: {
        tokenDetails: {
          input: { tokenCount: 61 },
          output: { tokenCount: 7 },
          cache_read: { tokenCount: 43 },
          cache_write: { tokenCount: 2 },
        },
      },
    });
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
        reason: 'complete',
      }), 'copilot');

      expect(event).toEqual(expect.objectContaining({
        type: 'session_end',
        sessionId,
        tokens: { input: 61, output: 7, cacheRead: 43, cacheCreation: 2 },
        tokenScope: 'session',
      }));
      expect(event?.transcriptPath).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(transcript);
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('keeps token collection for a session started before the collector upgrade', async () => {
    const sessionId = 'copilot-preupgrade-start';
    const copilotHome = path.join(tmpDir, '.copilot-preupgrade');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.COPILOT_HOME = copilotHome;
    await appendEvent({
      type: 'session_start', timestamp: new Date().toISOString(),
      sessionId, tool: 'copilot',
    });
    const appendTimer = appendCopilotShutdownLater(transcript, {
      type: 'session.shutdown', id: 'current-shutdown',
      data: { tokenDetails: { input: { tokenCount: 61 } } },
    });

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(event?.tokens?.input).toBe(61);
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not reuse unchanged shutdown totals for a pre-upgrade start', async () => {
    const sessionId = 'copilot-preupgrade-stale-shutdown';
    const copilotHome = path.join(tmpDir, '.copilot-preupgrade-stale');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.shutdown', id: 'old-shutdown',
      data: { tokenDetails: { input: { tokenCount: 11 } } },
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      await appendEvent({
        type: 'session_start', timestamp: new Date().toISOString(),
        sessionId, tool: 'copilot',
      });
      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(end?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('reads a shutdown after a long private log through the bounded tail', async () => {
    const sessionId = 'copilot-large-legacy-tail';
    const copilotHome = path.join(tmpDir, '.copilot-large-tail');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session.message', data: { content: 'x'.repeat(300 * 1024) } }),
      JSON.stringify({
        type: 'session.shutdown', id: 'old-shutdown',
        data: { tokenDetails: { input: { tokenCount: 11 } } },
      }),
    ].join('\n') + '\n');
    process.env.COPILOT_HOME = copilotHome;
    const appendTimer = appendCopilotShutdownLater(transcript, {
      type: 'session.shutdown', id: 'new-shutdown',
      data: { tokenDetails: { input: { tokenCount: 37 } } },
    });

    try {
      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(end?.tokens?.input).toBe(37);
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('waits for a new Copilot shutdown record when a resumed session has an older one', async () => {
    const sessionId = 'copilot-resumed-session';
    const copilotHome = path.join(tmpDir, '.copilot-resumed');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const appendDelayMs = 50;
    const startAt = Date.now() - 1000;
    const markerAt = Date.now() - 500;
    const previousInputTokens = 11;
    const currentInputTokens = 37;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    writeResumedCopilotLog(transcript, previousInputTokens);
    process.env.COPILOT_HOME = copilotHome;
    const start = await parseHookEvent(JSON.stringify({
      hook_event_name: 'SessionStart', sessionId, timestamp: startAt,
    }), 'copilot');
    expect(start?.copilotRunStartOffset).toBe(fs.statSync(transcript).size);
    await appendEvent(start!);
    fs.appendFileSync(transcript, `${JSON.stringify({
      type: 'session.resume', id: 'new-resume', parentId: 'current-resume',
      timestamp: markerAt,
    })}\n`);
    const appendTimer = setTimeout(() => {
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'current-shutdown', parentId: 'new-resume',
        data: { tokenDetails: { input: { tokenCount: currentInputTokens } } },
      })}\n`);
    }, appendDelayMs);

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId, timestamp: Date.now(),
      }), 'copilot');

      expect(event?.tokens).toEqual({
        input: currentInputTokens,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('accepts Copilot shutdown flushed before SessionEnd reads the log', async () => {
    const sessionId = 'copilot-preflushed-current';
    const copilotHome = path.join(tmpDir, '.copilot-preflushed');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    writeResumedCopilotLog(transcript, 11);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart',
        sessionId,
      }), 'copilot');
      expect(start?.copilotRunMarkerId).toBe('current-resume');
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'current-shutdown', parentId: 'current-resume',
        data: { tokenDetails: { input: { tokenCount: 37 } } },
      })}\n`);

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
      }), 'copilot');
      expect(event?.tokens).toEqual({
        input: 37, output: 0, cacheRead: 0, cacheCreation: 0,
      });
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('uses the missing-token fallback when no new Copilot shutdown arrives', async () => {
    const sessionId = 'copilot-resumed-without-shutdown';
    const copilotHome = path.join(tmpDir, '.copilot-stale');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    writeResumedCopilotLog(transcript, 11);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      expect(start?.copilotRunStartOffset).toBe(fs.statSync(transcript).size);
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.resume', id: 'new-resume', parentId: 'current-resume',
      })}\n`);
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
      }), 'copilot');
      expect(event?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not infer the next run from a late marker without provider time', async () => {
    const sessionId = 'copilot-out-of-order-end';
    const copilotHome = path.join(tmpDir, '.copilot-out-of-order');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    writeResumedCopilotLog(transcript, 11);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const oldEndTime = new Date(Date.now() + 1000).toISOString();
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(start!);
      await appendEvent({
        type: 'session_end', timestamp: oldEndTime, sessionId, tool: 'copilot',
      });
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.resume', id: 'new-resume', parentId: 'current-resume',
      })}\n`);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'current-shutdown', parentId: 'new-resume',
        data: { tokenDetails: { input: { tokenCount: 37 } } },
      })}\n`);

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(event?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('rejects a prior unclaimed marker when its shutdown arrives after resume', async () => {
    const sessionId = 'copilot-unclaimed-prior-marker';
    const copilotHome = path.join(tmpDir, '.copilot-unclaimed-marker');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'old-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      await appendEvent({
        type: 'session_start', timestamp: new Date(Date.now() - 2000).toISOString(),
        sessionId, tool: 'copilot',
      });
      await appendEvent({
        type: 'session_end', timestamp: new Date(Date.now() - 1000).toISOString(),
        sessionId, tool: 'copilot',
      });
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      expect(start?.copilotRunMarkerId).toBeUndefined();
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'old-shutdown', parentId: 'old-start',
        data: { tokenDetails: { input: { tokenCount: 999 } } },
      })}\n`);

      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(end?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('rejects a still-open marker already claimed by the prior run', async () => {
    const sessionId = 'copilot-reused-open-marker';
    const copilotHome = path.join(tmpDir, '.copilot-reused-open-marker');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'old-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      await appendEvent({
        type: 'session_start', timestamp: new Date(Date.now() - 2000).toISOString(),
        sessionId, tool: 'copilot',
        copilotRunMarkerId: 'old-start', copilotRunMarkerOffset: 0,
      });
      await appendEvent({
        type: 'session_end', timestamp: new Date(Date.now() - 1000).toISOString(),
        sessionId, tool: 'copilot',
      });
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      expect(start?.copilotRunMarkerId).toBeUndefined();
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'old-shutdown', parentId: 'old-start',
        data: { tokenDetails: { input: { tokenCount: 999 } } },
      })}\n`);

      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(end?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('ignores an old shutdown line completed after SessionStart', async () => {
    const sessionId = 'copilot-partial-old-shutdown';
    const copilotHome = path.join(tmpDir, '.copilot-partial-old');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const line = JSON.stringify({
      type: 'session.shutdown',
      data: { tokenDetails: { input: { tokenCount: 11 } } },
    });
    const split = Math.floor(line.length / 2);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, line.slice(0, split));
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      expect(start?.copilotRunMarkerId).toBeUndefined();
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${line.slice(split)}\n`);

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(event?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not attribute a delayed prior-run shutdown to a resumed run', async () => {
    const sessionId = 'copilot-delayed-prior-shutdown';
    const copilotHome = path.join(tmpDir, '.copilot-delayed-prior');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'session.shutdown', id: 'old-shutdown',
        data: { tokenDetails: { input: { tokenCount: 11 } } } }),
      JSON.stringify({ type: 'session.resume', id: 'current-resume', parentId: 'old-shutdown' }),
    ].join('\n') + '\n');
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(start!);
      fs.appendFileSync(transcript, `${JSON.stringify({
        type: 'session.shutdown', id: 'old-delayed', parentId: 'old-checkpoint',
        data: { tokenDetails: { input: { tokenCount: 999 } } },
      })}\n`);

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(event?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not assign a later resumed run to an older detached SessionEnd', async () => {
    const sessionId = 'copilot-new-run-after-old-end';
    const copilotHome = path.join(tmpDir, '.copilot-new-run');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'old-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const oldStartAt = new Date(Date.now() - 3000).toISOString();
      const oldEndAt = new Date(Date.now() - 2000).toISOString();
      const newStartAt = new Date().toISOString();
      const oldStart = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: oldStartAt,
      }), 'copilot');
      await appendEvent(oldStart!);
      const newMarkerOffset = fs.statSync(transcript).size;
      fs.appendFileSync(transcript, [
        JSON.stringify({ type: 'session.resume', id: 'new-resume', parentId: 'old-start' }),
        JSON.stringify({
          type: 'session.shutdown', id: 'new-shutdown', parentId: 'new-resume',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');
      await appendEvent({
        type: 'session_start', timestamp: newStartAt, sessionId, tool: 'copilot',
        copilotRunMarkerId: 'new-resume', copilotRunMarkerOffset: newMarkerOffset,
      });

      const oldEnd = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: oldEndAt,
      }), 'copilot');
      expect(oldEnd?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('drops ambiguous Copilot totals when a delayed End has no provider timestamp', async () => {
    const sessionId = 'copilot-delayed-end-no-timestamp';
    const copilotHome = path.join(tmpDir, '.copilot-delayed-end-no-timestamp');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'old-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const oldStart = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(oldStart!);
      fs.appendFileSync(transcript, [
        JSON.stringify({ type: 'session.resume', id: 'new-resume', parentId: 'old-start' }),
        JSON.stringify({
          type: 'session.shutdown', id: 'new-shutdown', parentId: 'new-resume',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');
      const newStart = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(newStart!);

      const delayedOldEnd = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(delayedOldEnd?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not claim a later run before its Start handler is recorded', async () => {
    const sessionId = 'copilot-next-run-not-yet-started';
    const copilotHome = path.join(tmpDir, '.copilot-next-run');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.COPILOT_HOME = copilotHome;

    try {
      const oldStart = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(oldStart!);
      fs.appendFileSync(transcript, [
        JSON.stringify({ type: 'session.resume', id: 'next-resume', parentId: null }),
        JSON.stringify({
          type: 'session.shutdown', id: 'next-shutdown', parentId: 'next-resume',
          data: { tokenDetails: { input: { tokenCount: 999 } } },
        }),
      ].join('\n') + '\n');

      const delayedOldEnd = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(delayedOldEnd?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('retains Copilot totals when the current run exceeds the short tail window', async () => {
    const sessionId = 'copilot-long-resumed-run';
    const copilotHome = path.join(tmpDir, '.copilot-long-run');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const startAt = Date.now() - 1000;
    const markerAt = Date.now() - 500;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: startAt,
      }), 'copilot');
      await appendEvent(start!);
      fs.appendFileSync(transcript, [
        JSON.stringify({ type: 'session.start', id: 'current-start', parentId: null,
          timestamp: markerAt }),
        JSON.stringify({ type: 'session.message', id: 'large-output',
          parentId: 'current-start', data: { content: 'x'.repeat(300 * 1024) } }),
        JSON.stringify({ type: 'session.shutdown', id: 'current-shutdown',
          parentId: 'large-output',
          data: { tokenDetails: { input: { tokenCount: 37 } } } }),
      ].join('\n') + '\n');

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: Date.now(),
      }), 'copilot');
      expect(event?.tokens?.input).toBe(37);
      expect(JSON.stringify(event)).not.toContain('x'.repeat(100));
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('recovers a Copilot marker whose JSONL line was in flight at SessionStart', async () => {
    const sessionId = 'copilot-partial-current-marker';
    const copilotHome = path.join(tmpDir, '.copilot-partial-marker');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const startAt = Date.now() - 1000;
    const markerAt = Date.now() - 500;
    const marker = JSON.stringify({
      type: 'session.start', id: 'current-start', parentId: null,
      timestamp: markerAt,
    });
    const split = Math.floor(marker.length / 2);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, marker.slice(0, split));
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: startAt,
      }), 'copilot');
      expect(start?.copilotRunStartOffset).toBe(0);
      await appendEvent(start!);
      fs.appendFileSync(transcript, [
        marker.slice(split),
        JSON.stringify({
          type: 'session.shutdown', id: 'current-shutdown', parentId: 'current-start',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');

      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: Date.now(),
      }), 'copilot');
      expect(end?.tokens?.input).toBe(37);
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it.each(['removed', 'truncated'])('omits tokens when the Copilot log is %s after Start', async (change) => {
    const sessionId = `copilot-log-${change}`;
    const copilotHome = path.join(tmpDir, `.copilot-log-${change}`);
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'current-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: Date.now() - 1000,
      }), 'copilot');
      await appendEvent(start!);
      if (change === 'removed') fs.unlinkSync(transcript);
      else fs.writeFileSync(transcript, '');
      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: Date.now(),
      }), 'copilot');
      expect(end?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('skips a malformed Copilot line and keeps the linked shutdown', async () => {
    const sessionId = 'copilot-malformed-middle-line';
    const copilotHome = path.join(tmpDir, '.copilot-malformed-line');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'session.start', id: 'current-start', parentId: null,
    })}\n`);
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId,
      }), 'copilot');
      await appendEvent(start!);
      fs.appendFileSync(transcript, [
        '{malformed-json',
        JSON.stringify({
          type: 'session.shutdown', id: 'current-shutdown', parentId: 'current-start',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');
      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId,
      }), 'copilot');
      expect(end?.tokens?.input).toBe(37);
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('recovers a current marker with a numeric provider timestamp', async () => {
    const sessionId = 'copilot-numeric-marker-time';
    const copilotHome = path.join(tmpDir, '.copilot-numeric-marker-time');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const startAt = Date.now() - 1000;
    const markerAt = Date.now() - 500;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: startAt,
      }), 'copilot');
      await appendEvent(start!);
      fs.appendFileSync(transcript, [
        JSON.stringify({
          type: 'session.start', id: 'current-start', parentId: null,
          timestamp: markerAt,
        }),
        JSON.stringify({
          type: 'session.shutdown', id: 'current-shutdown', parentId: 'current-start',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');

      const end = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: Date.now(),
      }), 'copilot');
      expect(end?.tokens?.input).toBe(37);
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('recovers the current marker when SessionStart ran before the log write', async () => {
    const sessionId = 'copilot-marker-after-hook';
    const copilotHome = path.join(tmpDir, '.copilot-marker-after-hook');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    const startAt = new Date(Date.now() - 1000).toISOString();
    const markerAt = new Date(Date.now() - 500).toISOString();
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.COPILOT_HOME = copilotHome;

    try {
      const start = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart', sessionId, timestamp: startAt,
      }), 'copilot');
      expect(start?.copilotRunMarkerId).toBeUndefined();
      await appendEvent(start!);
      fs.appendFileSync(transcript, [
        JSON.stringify({
          type: 'session.start', id: 'current-start', parentId: null, timestamp: markerAt,
        }),
        JSON.stringify({
          type: 'session.shutdown', id: 'current-shutdown', parentId: 'current-start',
          data: { tokenDetails: { input: { tokenCount: 37 } } },
        }),
      ].join('\n') + '\n');

      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd', sessionId, timestamp: new Date().toISOString(),
      }), 'copilot');
      expect(event?.tokens?.input).toBe(37);
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not persist a path in Copilot cwd or its fallback session ID', async () => {
    const sensitiveCwd = path.join(tmpDir, 'private-customer-project');
    const originalClaudeSessionId = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: sensitiveCwd,
      }), 'copilot');

      expect(event?.cwd).toBeUndefined();
      expect(event?.sessionId).toMatch(/^pid-\d+$/);
      expect(JSON.stringify(event)).not.toContain(sensitiveCwd);

      const pathIdEvent = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionStart',
        sessionId: sensitiveCwd,
        cwd: sensitiveCwd,
      }), 'copilot');
      expect(pathIdEvent?.sessionId).toMatch(/^pid-\d+$/);
      expect(JSON.stringify(pathIdEvent)).not.toContain(sensitiveCwd);
    } finally {
      if (originalClaudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = originalClaudeSessionId;
    }
  });

  it('ignores a supplied Copilot transcript outside the validated session-state path', async () => {
    const sessionId = 'copilot-contained-session';
    const copilotHome = path.join(tmpDir, '.copilot-contained');
    const safeTranscript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const outsiderTranscript = path.join(tmpDir, 'unrelated-sensitive.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(safeTranscript), { recursive: true });
    fs.writeFileSync(safeTranscript, JSON.stringify({
      type: 'session.shutdown',
      data: { reason: 'complete' },
    }));
    fs.writeFileSync(outsiderTranscript, JSON.stringify({
      type: 'session.shutdown',
      data: { tokenDetails: { input: { tokenCount: 999_999 } } },
    }));
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
        transcript_path: outsiderTranscript,
      }), 'copilot');

      expect(event?.tokens).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(outsiderTranscript);
      expect(JSON.stringify(event)).not.toContain('999999');
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not resolve Copilot usage for a traversal session ID', async () => {
    const outsiderTranscript = path.join(tmpDir, 'traversal-sensitive.jsonl');
    fs.writeFileSync(outsiderTranscript, JSON.stringify({
      type: 'session.shutdown',
      data: { tokenDetails: { input: { tokenCount: 999_999 } } },
    }));

    const event = await parseHookEvent(JSON.stringify({
      hook_event_name: 'SessionEnd',
      sessionId: '../escape',
      transcript_path: outsiderTranscript,
    }), 'copilot');

    expect(event?.tokens).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(outsiderTranscript);
    expect(JSON.stringify(event)).not.toContain('999999');
  });

  it('skips an incomplete Copilot shutdown record and uses the valid final record', async () => {
    const sessionId = 'copilot-in-flight';
    const copilotHome = path.join(tmpDir, '.copilot-in-flight');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"session.shutdown",');
    const appendTimer = appendCopilotShutdownLater(transcript, {
      type: 'session.shutdown',
      data: { tokenDetails: { input: { tokenCount: 7 }, output: { tokenCount: 2 } } },
    });
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
      }), 'copilot');

      expect(event?.tokens).toEqual({ input: 7, output: 2, cacheRead: 0, cacheCreation: 0 });
    } finally {
      clearTimeout(appendTimer);
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('keeps Copilot SessionEnd when final token details are unavailable', async () => {
    const sessionId = 'copilot-camel-session';
    const copilotHome = path.join(tmpDir, '.copilot-no-tokens');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'session.shutdown',
      data: { reason: 'complete' },
    }));
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
      }), 'copilot');
      expect(event).toEqual(expect.objectContaining({
        type: 'session_end',
        sessionId,
      }));
      expect(event?.tokens).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('does not store an all-zero snapshot for empty Copilot token details', async () => {
    const sessionId = 'copilot-empty-token-details';
    const copilotHome = path.join(tmpDir, '.copilot-empty-token-details');
    const transcript = path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
    const originalCopilotHome = process.env.COPILOT_HOME;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'session.shutdown',
      data: { tokenDetails: {} },
    }));
    process.env.COPILOT_HOME = copilotHome;

    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        sessionId,
      }), 'copilot');

      expect(event?.tokens).toBeUndefined();
      expect(event?.tokenScope).toBeUndefined();
    } finally {
      if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = originalCopilotHome;
    }
  });

  it('keeps a missing Copilot transcript path out of events and debug logs', async () => {
    const sensitivePath = path.join(tmpDir, 'private-customer-name.jsonl');
    const debugLog = path.join(tmpDir, 'debug.log');
    _setLogFilePath(debugLog);
    try {
      const event = await parseHookEvent(JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'copilot-missing-transcript',
        transcript_path: sensitivePath,
      }), 'copilot');

      expect(event).toEqual(expect.objectContaining({
        type: 'session_end',
        sessionId: 'copilot-missing-transcript',
      }));
      expect(event?.tokens).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(sensitivePath);
      expect(fs.readFileSync(debugLog, 'utf-8')).not.toContain(sensitivePath);
    } finally {
      resetLogger();
    }
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

  it('flags a correction prompt on UserPromptSubmit', async () => {
    const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'wrong, redo it' });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.correction).toBe(true);
  });

  it('does not flag a Latin keyword inside a longer word (issue #564)', async () => {
    // "undo" / "redo" are common Spanish and Portuguese word endings.
    for (const word of ['segundo', 'mundo', 'profundo', 'rotundo', 'redondo', 'enredo', 'oriundo']) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: `dame el ${word} fichero` });
      const event = await parseHookEvent(raw, 'claude');
      expect(event!.correction, word).toBe(false);
    }
  });

  it('drops a UserPromptSubmit that is purely injected content (no human turn)', async () => {
    // Background-task completions and system reminders fire this hook too, but are
    // not human prompts — they must not become events (else they inflate the count
    // and appear as session prompts).
    for (const injected of [
      '<task-notification>\n<task-id>abc123</task-id>\n<output-file>/tmp/x</output-file>\n</task-notification>',
      '<system-reminder>The user changed X</system-reminder>',
      '[Request interrupted by user for tool use]',
    ]) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: injected });
      expect(await parseHookEvent(raw, 'claude')).toBeNull();
    }
  });

  it('keeps the human text when a real prompt has an injection appended (mid-turn send)', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit', session_id: 's',
      prompt: 'fix the trend panel\n\n<task-notification>\n<task-id>xyz</task-id>\n</task-notification>',
    });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.type).toBe('prompt_submit');
    expect(event!.promptSummary).toBe('fix the trend panel');
  });

  it('matches Latin keywords as whole words, including multi-word ones', async () => {
    for (const prompt of ['undo that', 'Undo.', "that's not it", "don't do that", 'wrong!']) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
      const event = await parseHookEvent(raw, 'claude');
      expect(event!.correction, prompt).toBe(true);
    }
  });

  it('treats underscore as part of a word, so identifiers do not match', async () => {
    const cases: Array<[string, boolean]> = [['run test_undo again', false], ['undo_it', false], ['undo it', true]];
    for (const [prompt, expected] of cases) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
      const event = await parseHookEvent(raw, 'claude');
      expect(event!.correction, prompt).toBe(expected);
    }
  });

  it('keeps substring matching for Chinese and Japanese keywords', async () => {
    for (const prompt of ['这不对', '違うよ']) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
      const event = await parseHookEvent(raw, 'claude');
      expect(event!.correction, prompt).toBe(true);
    }
  });

  it('merges team correctionKeywords with the built-in list', async () => {
    const options = { correctionKeywords: ['rehazlo', 'no era eso', 'mal', '重做'] };
    const cases: Array<[string, boolean]> = [
      ['esto está mal, rehazlo', true],
      ['No era eso', true],
      ['请重做一遍', true],
      // Team Latin keywords also need a whole word: accented letters count as letters.
      ['no está malísimo', false],
      ['continúa con el siguiente paso', false],
    ];
    for (const [prompt, expected] of cases) {
      const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
      const event = await parseHookEvent(raw, 'claude', options);
      expect(event!.correction, prompt).toBe(expected);
    }
  });

  it.each([
    ['NFC keyword and NFD prompt', 'r\u00e9essaye', 're\u0301essaye'],
    ['NFD keyword and NFC prompt', 're\u0301essaye', 'r\u00e9essaye'],
    ['NFD keyword and uppercase prompt', 're\u0301essaye', 'R\u00c9ESSAYE!'],
    ['NFD prompt past the summary limit', 'r\u00e9essaye', `${'x '.repeat(150)}re\u0301essaye`],
  ])('matches canonically equivalent text: %s', async (_label, keyword, prompt) => {
    const event = await parseHookEvent(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }),
      'claude',
      { correctionKeywords: [keyword] },
    );
    expect(event?.correction).toBe(true);
    expect(event?.promptSummary).toBe(prompt.slice(0, 200));
  });

  it.each([
    ['missing accent', 'reessaye'],
    ['different accent', 're\u0300essaye'],
    ['letter prefix', 'pre\u0301essaye'],
    ['letter suffix', 're\u0301essayez'],
    ['underscore prefix', 'test_re\u0301essaye'],
    ['underscore suffix', 're\u0301essaye_it'],
  ])('does not match a team keyword with a %s', async (_label, prompt) => {
    const event = await parseHookEvent(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }),
      'claude',
      { correctionKeywords: ['r\u00e9essaye'] },
    );
    expect(event?.correction).toBe(false);
  });

  it('checks the full prompt, not only the 200-char summary', async () => {
    const prompt = `${'x '.repeat(150)}wrong`;
    const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
    const event = await parseHookEvent(raw, 'claude');
    expect(event!.promptSummary!.length).toBe(200);
    expect(event!.correction).toBe(true);
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

  it('redacts prompt secrets before truncating the summary', async () => {
    const rawToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const prompt = `${'x'.repeat(180)} ${rawToken} wrong`;
    const event = await parseHookEvent(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }),
      'claude',
    );

    expect(event!.correction).toBe(true);
    expect(event!.promptSummary).toContain('<REDACTED:gh_tok>');
    expect(event!.promptSummary).not.toContain('ghp_');
    expect(event!.promptSummary).not.toContain('wrong');
    expect(event!.promptSummary!.length).toBeLessThanOrEqual(200);
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

  it('parses Cursor sessionStart workspace_roots as cwd', async () => {
    const raw = JSON.stringify({
      hook_event_name: 'sessionStart',
      session_id: 'sess-cursor-roots',
      workspace_roots: ['/Users/jeffxu/Project/teamai-cli'],
    });
    const event = await parseHookEvent(raw, 'cursor');
    expect(event).not.toBeNull();
    expect(event!.cwd).toBe('/Users/jeffxu/Project/teamai-cli');
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

  it('captures aggregate tokens and request cost metrics from a Claude Stop transcript', async () => {
    const transcriptPath = path.join(tmpDir, 'usage-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-19T12:00:00Z',
      message: {
        id: 'usage-message',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 3,
        },
        content: [{ type: 'text', text: 'done' }],
      },
    }) + '\n');

    const event = await parseHookEvent(JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess-usage',
      transcript_path: transcriptPath,
    }), 'claude');

    expect(event?.tokens).toEqual({ input: 13, output: 5, cacheRead: 8, cacheCreation: 3 });
    expect(event?.requestMetrics).toMatchObject({
      pricedRequests: 1,
      cacheReadTokens: 8,
      cacheEligibleInputTokens: 24,
    });
  });
});

describe('local request log', () => {
  it('deduplicates requests and prunes details older than 90 days', async () => {
    const old = { id: 'old', timestamp: '2026-05-01T00:00:00Z', model: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 1, priceVersion: 'v1' };
    const current = { ...old, id: 'current', timestamp: '2026-09-01T00:00:00Z' };
    await reconcileRequestLog([old, current], new Date('2026-09-09T00:00:00Z'));
    await reconcileRequestLog([current], new Date('2026-09-09T00:00:00Z'));

    const lines = fs.readFileSync(path.join(tmpDir, '.teamai', 'dashboard', 'requests.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'current', timestamp: current.timestamp });
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

  it('persists the same redacted prompt summary to events and debug log', async () => {
    const rawToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const prompt = `Review login flow with token ${rawToken} and keep this extra context for the dashboard`;
    const event = await parseHookEvent(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-secret', prompt }),
      'claude',
    );
    await appendEvent(event!);

    const summary = 'Review login flow with token <REDACTED:gh_tok> and keep this extra context for the dashboard';
    const eventsPath = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
    const debugPath = path.join(tmpDir, '.teamai', 'debug.log');
    const persisted = JSON.parse(fs.readFileSync(eventsPath, 'utf-8')) as DashboardEvent;
    const debugLog = fs.readFileSync(debugPath, 'utf-8');

    expect(persisted.promptSummary).toBe(summary);
    expect(debugLog).toContain(`[prompt=${summary}]`);
    expect(fs.readFileSync(eventsPath, 'utf-8')).not.toContain(rawToken);
    expect(debugLog).not.toContain(rawToken);
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

  it('rebuilds a privacy-safe Copilot lifecycle with final token totals', () => {
    const events: DashboardEvent[] = [
      { type: 'session_start', timestamp: now, sessionId: 'copilot-1', tool: 'copilot', cwd: '/proj' },
      { type: 'prompt_submit', timestamp: now, sessionId: 'copilot-1', tool: 'copilot', correction: false },
      { type: 'tool_use', timestamp: now, sessionId: 'copilot-1', tool: 'copilot', toolName: 'Skill' },
      {
        type: 'session_end', timestamp: now, sessionId: 'copilot-1', tool: 'copilot',
        tokens: { input: 10, output: 4, cacheRead: 2, cacheCreation: 1 }, tokenScope: 'session',
      },
    ];
    const sessions = rebuildSessions(events);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      status: 'stopped',
      promptCount: 1,
      lastTool: 'Skill',
      tokens: { input: 10, output: 4, cacheRead: 2, cacheCreation: 1 },
    }));
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

  it.each([
    ['NFC keyword and NFD prompt', 'r\u00e9essaye', 're\u0301essaye'],
    ['NFD keyword and NFC prompt', 're\u0301essaye', 'r\u00e9essaye'],
  ])('counts a Unicode correction within the time window: %s', async (_label, keyword, prompt) => {
    const event = await parseHookEvent(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }),
      'claude',
      { correctionKeywords: [keyword] },
    );
    if (!event) throw new Error('Expected a prompt-submit event');

    for (const [gap, expected] of [[0, 1], [60_000, 1], [60_001, 0]]) {
      const sessions = rebuildSessions([
        { type: 'stop', timestamp: now, sessionId: 's', tool: 'claude' },
        { ...event, timestamp: new Date(new Date(now).getTime() + gap).toISOString() },
      ]);
      expect(sessions[0]?.interventions.correction, `gap ${gap}`).toBe(expected);
    }
  });

  it('defaults to zero interventions', () => {
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: now, sessionId: 's1', tool: 'claude', cwd: '/p' },
    ]);
    expect(sessions[0].interventions).toEqual({ interrupt: 0, toolReject: 0, correction: 0 });
    expect(sessions[0].interventionCount).toBe(0);
  });

  it('normalizes built-in keywords when a legacy event has no correction flag', () => {
    const sessions = rebuildSessions([
      { type: 'stop', timestamp: now, sessionId: 's', tool: 'claude' },
      { type: 'prompt_submit', timestamp: now, sessionId: 's', tool: 'claude', promptSummary: '\u3061\u304b\u3099\u3046' },
    ]);
    expect(sessions[0]?.interventions.correction).toBe(1);
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

  it('counts a Japanese correction prompt within the window', () => {
    const t0 = new Date();
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 10_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '違う、そうじゃない。やり直して' },
    ]);
    expect(sessions[0].interventions.correction).toBe(1);
  });

  it('does not count a Japanese follow-up task as correction', () => {
    const t0 = new Date();
    const sessions = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: new Date(t0.getTime() + 5_000).toISOString(), sessionId: 's1', tool: 'claude', promptSummary: '次はテスト環境へデプロイして' },
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

  it('honors the correction flag written by the hook over the summary text', () => {
    const t0 = new Date();
    const later = new Date(t0.getTime() + 5_000).toISOString();
    const flagged = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      // Team keyword matched at capture time; the summary alone would not match.
      { type: 'prompt_submit', timestamp: later, sessionId: 's1', tool: 'claude', promptSummary: 'esto está mal, rehazlo', correction: true },
    ]);
    expect(flagged[0].interventions.correction).toBe(1);

    const unflagged = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: later, sessionId: 's1', tool: 'claude', promptSummary: 'wrong, redo it', correction: false },
    ]);
    expect(unflagged[0].interventions.correction).toBe(0);
  });

  it('falls back to whole-word matching on legacy events without the flag (issue #564)', () => {
    const t0 = new Date();
    const later = new Date(t0.getTime() + 5_000).toISOString();
    const spanish = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: later, sessionId: 's1', tool: 'claude', promptSummary: 'dame el segundo fichero' },
    ]);
    expect(spanish[0].interventions.correction).toBe(0);

    const english = rebuildSessions([
      { type: 'session_start', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: t0.toISOString(), sessionId: 's1', tool: 'claude' },
      { type: 'prompt_submit', timestamp: later, sessionId: 's1', tool: 'claude', promptSummary: 'undo that' },
    ]);
    expect(english[0].interventions.correction).toBe(1);
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

// ─── countInterventions (CodeBuddy index.json) ─────────

describe('countInterventions (CodeBuddy index.json)', () => {
  // index.json with non-zero usage so scanCodebuddyIndex returns on first read
  // (no ~1.75s retry loop). messages[].role==='user' feeds prompts, not tested here.
  const INDEX_WITH_USAGE = {
    messages: [{ id: 'm1', role: 'user', type: 'text', isComplete: true }],
    requests: [{ id: 'r1', usage: { inputTokens: 100, outputTokens: 50 } }],
  };

  // assistant blob whose `extra` is a JSON string with a cancelled+marker entry.
  function rejectedAssistantBlob(callId: string): unknown {
    return {
      role: 'assistant',
      id: 'a1',
      message: 'whatever',
      extra: JSON.stringify({
        requestId: 'r1',
        toolStatus: {
          [callId]: {
            ready: true,
            status: 'cancelled',
            result: {
              status: 'cancelled',
              success: false,
              errorMessage: 'User rejected this command. Do not attempt to achieve the same goal through alternative methods or workarounds.',
            },
            pendingConfirmation: false,
            safetyConfirmMessage: 'security.dangerousCommand (command=rm)',
          },
        },
      }),
    };
  }

  // assistant blob whose tool ran normally (status 'executed') — counts as nothing.
  function executedAssistantBlob(callId: string): unknown {
    return {
      role: 'assistant',
      id: 'a2',
      extra: JSON.stringify({
        toolStatus: {
          [callId]: { ready: true, status: 'executed', result: { status: 'success', success: true } },
        },
      }),
    };
  }

  // tool blob reporting a genuine execution error (isError=true).
  function errorToolBlob(callId: string): unknown {
    return {
      role: 'tool',
      id: 't1',
      message: JSON.stringify({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          toolName: 'execute_command',
          result: { status: 'error', success: false, errorMessage: 'Error: command failed' },
          isError: true,
        }],
      }),
    };
  }

  // tool blob for a rejected tool (isError=false) — must not count as toolError.
  function rejectedToolBlob(callId: string): unknown {
    return {
      role: 'tool',
      id: 't2',
      message: JSON.stringify({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          result: { status: 'cancelled', success: false, errorMessage: 'User rejected this command...' },
          isError: false,
        }],
      }),
    };
  }

  function writeCodebuddySession(dirName: string, indexData: unknown, blobs: unknown[]): string {
    const sessionDir = path.join(tmpDir, dirName);
    const messagesDir = path.join(sessionDir, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const indexPath = path.join(sessionDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData));
    blobs.forEach((b, i) => fs.writeFileSync(path.join(messagesDir, `blob-${i}.json`), JSON.stringify(b)));
    return indexPath;
  }

  it('counts a user-rejected tool as toolReject', async () => {
    const p = writeCodebuddySession('reject', INDEX_WITH_USAGE, [rejectedAssistantBlob('call_reject_1')]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(1);
    expect(iv.toolError).toBe(0);
    expect(iv.interrupt).toBe(0);
  });

  it('counts a genuine tool error as toolError', async () => {
    const p = writeCodebuddySession('error', INDEX_WITH_USAGE, [errorToolBlob('call_err_1')]);
    const iv = await countInterventions(p);
    expect(iv.toolError).toBe(1);
    expect(iv.toolReject).toBe(0);
  });

  it('does not count executed tools or rejected tools as toolError', async () => {
    const p = writeCodebuddySession('exec-ok', INDEX_WITH_USAGE, [
      executedAssistantBlob('call_ok_1'),
      rejectedToolBlob('call_reject_1'),
    ]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(0);
    expect(iv.toolError).toBe(0);
  });

  it('de-duplicates the same callId across multiple blobs', async () => {
    // Same rejected callId in two assistant blobs → one reject, not two.
    // Same errored callId in two tool blobs → one error, not two.
    const p = writeCodebuddySession('dedup', INDEX_WITH_USAGE, [
      rejectedAssistantBlob('call_reject_1'),
      rejectedAssistantBlob('call_reject_1'),
      errorToolBlob('call_err_1'),
      errorToolBlob('call_err_1'),
    ]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(1);
    expect(iv.toolError).toBe(1);
  });

  it('counts reject and error together in a mixed session', async () => {
    const p = writeCodebuddySession('mixed', INDEX_WITH_USAGE, [
      rejectedAssistantBlob('call_reject_1'),
      errorToolBlob('call_err_1'),
      executedAssistantBlob('call_ok_1'),
    ]);
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(1);
    expect(iv.toolError).toBe(1);
  });

  it('returns zeros when messages directory is absent', async () => {
    const sessionDir = path.join(tmpDir, 'no-msg');
    fs.mkdirSync(sessionDir);
    const p = path.join(sessionDir, 'index.json');
    fs.writeFileSync(p, JSON.stringify(INDEX_WITH_USAGE));
    const iv = await countInterventions(p);
    expect(iv).toEqual({ interrupt: 0, toolReject: 0, toolError: 0 });
  });

  it('skips malformed blobs gracefully', async () => {
    const p = writeCodebuddySession('malformed', INDEX_WITH_USAGE, [
      rejectedAssistantBlob('call_reject_1'),
      { role: 'assistant', extra: { toolStatus: {} } }, // extra is an object, not a string
    ]);
    // A non-JSON .json file: writeCodebuddySession stringifies valid JSON, so write this raw.
    fs.writeFileSync(path.join(tmpDir, 'malformed', 'messages', 'bad.json'), 'NOT JSON');
    const iv = await countInterventions(p);
    expect(iv.toolReject).toBe(1);
  });
});

// ─── dedupeEvents (cross-tool double-fire, e.g. Cursor reusing claude hooks) ──
describe('dedupeEvents', () => {
  const ev = (over: Partial<DashboardEvent> & Pick<DashboardEvent, 'type' | 'tool' | 'timestamp'>): DashboardEvent =>
    ({ sessionId: 's1', ...over } as DashboardEvent);

  it('leaves a single-tool session untouched (only sorts by time)', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'session_start', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z' }),
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: '2026-09-18T00:00:01.000Z', promptSummary: 'first' }),
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: '2026-09-18T00:00:02.000Z', promptSummary: 'second' }),
      ev({ type: 'tool_use', tool: 'claude', timestamp: '2026-09-18T00:00:03.000Z', toolName: 'Bash' }),
      ev({ type: 'stop', tool: 'claude', timestamp: '2026-09-18T00:00:04.000Z' }),
    ];
    expect(dedupeEvents(events)).toHaveLength(5);
  });

  it('keeps genuine same-tool repeats in the same second', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'tool_use', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z', toolName: 'Bash' }),
      ev({ type: 'tool_use', tool: 'claude', timestamp: '2026-09-18T00:00:00.100Z', toolName: 'Bash' }),
    ];
    expect(dedupeEvents(events)).toHaveLength(2); // same tool → not a cross-tool dupe
  });

  it('collapses a cross-tool prompt_submit pair and keeps the specific host tool', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z', promptSummary: 'review PR' }),
      ev({ type: 'prompt_submit', tool: 'cursor', timestamp: '2026-09-18T00:00:00.050Z', promptSummary: 'review PR' }),
    ];
    const out = dedupeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('cursor');
  });

  it('picks the specific host even when claude was appended first', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'session_start', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z', monitorPid: 50529 }),
      ev({ type: 'session_start', tool: 'cursor', timestamp: '2026-09-18T00:00:00.008Z', monitorPid: 50529 }),
    ];
    const out = dedupeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('cursor');
  });

  it('does not double-count turns for a doubled cross-tool session', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'session_start', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z' }),
      ev({ type: 'session_start', tool: 'cursor', timestamp: '2026-09-18T00:00:00.010Z' }),
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: '2026-09-18T00:00:01.000Z', promptSummary: 'one' }),
      ev({ type: 'prompt_submit', tool: 'cursor', timestamp: '2026-09-18T00:00:01.007Z', promptSummary: 'one' }),
    ];
    const metrics = aggregateSessionMetrics(dedupeEvents(events));
    expect(metrics.get('s1')!.prompts).toBe(1); // one genuine turn, not two
  });

  it('keeps the richest payload on a collapsed stop, but adopts the host tool', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'stop', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z',
        prompts: 1, stoppedOutput: 'done', tokens: { input: 100, output: 20, cacheRead: 30, cacheCreation: 0 } }),
      ev({ type: 'stop', tool: 'cursor', timestamp: '2026-09-18T00:00:00.050Z' }),
    ];
    const out = dedupeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('cursor');
    expect(out[0].stoppedOutput).toBe('done');
    expect(out[0].tokens?.input).toBe(100);
  });

  it('does not merge a cross-tool pair beyond the dedup window', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z', promptSummary: 'x' }),
      ev({ type: 'prompt_submit', tool: 'cursor', timestamp: '2026-09-18T00:00:03.000Z', promptSummary: 'x' }),
    ];
    expect(dedupeEvents(events)).toHaveLength(2); // 3s apart → two distinct
  });

  it('resolves the session tool to the host end-to-end via rebuildSessions', () => {
    // Recent timestamps so rebuildSessions' idle/stale timeouts keep the session.
    const t0 = Date.now();
    const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
    const events: DashboardEvent[] = [
      ev({ type: 'session_start', tool: 'claude', timestamp: iso(0) }),
      ev({ type: 'session_start', tool: 'cursor', timestamp: iso(10) }),
      ev({ type: 'prompt_submit', tool: 'claude', timestamp: iso(1000), promptSummary: 'q' }),
      ev({ type: 'prompt_submit', tool: 'cursor', timestamp: iso(1006), promptSummary: 'q' }),
    ];
    const sessions = rebuildSessions(dedupeEvents(events));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tool).toBe('cursor');
    expect(sessions[0].promptCount).toBe(1); // turn not doubled
  });

  it('returns events sorted by timestamp', () => {
    const events: DashboardEvent[] = [
      ev({ type: 'tool_use', tool: 'claude', timestamp: '2026-09-18T00:00:02.000Z', toolName: 'Read' }),
      ev({ type: 'session_start', tool: 'claude', timestamp: '2026-09-18T00:00:00.000Z' }),
      ev({ type: 'tool_use', tool: 'claude', timestamp: '2026-09-18T00:00:01.000Z', toolName: 'Bash' }),
    ];
    const out = dedupeEvents(events).map(e => e.timestamp);
    expect(out).toEqual([...out].sort());
  });
});
