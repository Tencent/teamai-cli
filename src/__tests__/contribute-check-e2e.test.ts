import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── E2E tests for `teamai contribute-check --stdin --tool claude` ──
//
// These tests invoke the real CLI binary as a subprocess, with $HOME
// pointing to a temp directory. This exercises the full pipeline:
//
//   STDIN (hook JSON) → contributeCheck() → readState → readEvents
//   → computeSmartScore → STDOUT (hint JSON) / silence
//

const CLI_PATH = path.resolve(__dirname, '../../dist/index.js');
const SESSION_ID = 'e2e-test-session-001';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-e2e-'));
}

/** Build a hook STDIN JSON payload with a session_id. */
function makeStdinPayload(sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'Stop',
    cwd: '/tmp/fake-project',
  });
}

/** Write events.jsonl with the given events. */
function writeEventsFile(homeDir: string, events: Record<string, unknown>[]): void {
  const eventsDir = path.join(homeDir, '.teamai', 'dashboard');
  fs.mkdirSync(eventsDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(eventsDir, 'events.jsonl'), lines, 'utf-8');
}

/** Write a session state file. */
function writeSessionState(homeDir: string, sessionId: string, state: Record<string, unknown>): void {
  const sessionsDir = path.join(homeDir, '.teamai', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(state), 'utf-8');
}

/** Read a session state file. */
function readSessionState(homeDir: string, sessionId: string): Record<string, unknown> | null {
  const filePath = path.join(homeDir, '.teamai', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Run `teamai contribute-check --stdin --tool claude` as subprocess. */
function runContributeCheck(
  homeDir: string,
  stdinPayload: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [CLI_PATH, 'contribute-check', '--stdin', '--tool', 'claude'],
      {
        env: { ...process.env, HOME: homeDir, TEAMAI_LOG_LEVEL: 'silent' },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
    // Write STDIN and close
    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}

// ─── Scenario helpers ────────────────────────────────────

/**
 * Build a high-friction session that clears the threshold: substantive tool
 * volume (past the toolCount hard gate) PLUS a Stop event carrying interventions
 * (interrupts + tool errors). Friction — not volume — is what scores.
 */
function buildRichSessionEvents(sessionId: string): Record<string, unknown>[] {
  const now = Date.now();
  const tools = ['Read', 'Edit', 'Bash', 'Skill', 'Write', 'Grep', 'Agent'];
  const events: Record<string, unknown>[] = [];

  // 50 tool_use events, 7 unique tools — clears the toolCount hard gate.
  for (let i = 0; i < 50; i++) {
    const minutesAgo = 40 - (i * 40) / 50;
    events.push({
      type: 'tool_use',
      timestamp: new Date(now - minutesAgo * 60 * 1000).toISOString(),
      sessionId,
      tool: 'claude',
      toolName: tools[i % tools.length],
    });
  }

  // Friction snapshot at Stop: 2 interrupts + 8 tool errors → well past threshold.
  events.push({
    type: 'stop',
    timestamp: new Date(now).toISOString(),
    sessionId,
    tool: 'claude',
    interventions: { interrupt: 2, toolReject: 0, toolError: 8 },
  });

  return events;
}

/** Build a trivial session (frictionless + few calls): stays below threshold. */
function buildTrivialSessionEvents(sessionId: string): Record<string, unknown>[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) => ({
    type: 'tool_use',
    timestamp: new Date(now - i * 1000).toISOString(),
    sessionId,
    tool: 'claude',
    toolName: 'Bash',
  }));
}

// ─── Tests ──────────────────────────────────────────────

describe('contribute-check E2E', () => {
  let tmpHome: string;

  beforeAll(() => {
    execSync('npm run build', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'ignore',
    });
  });

  beforeEach(() => {
    tmpHome = makeTmpHome();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('outputs hint JSON for a rich session that exceeds threshold', async () => {
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));

    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    expect(code).toBe(0);
    expect(stdout).not.toBe('');

    // Stop hook output must use hookSpecificOutput.additionalContext, not
    // stopReason (which only applies to `continue:false` aborts).
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('[teamai]');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('/teamai-share-learnings');
    expect(parsed.stopReason).toBeUndefined();
  });

  it('produces no output for a trivial session below threshold', async () => {
    writeEventsFile(tmpHome, buildTrivialSessionEvents(SESSION_ID));

    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('produces no output when session already contributed', async () => {
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));
    writeSessionState(tmpHome, SESSION_ID, { contributed: true });

    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('persists smartScore to session state after check', async () => {
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));

    await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID));

    const state = readSessionState(tmpHome, SESSION_ID);
    expect(state).not.toBeNull();
    expect(typeof state!.smartScore).toBe('number');
    expect(state!.smartScore as number).toBeGreaterThanOrEqual(35);
    expect(state!.contributed).toBe(false);
  });

  it('does not mix up events from different sessions', async () => {
    const otherSessionId = 'other-session-999';
    // Rich events belong to OTHER session, not ours
    writeEventsFile(tmpHome, buildRichSessionEvents(otherSessionId));

    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    // Our session has no events → score = 0 → no hint
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits gracefully with no output when events.jsonl is missing', async () => {
    // No events file at all
    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
