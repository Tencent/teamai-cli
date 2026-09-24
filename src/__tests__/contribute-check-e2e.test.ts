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
const RAW_GITHUB_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FIRST_TASK = `Fix auth retry for ${RAW_GITHUB_TOKEN}\nthen add regression coverage`;

/** A temp HOME with a user-scope install and recall on: the nudge only runs where `share` is served (#748). */
function makeTmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-e2e-'));
  const teamRepo = path.join(home, '.teamai', 'team-repo');
  fs.mkdirSync(teamRepo, { recursive: true });
  fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\nsharing:\n  recall:\n    enabled: true\n');
  fs.writeFileSync(
    path.join(home, '.teamai', 'config.yaml'),
    `repo:\n  localPath: ${teamRepo}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`,
  );
  return home;
}

/** Build a hook STDIN JSON payload with a session_id. */
function makeStdinPayload(sessionId: string, cwd = '/tmp/fake-project'): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'Stop',
    cwd,
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
  tool = 'claude',
  processCwd = homeDir,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [CLI_PATH, 'contribute-check', '--stdin', '--tool', tool],
      {
        // The directory the hook process starts in, which the gate must not read.
        cwd: processCwd,
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
  const events: Record<string, unknown>[] = [{
    type: 'prompt_submit',
    timestamp: new Date(now - 41 * 60 * 1000).toISOString(),
    sessionId,
    tool: 'claude',
    promptSummary: FIRST_TASK,
  }];

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

  it('stays silent where teamai is not set up (#748)', async () => {
    fs.rmSync(path.join(tmpHome, '.teamai', 'config.yaml'));
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));

    const result = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(readSessionState(tmpHome, SESSION_ID)).toBeNull();
  });

  it('standalone Codex Stop queues the hint without emitting incompatible JSON', async () => {
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));
    const result = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID), 'codex');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const state = readSessionState(tmpHome, SESSION_ID)!;
    expect(state.hinted).toBe(true);
    expect(state.pendingHint).toContain('teamai skill get share');
    const repeated = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID), 'codex');
    expect(repeated.stdout).toBe('');
    expect(readSessionState(tmpHome, SESSION_ID)!.pendingHint).toBe(state.pendingHint);
  });

  it('outputs contextual, sanitized hint JSON for a rich session that exceeds threshold', async () => {
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
    expect(parsed.hookSpecificOutput.additionalContext).toContain('you interrupted the AI twice');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('the AI retried failing tools 8 times');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('you rejected');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'Task: Fix auth retry for <REDACTED:gh_tok> then add regression coverage',
    );
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(RAW_GITHUB_TOKEN);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('50 tool calls');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('7 different tools');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('/teamai share what this session taught me');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('teamai skill get share');
    expect(parsed.stopReason).toBeUndefined();

    // The real CLI persists hinted=true, so a repeated Stop hook is silent.
    const repeated = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID));
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toBe('');
  });

  it('withholds the reminder where `teamai skill get share` refuses: a config that cannot be loaded', async () => {
    // Hooks written before the dispatcher still call this command directly; it
    // must ask the same gate, or it nudges towards a command that says no.
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));
    fs.writeFileSync(path.join(tmpHome, '.teamai', 'config.yaml'), '');

    const result = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID));

    expect(result.stdout).toBe('');
  });

  it('asks the gate about the payload cwd, not the directory the hook process started in', async () => {
    // The process starts in HOME, where the user config (recall on) would allow
    // the nudge; the session ran in a project whose config does not parse, where
    // `teamai skill get share` refuses.
    const project = path.join(tmpHome, 'project');
    fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), 'repo: [unclosed\n');
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));

    const result = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID, project));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('never asks the gate about the launcher directory, even when the payload cwd no longer exists', async () => {
    // The hook process starts in a project whose config does not parse; the
    // session ran in a worktree since deleted, which holds no project config,
    // so the user config (recall on) decides.
    const launcher = path.join(tmpHome, 'launcher');
    fs.mkdirSync(path.join(launcher, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(launcher, '.teamai', 'config.yaml'), 'repo: [unclosed\n');
    writeEventsFile(tmpHome, buildRichSessionEvents(SESSION_ID));

    const result = await runContributeCheck(tmpHome, makeStdinPayload(SESSION_ID, path.join(tmpHome, 'deleted-worktree')), 'claude', launcher);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toBe('');
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
    expect(state!.friction).toEqual({ interrupt: 2, toolReject: 0, correction: 0, toolError: 8 });
    expect(state!.promptSummary).toBe(
      'Fix auth retry for <REDACTED:gh_tok> then add regression coverage',
    );
    expect(state!.promptSummary).not.toContain(RAW_GITHUB_TOKEN);
  });

  it('uses a complete friction cache even when events.jsonl is absent', async () => {
    writeSessionState(tmpHome, SESSION_ID, {
      contributed: false,
      smartScore: 80,
      toolCount: 42,
      lastEvaluated: Date.now(),
      friction: { interrupt: 1, toolReject: 1, correction: 0, toolError: 3 },
      promptSummary: 'Repair cached Stop-hook context',
    });

    const { stdout, code } = await runContributeCheck(
      tmpHome,
      makeStdinPayload(SESSION_ID),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('you interrupted the AI once');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('you rejected 1 tool call');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Task: Repair cached Stop-hook context');
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
