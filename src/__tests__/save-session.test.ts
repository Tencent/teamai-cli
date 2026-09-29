import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

const { saveSession } = await import('../save-session.js');
const { log } = await import('../utils/logger.js');

let home: string;

function writeEvents(events: { sessionId: string; timestamp: string }[]): void {
  const dir = path.join(home, '.teamai', 'dashboard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify({ type: 'prompt_submit', tool: 'test', cwd: home, ...e })).join('\n') + '\n',
  );
}

/** The session `session save --dry-run` reports it would record. */
function recordedSession(): string | undefined {
  const line = vi.mocked(log.info).mock.calls.map(([msg]) => String(msg)).find((msg) => msg.startsWith('[dry-run]'));
  return /Would record session (\S+)/.exec(line ?? '')?.[1];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-save-session-'));
  vi.stubEnv('HOME', home);
  vi.mocked(log.info).mockClear();
  writeEvents([
    { sessionId: 'claudeid-session', timestamp: '2026-09-28T10:00:00.000Z' },
    { sessionId: 'pid-4242-/tmp', timestamp: '2026-09-28T10:04:00.000Z' },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('session save default session', () => {
  it('records the agent session named by its variable', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'claudeid-session');
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('claudeid');
  });

  it('records the most recent session when no agent variable is set', async () => {
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('pid-4242');
  });

  it('records the most recent session from a Pi shell started by Claude Code', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'claudeid-session');
    vi.stubEnv('PI_SESSION_ID', 'pi-session');
    await saveSession({ dryRun: true });
    expect(recordedSession()).toBe('pid-4242');
  });
});
