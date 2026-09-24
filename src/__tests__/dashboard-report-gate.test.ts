import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { dashboardReport } from '../dashboard-collector.js';
import { _setLogFilePath, _resetState } from '../utils/logger.js';

// ─── legacy `dashboard-report` config gate ───
//
// `teamai dashboard-report --stdin` is a legacy subcommand: current installs
// only ever write `teamai hook-dispatch`, whose dashboard-report handler is
// registered with `requiresConfig`. The old command stayed ungated, so a hook
// left behind by an earlier install kept recording dashboard events for every
// directory it fired in — including projects that never set up teamai, whose
// sessions then showed up in whatever scope reported next (#768).
//
// `contribute-check`, the other legacy command older installs still call, was
// gated in #748 with `resolveConfigForDir(cwd)`. These tests pin the same gate
// onto dashboard-report.

let tmpDir: string;
let originalHome: string;
let consoleLog: ReturnType<typeof vi.spyOn>;

/** The machine-wide dashboard event log — one file, not per-scope. */
function eventsPath(): string {
  return path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
}

function readEventLines(): Record<string, unknown>[] {
  if (!fs.existsSync(eventsPath())) return [];
  return fs.readFileSync(eventsPath(), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Run the legacy subcommand the way a hook does, with `payload` on STDIN. */
async function runLegacyCommand(payload: Record<string, unknown>, tool = 'claude'): Promise<void> {
  const fake = Readable.from([Buffer.from(JSON.stringify(payload), 'utf-8')]) as Readable & { isTTY?: boolean };
  fake.isTTY = false;
  const orig = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    await dashboardReport(tool);
  } finally {
    Object.defineProperty(process, 'stdin', orig);
  }
}

/** A minimal SessionStart payload naming `cwd`. */
function sessionStartPayload(cwd: string): Record<string, unknown> {
  return {
    hook_event_name: 'SessionStart',
    session_id: 'sess-legacy-1',
    cwd,
    tool_name: 'ClaudeCode',
  };
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dash-gate-')));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  _setLogFilePath(path.join(tmpDir, '.teamai', 'debug.log'));
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  _resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('legacy dashboard-report config gate', () => {
  it('records nothing for a directory that never set up teamai', async () => {
    // A plain project on the machine: no .teamai, no user config.
    const plainProject = path.join(tmpDir, 'plain-project');
    fs.mkdirSync(plainProject, { recursive: true });

    await runLegacyCommand(sessionStartPayload(plainProject));

    expect(readEventLines()).toEqual([]);
    expect(fs.existsSync(eventsPath())).toBe(false);
  });

  it('still records for a directory teamai is set up in', async () => {
    // The user scope: a config under HOME is enough to resolve a config.
    const userConfigDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(userConfigDir, 'config.yaml'),
      [
        'username: tester',
        'scope: user',
        'repo:',
        '  kind: git',
        `  localPath: ${path.join(tmpDir, '.teamai', 'team-repo')}`,
        '  remote: https://example.test/acme/team.git',
        'additionalRoles: []',
        '',
      ].join('\n'),
    );

    await runLegacyCommand(sessionStartPayload(userConfigDir));

    const events = readEventLines();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
    expect(events[0].sessionId).toBe('sess-legacy-1');
  });

  it('records nothing when no cwd can be resolved from the payload', async () => {
    // A host that sends neither cwd nor workspace_roots: resolveConfigForDir
    // then falls back to the directory the hook process runs in, the same
    // semantics #748 gave contribute-check. From a plain directory there is no
    // team, so nothing is recorded.
    const plainDir = path.join(tmpDir, 'hook-proc-dir');
    fs.mkdirSync(plainDir, { recursive: true });
    const cwd = process.cwd();
    process.chdir(plainDir);
    try {
      await runLegacyCommand({ hook_event_name: 'SessionStart', session_id: 'sess-no-cwd' });
    } finally {
      process.chdir(cwd);
    }

    expect(readEventLines()).toEqual([]);
  });
});
