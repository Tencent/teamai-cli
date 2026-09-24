import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { showStats } from '../stats.js';
import { _setLogFilePath, _resetState } from '../utils/logger.js';
import { resolveAnchors } from '../utils/git.js';
import { resolvePartitionDir } from '../utils/partition.js';
import { writeFile, ensureDir } from '../utils/fs.js';
import type { DashboardEvent } from '../types.js';

// ─── showStats scope + double-count regression tests ───
//
// `teamai stats` merged the WHOLE machine's local dashboard metrics into the
// scope's reported totals: reported sessions stay in events.jsonl until
// compaction, so every one was counted twice, and sessions belonging to other
// projects were added to this scope's totals.
//
// `teamai pull` reports the opposite way — filterEventsByScope plus a per-session
// reported snapshot — so the displayed total could never agree with the team's.
// These tests pin the display side to the same rules the report side uses.

let tmpDir: string;
let originalHome: string;
let consoleLog: ReturnType<typeof vi.spyOn>;
let workspace: string;

/**
 * Resolve the event `cwd` values. `config.projectRoot` is the realpath'd
 * workspace, so events must carry real absolute paths under it — a POSIX-style
 * relative cwd would never match the Windows root and would be filtered out.
 */
function projectDirs(): { projectRoot: string; project: string; other: string } {
  const projectRoot = workspace;
  return {
    projectRoot,
    project: path.join(projectRoot, 'proj-a'),
    // Outside the project root: a project scope keeps only the sessions under
    // its own root, so this one belongs to a different scope entirely.
    other: path.join(tmpDir, 'elsewhere', 'proj-b'),
  };
}

let DIRS: { projectRoot: string; project: string; other: string };

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const SESSION_TOKENS = { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 };

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A real git workspace, so config detection resolves a project scope. */
function initWorkspace(): void {
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'tester@example.test']);
  git(workspace, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-qm', 'seed']);
}

/** Write the project-scope config into this workspace's partition. */
async function seedProjectConfig(): Promise<void> {
  const anchors = await resolveAnchors(workspace);
  if (!anchors) throw new Error('expected the seeded workspace to have git anchors');
  const partitionDir = await resolvePartitionDir(anchors.projectAnchor);
  await ensureDir(partitionDir);
  await writeFile(
    path.join(partitionDir, 'config.yaml'),
    [
      'username: tester',
      'scope: project',
      'repo:',
      '  kind: http',
      `  localPath: ${path.join(tmpDir, '.teamai', 'team-repo')}`,
      '  remote: https://example.test/acme/team.git',
      'additionalRoles: []',
      '',
    ].join('\n'),
  );
}

/** Append raw dashboard events to the machine-wide events.jsonl. */
async function appendEvents(events: DashboardEvent[]): Promise<void> {
  const eventsPath = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
  await ensureDir(path.dirname(eventsPath));
  await fs.promises.appendFile(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** One full session: start, one prompt, end. */
function session(sessionId: string, cwd: string): DashboardEvent[] {
  const at = (h: number, m: number) => `2026-09-20T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  return [
    { type: 'session_start', sessionId, cwd, tool: 'claude', timestamp: at(10, 0) },
    { type: 'prompt_submit', sessionId, cwd, tool: 'claude', timestamp: at(10, 1) },
    { type: 'session_end', sessionId, cwd, tool: 'claude', timestamp: at(10, 5), tokens: SESSION_TOKENS },
  ] as unknown as DashboardEvent[];
}

/** The team's copy of this member's reported totals. */
async function writeReportedStats(stats: Record<string, unknown>): Promise<void> {
  const statsDir = path.join(tmpDir, '.teamai', 'team-repo', 'stats');
  await ensureDir(statsDir);
  await writeFile(path.join(statsDir, 'tester.yaml'), YAML.stringify(stats));
}

/** The local snapshot of what this machine already reported (idempotency basis). */
async function writeReportedSnapshots(
  interventions: Record<string, { interrupt: number; toolReject: number; correction: number }>,
  promptTokens: Record<string, { prompts: number; tokens: typeof ZERO_TOKENS }>,
): Promise<void> {
  const dir = path.join(tmpDir, '.teamai', 'dashboard');
  await ensureDir(dir);
  await writeFile(path.join(dir, 'reported-interventions.json'), JSON.stringify(interventions));
  await writeFile(path.join(dir, 'reported-prompt-tokens.json'), JSON.stringify(promptTokens));
}

function statsOutput(): string[] {
  return consoleLog.mock.calls.map((c) => String(c[0]));
}

/**
 * A user-scope config at `~/.teamai/config.yaml`, plus a project scope in
 * `workspace`'s partition. `loadLocalConfig` never attaches `projectRoot`, so a
 * user-scope run only sees the project's sessions if showStats resolves the
 * project config separately.
 */
async function seedUserScopeWithProject(): Promise<void> {
  const userConfigDir = path.join(tmpDir, '.teamai');
  await ensureDir(userConfigDir);
  await writeFile(
    path.join(userConfigDir, 'config.yaml'),
    [
      'username: tester',
      'scope: user',
      'repo:',
      '  kind: http',
      `  localPath: ${path.join(tmpDir, '.teamai', 'team-repo')}`,
      '  remote: https://example.test/acme/team.git',
      'additionalRoles: []',
      '',
    ].join('\n'),
  );
  await seedProjectConfig();
}

/** Extract the trailing number of the `Sessions:` / `Conversation turns:` line. */
function outputNumber(lines: string[], label: string): number {
  const line = lines.find((l) => l.includes(label));
  if (!line) return Number.NaN;
  const match = line.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : Number.NaN;
}

/** Extract the session count from the `By Repo:` lines (e.g. `  <path>  2 sess, ...`). */
function byRepoSessions(lines: string[]): number {
  const line = lines.find((l) => /\d+\s+sess,\s*\d+\s+turns/.test(l));
  if (!line) return Number.NaN;
  const match = line.match(/(\d+)\s+sess/);
  return match ? Number(match[1]) : Number.NaN;
}

/** Run showStats from inside the project workspace. */
async function showStatsFromProject(options: { byRepo?: boolean } = {}): Promise<string[]> {
  const cwd = process.cwd();
  process.chdir(workspace);
  try {
    await showStats(options);
  } finally {
    process.chdir(cwd);
  }
  return statsOutput();
}

/** Run showStats from a directory with no project config of its own. */
async function showStatsFromPlainDir(dir: string): Promise<string[]> {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await showStats();
  } finally {
    process.chdir(cwd);
  }
  return statsOutput();
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stats-scope-')));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  _setLogFilePath(path.join(tmpDir, '.teamai', 'debug.log'));
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  initWorkspace();
  DIRS = projectDirs();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  _resetState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('showStats scope and idempotency', () => {
  it('counts a reported session once, not twice', async () => {
    await seedProjectConfig();
    await appendEvents(session('sess-1', DIRS.project));

    // Already reported: the team yaml holds it, and the local snapshot says so.
    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 1,
      tokens: SESSION_TOKENS,
      interventions: { sessions: 1, interrupt: 0, toolReject: 0, correction: 0 },
    });
    await writeReportedSnapshots(
      { 'sess-1': { interrupt: 0, toolReject: 0, correction: 0 } },
      { 'sess-1': { prompts: 1, tokens: SESSION_TOKENS } },
    );

    const out = await showStatsFromProject();

    // Reported once in the team totals; nothing new locally to add.
    expect(outputNumber(out, 'Sessions:')).toBe(1);
    expect(outputNumber(out, 'Conversation turns:')).toBe(1);
  });

  it('adds only the sessions this scope has not reported yet', async () => {
    await seedProjectConfig();
    await appendEvents([
      // Reported in an earlier pull.
      ...session('sess-1', DIRS.project),
      // New since that pull.
      ...session('sess-2', DIRS.project),
    ]);

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 1,
      tokens: SESSION_TOKENS,
      interventions: { sessions: 1, interrupt: 0, toolReject: 0, correction: 0 },
    });
    await writeReportedSnapshots(
      { 'sess-1': { interrupt: 0, toolReject: 0, correction: 0 } },
      { 'sess-1': { prompts: 1, tokens: SESSION_TOKENS } },
    );

    const out = await showStatsFromProject();

    // 1 already reported + 1 new = 2, not 3 (sess-1 must not be counted twice).
    expect(outputNumber(out, 'Sessions:')).toBe(2);
    expect(outputNumber(out, 'Conversation turns:')).toBe(2);
  });

  it('excludes sessions belonging to another project', async () => {
    await seedProjectConfig();
    await appendEvents([
      ...session('sess-1', DIRS.project),
      // A different project on the same machine.
      ...session('sess-2', DIRS.other),
    ]);

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 0,
      tokens: ZERO_TOKENS,
      interventions: { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 },
    });

    const out = await showStatsFromProject();

    // Only proj-a's session counts for proj-a.
    expect(outputNumber(out, 'Sessions:')).toBe(1);
    expect(outputNumber(out, 'Conversation turns:')).toBe(1);
  });

  it('applies no project exclusion in the user scope when no project resolves', async () => {
    // A user-scope run from a plain directory: detectProjectConfig() finds no
    // project here, exactly as `pull` sees it from the same directory, so the
    // report path passes no exclusion list either. The display side matches.
    await seedUserScopeWithProject();
    await appendEvents([
      ...session('sess-1', DIRS.project),
      ...session('sess-2', DIRS.other),
    ]);

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 0,
      tokens: ZERO_TOKENS,
      interventions: { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 },
    });

    // Run from a plain directory, so no project config resolves for the cwd.
    const plainDir = path.join(tmpDir, 'plain');
    fs.mkdirSync(plainDir, { recursive: true });
    const out = await showStatsFromPlainDir(plainDir);

    expect(outputNumber(out, 'Sessions:')).toBe(2);
    expect(outputNumber(out, 'Conversation turns:')).toBe(2);
  });

  it('keeps only the project sessions once the project config resolves', async () => {
    // The same machine, run from inside the project: detectProjectConfig() now
    // resolves it, so the project scope keeps only its own sessions and the
    // other project's never reach its totals.
    await seedUserScopeWithProject();
    await appendEvents([
      ...session('sess-1', DIRS.project),
      ...session('sess-2', DIRS.other),
    ]);

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 0,
      tokens: ZERO_TOKENS,
      interventions: { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 },
    });

    const out = await showStatsFromProject();

    expect(outputNumber(out, 'Sessions:')).toBe(1);
    expect(outputNumber(out, 'Conversation turns:')).toBe(1);
  });

  it('does not count tokens of a session twice', async () => {
    await seedProjectConfig();
    await appendEvents(session('sess-1', DIRS.project));

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 1,
      tokens: SESSION_TOKENS,
      interventions: { sessions: 1, interrupt: 0, toolReject: 0, correction: 0 },
    });
    await writeReportedSnapshots(
      { 'sess-1': { interrupt: 0, toolReject: 0, correction: 0 } },
      { 'sess-1': { prompts: 1, tokens: SESSION_TOKENS } },
    );

    const out = await showStatsFromProject();

    // 100 input + 50 output, once — not doubled to 200/100.
    expect(outputNumber(out, 'Tokens (total):')).toBe(150);
    expect(outputNumber(out, 'Input:')).toBe(100);
    expect(outputNumber(out, 'Output:')).toBe(50);
  });

  it('reports the same sessions in the headline and the per-repo breakdown', async () => {
    // Two sessions on disk: sess-1 already reported, sess-2 new. The headline
    // counts 1 reported + 1 new = 2, and the breakdown must show the same one
    // unreported session rather than both sessions still in the event log.
    await seedProjectConfig();
    await appendEvents([
      ...session('sess-1', DIRS.project),
      ...session('sess-2', DIRS.project),
    ]);

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 1,
      tokens: SESSION_TOKENS,
      interventions: { sessions: 1, interrupt: 0, toolReject: 0, correction: 0 },
    });
    await writeReportedSnapshots(
      { 'sess-1': { interrupt: 0, toolReject: 0, correction: 0 } },
      { 'sess-1': { prompts: 1, tokens: SESSION_TOKENS } },
    );

    const out = await showStatsFromProject({ byRepo: true });

    expect(outputNumber(out, 'Sessions:')).toBe(2);
    expect(byRepoSessions(out)).toBe(1);
  });

  it('keeps the breakdown from counting sessions the headline already reported', async () => {
    // The team holds 3 sessions; only 1 is still in the local event log and it
    // has already been reported. The headline must show 3 (reported) + 0 (new),
    // and the breakdown must not present the local log as if it were extra.
    await seedProjectConfig();
    await appendEvents(session('sess-1', DIRS.project));

    await writeReportedStats({
      username: 'tester',
      updatedAt: '2026-09-20T11:00:00.000Z',
      skills: {},
      prompts: 100,
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      interventions: { sessions: 3, interrupt: 0, toolReject: 0, correction: 0 },
    });
    await writeReportedSnapshots(
      { 'sess-1': { interrupt: 0, toolReject: 0, correction: 0 } },
      { 'sess-1': { prompts: 100, tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 } } },
    );

    const out = await showStatsFromProject({ byRepo: true });

    expect(outputNumber(out, 'Sessions:')).toBe(3);
    // Not 1: the only session on disk was already reported, so there is no
    // unreported session for the breakdown to present as extra activity.
    expect(out.some((l) => l.includes('By Repo:'))).toBe(false);
  });
});
