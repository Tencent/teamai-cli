/**
 * Which scope reports a dashboard session (#785): the real dispatcher records
 * the sessions, the real report reads them, observed through the stats file
 * each scope pushes. Only the reports-branch push and the handlers that reach
 * the network or spawn processes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // The detached background pass: run inline instead (bgOnly) so its writes are observable.
  spawn: vi.fn(() => ({ on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) }, unref: vi.fn() })),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined) }));
vi.mock('../update.js', () => ({
  doUpdate: vi.fn(async () => undefined),
  // appendEvent and compactEvents take the events file's lock (#804); the
  // no-op acquisition keeps these tests lock-free, as they were before it.
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
// Each scope's reports branch is a plain directory next to its team repo.
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: vi.fn(async (cfg: LocalConfig, write: (wt: string) => Promise<unknown>) => {
    const dir = path.join(path.dirname(cfg.repo.localPath), 'reports-wt');
    fs.mkdirSync(dir, { recursive: true });
    return (await write(dir)) != null;
  }),
}));

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope, resolveConfigForDir, loadLocalConfig } = await import('../config.js');
const { reportUsageToTeam } = await import('../team-push.js');
const { getDataHome } = await import('../types.js');
const { dataHomeKey } = await import('../dashboard-collector.js');
const dataHomeKeyOf = (config: LocalConfig) => dataHomeKey(getDataHome(config));

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-scope-')));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const teamaiHome = () => path.join(tmp, 'home', '.teamai');

/** Run one hook event the way a host does: foreground pass, then the background pass. */
async function hook(event: string, tool: string, payload: Record<string, unknown>): Promise<void> {
  for (const bgOnly of [false, true]) {
    const stdinFile = path.join(tmp, `stdin-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify(payload));
    await hookDispatchCli(event, tool, '*', { bgOnly, stdinFile });
  }
}

/** One complete session: start, a prompt, stop. */
async function session(tool: string, base: Record<string, unknown>): Promise<void> {
  await hook('session-start', tool, { ...base, hook_event_name: 'SessionStart' });
  await hook('prompt-submit', tool, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  await hook('stop', tool, { ...base, hook_event_name: 'Stop' });
}

async function setup(): Promise<{ root: string; user: LocalConfig; project: LocalConfig }> {
  const userRepo = path.join(teamaiHome(), 'team-repo');
  fs.mkdirSync(userRepo, { recursive: true });
  fs.writeFileSync(path.join(teamaiHome(), 'config.yaml'),
    `repo:\n  localPath: ${userRepo}\n  remote: https://example.test/acme/user-team.git\n  kind: git\nusername: tester\nscope: user\n`);
  const root = path.join(tmp, 'project-p');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataHome = await resolveProjectDataHome(root);
  fs.mkdirSync(path.join(dataHome, 'team-repo'), { recursive: true });
  await saveLocalConfigForScope({
    repo: { localPath: path.join(dataHome, 'team-repo'), remote: 'https://example.test/acme/team-p.git', kind: 'git' },
    username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
  });
  // The configs as pull resolves them.
  const user = await loadLocalConfig();
  const project = await resolveConfigForDir(root);
  if (!user || !project) throw new Error('fixture configs did not resolve');
  return { root, user, project };
}

/** Report the way pull does, and return the stats that scope has pushed so far. */
async function report(config: LocalConfig): Promise<unknown> {
  await reportUsageToTeam(config.repo.localPath, config.username, { skipTruncate: true, selfConfig: config });
  const statsPath = path.join(path.dirname(config.repo.localPath), 'reports-wt', 'stats', `${config.username}.yaml`);
  return fs.existsSync(statsPath) ? YAML.parse(fs.readFileSync(statsPath, 'utf-8')) : null;
}

/** Report the way pull does, and return the sessions that scope's stats now hold. */
async function reportedSessions(config: LocalConfig): Promise<number> {
  const stats = await report(config);
  const daily = stats && typeof stats === 'object' && 'daily' in stats && stats.daily && typeof stats.daily === 'object' ? stats.daily : {};
  return Object.values(daily).reduce((sum: number, day: unknown) =>
    sum + (day && typeof day === 'object' && 'sessionsEnded' in day && typeof day.sessionsEnded === 'number' ? day.sessionsEnded : 0), 0);
}

describe('each scope reports only the dashboard sessions recorded in it (#785)', () => {
  it('a user-scope report leaves out a session recorded in a project, and the project reports it', async () => {
    const { root, user, project } = await setup();
    await session('claude', { session_id: 'sid-p', cwd: root });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('a user-scope session is reported by the user scope only', async () => {
    const { user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await session('claude', { session_id: 'sid-u', cwd: elsewhere });

    expect(await reportedSessions(project)).toBe(0);
    expect(await reportedSessions(user)).toBe(1);
  });

  it.each([
    ['names its cwd', true],
    ['sends no cwd, from a hook running in the project', false],
  ])('a Copilot session, whose events record no cwd, is reported by its project: payload %s', async (_, withCwd) => {
    const { root, user, project } = await setup();
    if (!withCwd) process.chdir(root);
    await session('copilot', withCwd ? { session_id: 'copilot-p', cwd: root } : { session_id: 'copilot-p' });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('a Copilot event records its scope without persisting a path (#666)', async () => {
    const { root, project } = await setup();
    await session('copilot', { session_id: 'copilot-p', cwd: root });

    const log = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8');
    const partition = getDataHome(project);
    expect(log).not.toContain(root);
    expect(log).not.toContain(partition);
    expect(log).not.toContain(path.basename(partition));
  });

  it('records the repo of a session, and still no path for a Copilot one (#809)', async () => {
    const { root } = await setup();
    await session('claude', { session_id: 'sid-a', cwd: root });
    await session('copilot', { session_id: 'copilot-a', cwd: root });

    const events = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const claude = events.filter((e) => e.sessionId === 'sid-a');
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((e) => e.projectAnchor === root)).toBe(true);
    const copilot = events.filter((e) => e.tool === 'copilot');
    expect(copilot.length).toBeGreaterThan(0);
    expect(copilot.filter((e) => 'cwd' in e || 'projectAnchor' in e)).toEqual([]);
  });

  it('a session started under a symlinked path of the project is reported by the project', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
    await session('claude', { session_id: 'sid-link', cwd: link });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('events recorded before sessions carried a data home go to the scope their cwd resolves to now', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    // A nested clone under P resolves to no project, so it is the user scope's, not P's too.
    fs.mkdirSync(path.join(root, 'nested'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'nested') });
    // A sibling whose name only starts with P's.
    fs.mkdirSync(`${root}-ab`);
    const timestamp = new Date().toISOString();
    const old = (sessionId: string, cwd: string | undefined) => [
      { type: 'session_start', timestamp, sessionId, tool: 'claude', cwd },
      { type: 'stop', timestamp, sessionId, tool: 'claude', cwd },
    ];
    const eventsPath = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(eventsPath, [
      ...old('old-in-p', path.join(root, 'src')),
      ...old('old-via-link', link),
      ...old('old-elsewhere', path.join(tmp, 'elsewhere')),
      ...old('old-nested', path.join(root, 'nested')),
      ...old('old-sibling', `${root}-ab`),
      // Nothing can tell whose these were, so no scope reports them.
      ...old('old-gone', path.join(root, 'removed-worktree')),
      ...old('old-no-cwd', undefined),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    expect(await reportedSessions(user)).toBe(3);
    expect(await reportedSessions(project)).toBe(2);
  });
});

describe('each scope keeps its own reported snapshot (#786)', () => {
  /** The prompts a scope's stats hold, 0 before its first push. */
  async function reportedPrompts(config: LocalConfig): Promise<number> {
    const stats = await report(config);
    return stats && typeof stats === 'object' && 'prompts' in stats && typeof stats.prompts === 'number' ? stats.prompts : 0;
  }

  /** The sessions a scope's intervention stats hold, 0 before its first push. */
  async function reportedInterventionSessions(config: LocalConfig): Promise<number> {
    const stats = await report(config);
    const interventions = stats && typeof stats === 'object' && 'interventions' in stats ? stats.interventions : undefined;
    return interventions && typeof interventions === 'object' && 'sessions' in interventions
      && typeof interventions.sessions === 'number' ? interventions.sessions : 0;
  }

  const shared = (name: string) => path.join(teamaiHome(), 'dashboard', `reported-${name}.json`);
  const SNAPSHOTS = ['interventions', 'prompt-tokens', 'daily-sessions'];

  /** The shared snapshots as a release before #786 left them, with `prompts` reported per session. */
  function writeSharedSnapshots(prompts: Record<string, number>, date: string, config?: LocalConfig): void {
    const entries = (value: (n: number) => unknown) =>
      Object.fromEntries(Object.entries(prompts).map(([sid, n]) => [sid, value(n)]));
    const values: Record<string, unknown> = {
      interventions: entries(() => ({ interrupt: 0, toolReject: 0, correction: 0 })),
      'prompt-tokens': entries((n) => ({ prompts: n, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } })),
      // Longer than any fixture session, so no duration is left to report.
      'daily-sessions': entries((n) => ({ date, prompts: n, durationMs: 3_600_000, succeeded: 1, corrected: 0 })),
    };
    const dir = path.join(config ? getDataHome(config) : teamaiHome(), 'dashboard');
    // The user scope's own snapshot sits beside the shared one, prefixed.
    const prefix = config?.scope === 'user' ? 'user-' : '';
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SNAPSHOTS) fs.writeFileSync(path.join(dir, `${prefix}reported-${name}.json`), JSON.stringify(values[name]));
  }

  async function prompts(sessionId: string, cwd: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await hook('prompt-submit', 'claude', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: `p${i}` });
    }
  }

  /**
   * Run `record` as an earlier release would have: before #785 its events carry
   * no data home, and main since #795 wrote the data home path, `dataHome`.
   */
  async function asEarlierRelease(record: () => Promise<void>, dataHome?: string): Promise<void> {
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    await record();
    const added = fs.readFileSync(log, 'utf-8').slice(before.length).split('\n').filter(Boolean).map((line) => {
      const event = Object.fromEntries(Object.entries(JSON.parse(line)).filter(([field]) => field !== 'dataHomeKey'));
      return `${JSON.stringify(dataHome === undefined ? event : { ...event, dataHome })}\n`;
    });
    fs.writeFileSync(log, before + added.join(''));
  }

  // A Stop carries the whole transcript's totals, so a session is reported once,
  // whole, by the scope it started in; split per event, the later scope would
  // count the earlier scope's part again.
  it('a session that moves from the user scope into a project is reported once, by the user scope', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await hook('session-start', 'claude', { session_id: 'moved', cwd: elsewhere, hook_event_name: 'SessionStart' });
    await prompts('moved', elsewhere, 3);
    await prompts('moved', root, 2); // `cd` into the project mid-session
    await hook('stop', 'claude', { session_id: 'moved', cwd: root, hook_event_name: 'Stop' });

    expect(await reportedPrompts(project)).toBe(0);
    expect(await reportedPrompts(user)).toBe(5);
  });

  /** A second git project, Q, with its own team. */
  async function setupQ(): Promise<{ rootQ: string; projectQ: LocalConfig }> {
    const rootQ = path.join(tmp, 'project-q');
    fs.mkdirSync(rootQ);
    execFileSync('git', ['init', '-q'], { cwd: rootQ });
    const dataHomeQ = await resolveProjectDataHome(rootQ);
    fs.mkdirSync(path.join(dataHomeQ, 'team-repo'), { recursive: true });
    await saveLocalConfigForScope({
      repo: { localPath: path.join(dataHomeQ, 'team-repo'), remote: 'https://example.test/acme/team-q.git', kind: 'git' },
      username: 'tester', scope: 'project', projectRoot: rootQ, additionalRoles: [], dataHome: dataHomeQ,
    });
    const projectQ = await resolveConfigForDir(rootQ);
    if (!projectQ) throw new Error('fixture config Q did not resolve');
    return { rootQ, projectQ };
  }

  it('a session that moves from one project into another is reported once, by the first', async () => {
    const { root, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    await hook('session-start', 'claude', { session_id: 'moved', cwd: root, hook_event_name: 'SessionStart' });
    await prompts('moved', root, 3);
    await prompts('moved', rootQ, 2);
    await hook('stop', 'claude', { session_id: 'moved', cwd: rootQ, hook_event_name: 'Stop' });

    expect(await reportedPrompts(projectQ)).toBe(0);
    expect(await reportedPrompts(project)).toBe(5);
  });

  it('a session ID another scope already reported is a new session in this scope (Copilot PID fallback)', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // No session ID: Copilot falls back to `pid-<parent pid>`, reused by the next session.
    await session('copilot', { cwd: elsewhere });
    expect(await reportedSessions(user)).toBe(1);
    // Compaction dropped the ended session; a later one in P gets the same ID.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
  });

  it('a session ID reused after its session ended goes to the scope that reuses it, while the log still holds the ended one', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await session('copilot', { cwd: elsewhere });
    await hook('session-end', 'copilot', { cwd: elsewhere, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(user)).toBe(1);
    // Below the compaction threshold the ended `pid-<parent pid>` session stays; the next one in P reuses its ID.
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedSessions(user)).toBe(1);
  });

  it('two sessions that reuse one session ID in the same scope are two sessions, while the log holds both', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });

    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('a session ID reused in the same scope after compaction dropped the run it reported is a new session', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    // Compaction dropped the ended run before P reported again; the next run in P reuses its ID.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('a session that ends twice, SessionEnd then the dashboard monitor\'s process_exit, is one session', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    // The monitor read the session as still running while SessionEnd was appended.
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    const last = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(log, 'utf-8').trim().split('\n').at(-1) ?? '{}')));
    fs.appendFileSync(log, `${JSON.stringify({ ...last, type: 'process_exit', timestamp: new Date(Date.now() + 1000).toISOString() })}\n`);

    expect(await reportedInterventionSessions(project)).toBe(1);
    expect(await reportedSessions(project)).toBe(1);
  });

  it.each([
    ['after the project first reported', true],
    ['before the project first reported', false],
  ])('a session ID an earlier release reported for the user scope is a new session when this build records it in a project, %s', async (_, reportFirst) => {
    const { root, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const pid = `pid-${process.ppid}`;
    // The ended user-scope run stays in the log, below the compaction threshold.
    await asEarlierRelease(async () => {
      await session('copilot', { cwd: elsewhere });
      await hook('session-end', 'copilot', { cwd: elsewhere, hook_event_name: 'SessionEnd' });
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    if (reportFirst) expect(await report(project)).toBeNull();
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a run in progress across the upgrade is not reported again for what the earlier release reported', async () => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    await asEarlierRelease(async () => {
      await hook('session-start', 'copilot', { cwd: root, hook_event_name: 'SessionStart' });
      await prompts(pid, root, 1);
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    await hook('prompt-submit', 'copilot', { cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'after the upgrade' });
    await hook('stop', 'copilot', { cwd: root, hook_event_name: 'Stop' });

    expect(await reportedPrompts(project)).toBe(1);
    expect(await reportedInterventionSessions(project)).toBe(0);
  });

  it.each([
    ['retained', false, false],
    ['compacted', true, false],
    ['seeded before reuse', false, true],
  ])('a path-keyed project run does not inherit a shared user snapshot (%s)', async (_, compact, seedFirst) => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    await asEarlierRelease(async () => {
      await session('copilot', { cwd: tmp });
      await hook('session-end', 'copilot', { cwd: tmp, hook_event_name: 'SessionEnd' });
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    if (seedFirst) expect(await report(project)).toBeNull();
    if (compact) fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await asEarlierRelease(() => session('copilot', { cwd: root }), getDataHome(project));

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedInterventionSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a delayed monitor exit does not split the next invocation with the same ID', async () => {
    const { root, project } = await setup();
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    await session('copilot', { cwd: root });
    const observed = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1) ?? '{}');
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    await hook('session-start', 'copilot', { cwd: root, hook_event_name: 'SessionStart' });
    fs.appendFileSync(log, JSON.stringify({
      type: 'process_exit', sessionId: observed.sessionId, tool: 'copilot',
      timestamp: new Date().toISOString(), dataHomeKey: observed.dataHomeKey,
      processExitAfter: observed.timestamp,
    }) + '\n');
    await hook('prompt-submit', 'copilot', { cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'second run' });
    await hook('stop', 'copilot', { cwd: root, hook_event_name: 'Stop' });

    expect(await reportedInterventionSessions(project)).toBe(2);
    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it.each([
    ['a shared snapshot, before #785', false],
    ['the scope\'s own snapshot, main since #795', true],
  ])('two runs an earlier release reported under one bare ID are not sent again: %s', async (_, ownSnapshot) => {
    const { root, project } = await setup();
    // No session ID: a fallback ID the second run reuses. That release summed
    // both runs under it; Claude's fallback carries the cwd, Copilot's does not.
    const [tool, payload] = ownSnapshot ? ['copilot', {}] : ['claude', { cwd: root }];
    const run = async () => {
      await session(tool, { ...payload, cwd: root });
      await hook('session-end', tool, { ...payload, cwd: root, hook_event_name: 'SessionEnd' });
    };
    await asEarlierRelease(async () => { await run(); await run(); }, ownSnapshot ? getDataHome(project) : undefined);
    const events = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8');
    const id: string = JSON.parse(events.split('\n')[0]).sessionId;
    writeSharedSnapshots({ [id]: 2 }, new Date().toISOString().slice(0, 10), ownSnapshot ? project : undefined);

    expect(await report(project)).toBeNull();
  });

  it('a session resumed in a project after it ended is still the one the user scope reported', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await session('claude', { session_id: 'resumed', cwd: elsewhere });
    await hook('session-end', 'claude', { session_id: 'resumed', cwd: elsewhere, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(user)).toBe(1);
    // `claude --resume` in P: the same session ID, whose Stop carries the whole transcript.
    await session('claude', { session_id: 'resumed', cwd: root });

    expect(await reportedSessions(project)).toBe(0);
    expect(await reportedSessions(user)).toBe(1);
    expect(await reportedPrompts(user)).toBe(2);
  });

  it('a session resumed in another project after compaction dropped its events stays its first project\'s', async () => {
    const { root, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    await session('claude', { session_id: 'resumed', cwd: root });
    await hook('session-end', 'claude', { session_id: 'resumed', cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    // `claude --resume` in Q: its Stop carries P's transcript, which Q never reported.
    await session('claude', { session_id: 'resumed', cwd: rootQ });

    expect(await report(projectQ)).toBeNull();
    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a session main reported in a project, resumed in another after compaction, stays the first project\'s', async () => {
    const { project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    // Main reported `resumed` in P: only P's own snapshot holds it, and main kept no owners.
    writeSharedSnapshots({ resumed: 1 }, new Date().toISOString().slice(0, 10), project);
    // Compaction dropped its events; `claude --resume` in Q.
    await session('claude', { session_id: 'resumed', cwd: rootQ });

    expect(await report(projectQ)).toBeNull();
    expect(await report(project)).toBeNull();
  });

  /** `claude --resume` of `sessionId` in `cwd`, whose Stop carries the transcript's `prompts`. */
  async function resume(sessionId: string, cwd: string, prompts: number): Promise<void> {
    await session('claude', { session_id: sessionId, cwd });
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.writeFileSync(log, fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      return JSON.stringify(event.sessionId === sessionId && event.type === 'stop' ? { ...event, prompts } : event);
    }).join('\n') + '\n');
  }

  it('main split a session between two projects: the one holding the greater total owns it', async () => {
    const { root, project } = await setup();
    const { projectQ } = await setupQ();
    const today = new Date().toISOString().slice(0, 10);
    // Main reported 3 prompts to P before the session moved, then its cumulative 5 to Q.
    writeSharedSnapshots({ moved: 3 }, today, project);
    writeSharedSnapshots({ moved: 5 }, today, projectQ);
    // Compaction dropped its events; resumed in P, its Stop carries 6.
    await resume('moved', root, 6);

    expect(await report(project)).toBeNull();
    expect(await reportedPrompts(projectQ)).toBe(1);
  });

  it('equal totals copied from the shared snapshot name no owner: the scope it resumes in reports it', async () => {
    const { root, user, project } = await setup();
    const today = new Date().toISOString().slice(0, 10);
    // Main copied the shared entry into both scopes' snapshots: they tie.
    writeSharedSnapshots({ copied: 1 }, today);
    writeSharedSnapshots({ copied: 1 }, today, user);
    writeSharedSnapshots({ copied: 1 }, today, project);
    await resume('copied', root, 2);

    expect(await report(user)).toBeNull();
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a sole copy of a shared entry names no owner: a resume in the scope that reported it counts there', async () => {
    const { user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const today = new Date().toISOString().slice(0, 10);
    // Only P pulled on main, so only P's snapshot holds a copy of the user-scope session.
    writeSharedSnapshots({ 'user-session': 1 }, today);
    writeSharedSnapshots({ 'user-session': 1 }, today, project);
    await resume('user-session', elsewhere, 2);

    expect(await report(project)).toBeNull();
    expect(await reportedPrompts(user)).toBe(1);
  });

  it('a copy the shared intervention snapshot alone holds does not let a report claim it', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const today = new Date().toISOString().slice(0, 10);
    // A session reported with no prompts: only intervention entries, copied into P.
    writeSharedSnapshots({ quiet: 0 }, today);
    writeSharedSnapshots({ quiet: 0 }, today, project);
    for (const dir of [path.join(teamaiHome(), 'dashboard'), path.join(getDataHome(project), 'dashboard')]) {
      for (const name of ['prompt-tokens', 'daily-sessions']) fs.rmSync(path.join(dir, `reported-${name}.json`));
    }
    // P reports another session first, and records owners from its snapshots.
    await session('claude', { session_id: 'p-other', cwd: root });
    const reportedByP = await report(project);
    await resume('quiet', elsewhere, 1);

    expect(await report(project)).toEqual(reportedByP);
    expect(await reportedPrompts(user)).toBe(1);
  });

  it('main split a session before any Stop and compaction dropped it: the owner credits both parts', async () => {
    const { root, project } = await setup();
    const { projectQ } = await setupQ();
    const today = new Date().toISOString().slice(0, 10);
    // 3 prompts reported in P and 2 in Q, as submit counts: no Stop, so no daily entry.
    writeSharedSnapshots({ split: 3 }, today, project);
    writeSharedSnapshots({ split: 2 }, today, projectQ);
    for (const config of [project, projectQ]) fs.rmSync(path.join(getDataHome(config), 'dashboard', 'reported-daily-sessions.json'));
    // Resumed in P; its cumulative Stop carries 6.
    await resume('split', root, 6);

    expect((await reportedPrompts(project)) + (await reportedPrompts(projectQ))).toBe(1);
  });

  it.each([
    // P's 3 prompts came before Q's cumulative Stop of 5, which counts them already.
    ['before', ['p', 'p', 'p', 'q', 'q'], 3, 5, 1],
    // Q's Stop counted 2; P's 3 prompts came after it.
    ['after', ['q', 'q', 'p', 'p', 'p'], 3, 2, 1],
  ])('a compacted split session whose part with no Stop came %s the other part\'s Stop is credited by its transcript',
    async (_, order, loose, stop, expected) => {
      const { root, project } = await setup();
      const { rootQ, projectQ } = await setupQ();
      const today = new Date().toISOString().slice(0, 10);
      writeSharedSnapshots({ split: loose }, today, project);
      fs.rmSync(path.join(getDataHome(project), 'dashboard', 'reported-daily-sessions.json'));
      writeSharedSnapshots({ split: stop }, today, projectQ);
      // The transcript holds every prompt in order, each with the directory it was typed in.
      const transcript = path.join(tmp, 'split.jsonl');
      const cwdOf = (at: string) => (at === 'p' ? root : rootQ);
      fs.writeFileSync(transcript, [...order, 'q'].map((at, i) => JSON.stringify({
        type: 'user', sessionId: 'split', uuid: `u${i}`, cwd: cwdOf(at), message: { role: 'user', content: `turn ${i}` },
      })).join('\n') + '\n');
      // Resumed in Q, one new prompt: the Stop's transcript total is 6.
      await session('claude', { session_id: 'split', cwd: rootQ, transcript_path: transcript });

      expect((await reportedPrompts(project)) + (await reportedPrompts(projectQ))).toBe(expected);
    });

  /** Codex events of one session, as the collector records them, keyed to `config`'s scope. */
  async function codexLog(config: LocalConfig) {
    const key = await dataHomeKeyOf(config);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const base = Date.now() - 3_600_000;
    const event = (rollout: string, type: string, minute: number, extra: Record<string, unknown> = {}) => JSON.stringify({
      type, timestamp: new Date(base + minute * 60_000).toISOString(), sessionId: 'codex-s', tool: 'codex', dataHomeKey: key,
      transcriptPath: path.join(tmp, rollout), ...extra,
    });
    const write = (lines: string[]) => fs.writeFileSync(log, lines.join('\n') + '\n');
    const stats = async () => {
      const reported = await report(config);
      const day = reported && typeof reported === 'object' && 'daily' in reported && reported.daily && typeof reported.daily === 'object'
        ? Object.values(reported.daily)[0] : undefined;
      const interventions = reported && typeof reported === 'object' && 'interventions' in reported ? reported.interventions : undefined;
      const prompts = reported && typeof reported === 'object' && 'prompts' in reported ? reported.prompts : undefined;
      return { day, interventions, prompts };
    };
    return { event, write, stats };
  }

  it('a Codex rollout with no token record is kept per rollout too', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    write([event('rollout-a.jsonl', 'stop', 0, { prompts: 5 })]);
    await stats();
    write([event('rollout-b.jsonl', 'stop', 30, { prompts: 2 })]);

    expect((await stats()).prompts).toBe(7);
  });

  it('a tcodex rollout with no token record is kept per rollout too', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    write([event('rollout-a.jsonl', 'stop', 0, { tool: 'tcodex', prompts: 5 })]);
    await stats();
    write([event('rollout-b.jsonl', 'stop', 30, { tool: 'tcodex', prompts: 2 })]);

    expect((await stats()).prompts).toBe(7);
  });

  it('a Codex rollout whose Stop records its cost as requestMetrics keeps that cost', async () => {
    const { project } = await setup();
    const { event, write } = await codexLog(project);
    // An older Stop: its cost as one request record, on the Stop's day.
    write([event('rollout-a.jsonl', 'stop', 0, {
      prompts: 1, requestMetrics: { pricedRequests: 1, costMicros: 40, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'v1' },
    })]);
    const reported = await report(project);
    const days = reported && typeof reported === 'object' && 'daily' in reported && reported.daily && typeof reported.daily === 'object'
      ? Object.values(reported.daily) : [];

    expect(days.reduce((sum: number, d: unknown) =>
      sum + (d && typeof d === 'object' && 'costMicros' in d && typeof d.costMicros === 'number' ? d.costMicros : 0), 0)).toBe(40);
  });

  it('a dropped Codex rollout keeps its corrections', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const withCorrection = (rollout: string, minute: number) => [
      event(rollout, 'stop', minute, { prompts: 1 }),
      event(rollout, 'prompt_submit', minute + 0.1, { correction: true, promptSummary: 'no, not that' }),
      event(rollout, 'stop', minute + 0.2, { prompts: 2 }),
    ];
    write(withCorrection('rollout-a.jsonl', 0));
    await stats();
    write(withCorrection('rollout-b.jsonl', 30));

    expect((await stats()).interventions).toMatchObject({ correction: 2 });
  });

  it('a dropped Codex rollout keeps its duration and cache tokens', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const tokens = (cacheRead: number) => ({ tokenScope: 'transcript', tokens: { input: 10, output: 1, cacheRead, cacheCreation: 0 } });
    // Rollout A: 8 active minutes and 100 cache-read tokens; B: 1 minute and 20.
    write([event('rollout-a.jsonl', 'prompt_submit', 0), event('rollout-a.jsonl', 'prompt_submit', 4),
      event('rollout-a.jsonl', 'stop', 8, { prompts: 2, ...tokens(100) })]);
    await stats();
    write([event('rollout-b.jsonl', 'prompt_submit', 30), event('rollout-b.jsonl', 'stop', 31, { prompts: 1, ...tokens(20) })]);
    const { day } = await stats();

    expect(day).toMatchObject({ durationMs: 9 * 60_000, cacheReadTokens: 120 });
  });

  it('a Codex session\'s request costs sum its rollouts still in the log', async () => {
    const { project } = await setup();
    const { event, write } = await codexLog(project);
    const day = new Date().toISOString().slice(0, 10);
    const cost = (costMicros: number) => ({
      requestDaily: { [day]: { pricedRequests: 1, costMicros, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'v1' } },
    });
    write([event('rollout-a.jsonl', 'stop', 0, { prompts: 1, ...cost(100) })]);
    await report(project);
    // Rollout A is still in the log when rollout B adds its own cost.
    write([event('rollout-a.jsonl', 'stop', 0, { prompts: 1, ...cost(100) }), event('rollout-b.jsonl', 'stop', 30, { prompts: 1, ...cost(20) })]);
    const reported = await report(project);
    const days = reported && typeof reported === 'object' && 'daily' in reported && reported.daily && typeof reported.daily === 'object'
      ? Object.values(reported.daily) : [];

    expect(days.reduce((sum: number, d: unknown) =>
      sum + (d && typeof d === 'object' && 'costMicros' in d && typeof d.costMicros === 'number' ? d.costMicros : 0), 0)).toBe(120);
  });

  it('a dropped Codex rollout that failed keeps the session failed', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    // Rollout A was interrupted; rollout B, after compaction, finishes cleanly.
    write([event('rollout-a.jsonl', 'stop', 0, { prompts: 1, interventions: { interrupt: 1, toolReject: 0 } })]);
    await stats();
    write([event('rollout-b.jsonl', 'stop', 30, { prompts: 1, interventions: { interrupt: 0, toolReject: 0 } })]);

    expect((await stats()).day).toMatchObject({ sessionsSucceeded: 0 });
  });

  it('a Codex session with a session-scoped token counter still keeps its other metrics per rollout', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const day = new Date().toISOString().slice(0, 10);
    // The thread-level token counter spans rollouts; prompts and costs restart with each.
    const stop = (rollout: string, minute: number, prompts: number, costMicros: number, input: number) => event(rollout, 'stop', minute, {
      prompts, tokenScope: 'session', tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0 },
      requestDaily: { [day]: { pricedRequests: 1, costMicros, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'v1' } },
    });
    write([stop('rollout-a.jsonl', 0, 5, 100, 500)]);
    await stats();
    write([stop('rollout-b.jsonl', 30, 2, 20, 530)]);
    const after = await stats();
    const reported = await report(project);
    const tokens = reported && typeof reported === 'object' && 'tokens' in reported ? reported.tokens : undefined;
    // Costs go to their request's day, which need not be the session's.
    const days = reported && typeof reported === 'object' && 'daily' in reported && reported.daily && typeof reported.daily === 'object'
      ? Object.values(reported.daily) : [];
    const costMicros = days.reduce((sum: number, d: unknown) =>
      sum + (d && typeof d === 'object' && 'costMicros' in d && typeof d.costMicros === 'number' ? d.costMicros : 0), 0);

    expect(after.prompts).toBe(7);
    expect(costMicros).toBe(120);
    expect(tokens).toMatchObject({ input: 530 });
  });

  it('a dropped Codex rollout keeps the prompts its submits counted', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    // Codex Stops carry no prompt count: the submits of each rollout count its prompts.
    write([event('rollout-a.jsonl', 'prompt_submit', 0), event('rollout-a.jsonl', 'prompt_submit', 1),
      event('rollout-a.jsonl', 'prompt_submit', 2), event('rollout-a.jsonl', 'stop', 3)]);
    await stats();
    write([event('rollout-b.jsonl', 'prompt_submit', 30), event('rollout-b.jsonl', 'stop', 31)]);

    expect((await stats()).prompts).toBe(4);
  });

  it('a whole entry an earlier release left adds no tokens to a counter that spans rollouts', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    // That release reported rollout A as one entry: 5 prompts, the counter at 500.
    writeSharedSnapshots({ 'codex-s': 5 }, new Date().toISOString().slice(0, 10), project);
    const file = path.join(getDataHome(project), 'dashboard', 'reported-prompt-tokens.json');
    fs.writeFileSync(file, JSON.stringify({ 'codex-s': { prompts: 5, tokens: { input: 500, output: 0, cacheRead: 0, cacheCreation: 0 } } }));
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const name of SNAPSHOTS) fs.utimesSync(path.join(getDataHome(project), 'dashboard', `reported-${name}.json`), past, past);
    // A was compacted; rollout B, begun later, shows the thread-level counter at 530.
    write([event('rollout-b.jsonl', 'stop', 30, {
      prompts: 2, tokenScope: 'session', tokens: { input: 530, output: 0, cacheRead: 0, cacheCreation: 0 },
    })]);
    await stats();
    const reported = await report(project);
    const tokens = reported && typeof reported === 'object' && 'tokens' in reported ? reported.tokens : undefined;

    expect(tokens).toMatchObject({ input: 30 });
  });

  it('a whole daily entry from before request costs were kept per day keeps its cost for a later rollout', async () => {
    const { project } = await setup();
    const { event, write } = await codexLog(project);
    const today = new Date().toISOString().slice(0, 10);
    // An earlier release reported rollout A: its daily entry holds the cost as session fields.
    writeSharedSnapshots({ 'codex-s': 5 }, today, project);
    const dir = path.join(getDataHome(project), 'dashboard');
    fs.writeFileSync(path.join(dir, 'reported-daily-sessions.json'), JSON.stringify({ 'codex-s': {
      date: today, prompts: 5, durationMs: 0, succeeded: 1, corrected: 0,
      pricedRequests: 1, costMicros: 100, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'v1',
    } }));
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const name of SNAPSHOTS) fs.utimesSync(path.join(dir, `reported-${name}.json`), past, past);
    // A was compacted; rollout B, begun later, costs $20 on the same day.
    write([event('rollout-b.jsonl', 'stop', 30, {
      prompts: 2, requestDaily: { [today]: { pricedRequests: 1, costMicros: 20, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'v1' } },
    })]);
    const reported = await report(project);
    const days = reported && typeof reported === 'object' && 'daily' in reported && reported.daily && typeof reported.daily === 'object'
      ? Object.values(reported.daily) : [];

    expect(days.reduce((sum: number, d: unknown) =>
      sum + (d && typeof d === 'object' && 'costMicros' in d && typeof d.costMicros === 'number' ? d.costMicros : 0), 0)).toBe(20);
  });

  it('a whole entry from before covers a rollout still running only as far as it had got', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const today = new Date().toISOString().slice(0, 10);
    // That release reported 6 prompts: rollout A's 5 and rollout B's first.
    writeSharedSnapshots({ 'codex-s': 6 }, today, project);
    const dir = path.join(getDataHome(project), 'dashboard');
    const writtenAt = new Date(Date.now() - 20 * 60_000);
    for (const name of SNAPSHOTS) fs.utimesSync(path.join(dir, `reported-${name}.json`), writtenAt, writtenAt);
    // A was compacted; B had 1 prompt by then, and has 3 now.
    write([event('rollout-b.jsonl', 'stop', 30, { prompts: 1 }), event('rollout-b.jsonl', 'stop', 50, { prompts: 3 })]);

    expect((await stats()).prompts).toBe(2);
  });

  it('a whole entry from before covers what its report read, not what came in during its push', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const today = new Date().toISOString().slice(0, 10);
    // That release read the log (A 5, B 1), wrote the team stats file, pushed, then its snapshot.
    writeSharedSnapshots({ 'codex-s': 6 }, today, project);
    const dir = path.join(getDataHome(project), 'dashboard');
    const teamStats = path.join(path.dirname(project.repo.localPath), 'reports-wt', 'stats', 'tester.yaml');
    fs.mkdirSync(path.dirname(teamStats), { recursive: true });
    fs.writeFileSync(teamStats, YAML.stringify({ username: 'tester', skills: {} }));
    const read = new Date(Date.now() - 25 * 60_000);
    const pushed = new Date(Date.now() - 15 * 60_000);
    fs.utimesSync(teamStats, read, read);
    for (const name of SNAPSHOTS) fs.utimesSync(path.join(dir, `reported-${name}.json`), pushed, pushed);
    // A was compacted; B reached 2 during that push and has 3 now.
    write([event('rollout-b.jsonl', 'stop', 30, { prompts: 1 }), event('rollout-b.jsonl', 'stop', 40, { prompts: 2 }),
      event('rollout-b.jsonl', 'stop', 55, { prompts: 3 })]);

    expect((await stats()).prompts).toBe(2);
  });

  it('reading the baselines without persisting them, as teamai stats does, does not move the time they cover', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    // An earlier release reported rollout A into the shared snapshot, then compaction dropped it.
    writeSharedSnapshots({ 'codex-s': 5 }, new Date().toISOString().slice(0, 10));
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const name of SNAPSHOTS) fs.utimesSync(shared(name), past, past);
    // Rollout B began after that, and the baselines are read before the next pull.
    write([event('rollout-b.jsonl', 'stop', 30, { prompts: 2 })]);
    const { reportedBaselines } = await import('../team-push.js');
    const { filterEventsByScope } = await import('../dashboard-scope.js');
    const { readEvents, aggregateSessionMetrics } = await import('../dashboard-collector.js');
    const { aggregateDailySessions } = await import('../session-trends.js');
    const events = await filterEventsByScope(await readEvents(), project);
    await reportedBaselines(events, aggregateSessionMetrics(events), aggregateDailySessions(events), project, false);

    expect(fs.existsSync(path.join(getDataHome(project), 'dashboard', 'reported-prompt-tokens.json'))).toBe(false);
    expect((await stats()).prompts).toBe(2);
  });

  it('a rollout\'s intervention change alone still updates its kept totals', async () => {
    const { project } = await setup();
    const { event, write, stats } = await codexLog(project);
    const stop = (rollout: string, minute: number, toolReject: number) =>
      event(rollout, 'stop', minute, { prompts: 1, interventions: { interrupt: 0, toolReject } });
    write([stop('rollout-a.jsonl', 0, 1)]);
    await stats();
    // Only the rejection count moves; prompts and tokens stay the same.
    write([stop('rollout-a.jsonl', 0, 1), stop('rollout-a.jsonl', 1, 2)]);
    await stats();
    write([stop('rollout-b.jsonl', 30, 1)]);

    expect((await stats()).interventions).toMatchObject({ toolReject: 3 });
  });

  it('a Codex rollout resumed after compaction reports its daily prompts and interventions too', async () => {
    const { project } = await setup();
    const key = await dataHomeKeyOf(project);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const stop = (rollout: string, prompts: number, toolReject: number) => JSON.stringify({
      type: 'stop', timestamp: new Date().toISOString(), sessionId: 'codex-s', tool: 'codex', dataHomeKey: key,
      transcriptPath: path.join(tmp, rollout), tokenScope: 'transcript', prompts,
      tokens: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 }, interventions: { interrupt: 0, toolReject },
    });
    fs.writeFileSync(log, stop('rollout-a.jsonl', 5, 1) + '\n');
    await report(project);
    // Compaction dropped rollout A; the resumed rollout B restarts its counters.
    fs.writeFileSync(log, stop('rollout-b.jsonl', 2, 1) + '\n');
    const stats = await report(project);
    const day = stats && typeof stats === 'object' && 'daily' in stats && stats.daily && typeof stats.daily === 'object'
      ? Object.values(stats.daily)[0] : undefined;
    const interventions = stats && typeof stats === 'object' && 'interventions' in stats ? stats.interventions : undefined;

    expect(day).toMatchObject({ promptTurns: 7 });
    expect(interventions).toMatchObject({ toolReject: 2 });
  });

  it('a compacted split session credits the cumulative Stop interventions once', async () => {
    const { user, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    const today = new Date().toISOString().slice(0, 10);
    // P's Stop reported 3 prompts and 1 interruption; Q's later, cumulative Stop
    // 5 prompts and 2; the user scope 1 prompt before any Stop (no daily entry).
    writeSharedSnapshots({ split: 3 }, today, project);
    writeSharedSnapshots({ split: 5 }, today, projectQ);
    writeSharedSnapshots({ split: 1 }, today, user);
    fs.rmSync(path.join(teamaiHome(), 'dashboard', 'user-reported-daily-sessions.json'));
    const interrupts = (config: LocalConfig, file: string, interrupt: number) => fs.writeFileSync(
      path.join(getDataHome(config), 'dashboard', file),
      JSON.stringify({ split: { interrupt, toolReject: 0, correction: 0 } }));
    interrupts(project, 'reported-interventions.json', 1);
    interrupts(projectQ, 'reported-interventions.json', 2);
    // Resumed in Q: its next cumulative Stop carries 7 prompts and 3 interruptions.
    await resume('split', rootQ, 7);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.writeFileSync(log, fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      return JSON.stringify(event.type === 'stop' ? { ...event, interventions: { interrupt: 3, toolReject: 0 } } : event);
    }).join('\n') + '\n');
    const stats = await report(projectQ);
    const interventions = stats && typeof stats === 'object' && 'interventions' in stats ? stats.interventions : undefined;

    expect(interventions).toMatchObject({ interrupt: 1 });
  });

  it('a project that reported a session past the shared snapshot\'s total owns it', async () => {
    const { project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    const today = new Date().toISOString().slice(0, 10);
    // The shared file held 1 prompt; P, seeded from it, then reported through prompt 2.
    writeSharedSnapshots({ resumed: 1 }, today);
    writeSharedSnapshots({ resumed: 2 }, today, project);
    await resume('resumed', rootQ, 3);

    expect(await report(projectQ)).toBeNull();
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a session a project reported with no prompts, only its intervention count, stays that project\'s', async () => {
    const { project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    writeSharedSnapshots({ quiet: 0 }, new Date().toISOString().slice(0, 10), project);
    for (const name of ['prompt-tokens', 'daily-sessions']) {
      fs.rmSync(path.join(getDataHome(project), 'dashboard', `reported-${name}.json`));
    }
    await resume('quiet', rootQ, 0);

    expect(await reportedInterventionSessions(projectQ)).toBe(0);
  });

  it('a session of a project whose data home is in its workspace stays that project\'s', async () => {
    await setup();
    const { rootQ, projectQ } = await setupQ();
    const { rootW, projectW } = await setupWorkspaceProject();
    expect(getDataHome(projectW)).toBe(path.join(rootW, '.teamai'));
    writeSharedSnapshots({ resumed: 1 }, new Date().toISOString().slice(0, 10), projectW);
    // Another of W's sessions is still in the log.
    await session('claude', { session_id: 'other-w', cwd: rootW });
    await resume('resumed', rootQ, 2);

    expect(await report(projectQ)).toBeNull();
  });

  /** A project with no git repo, so its data home is `<root>/.teamai`, under no partition. */
  async function setupWorkspaceProject(): Promise<{ rootW: string; projectW: LocalConfig }> {
    const rootW = path.join(tmp, 'plain-dir');
    fs.mkdirSync(rootW);
    const dataHomeW = await resolveProjectDataHome(rootW);
    fs.mkdirSync(path.join(dataHomeW, 'team-repo'), { recursive: true });
    await saveLocalConfigForScope({
      repo: { localPath: path.join(dataHomeW, 'team-repo'), remote: 'https://example.test/acme/team-w.git', kind: 'git' },
      username: 'tester', scope: 'project', projectRoot: rootW, additionalRoles: [], dataHome: dataHomeW,
    });
    const projectW = await resolveConfigForDir(rootW);
    if (!projectW) throw new Error('fixture config W did not resolve');
    return { rootW, projectW };
  }

  it.each([
    ['claude', (cwd: string) => ({ type: 'user', sessionId: 'resumed', cwd, message: { role: 'user', content: 'start' } })],
    ['codex', (cwd: string) => ({ type: 'session_meta', payload: { id: 'resumed', cwd } })],
  ])('a %s session resumed elsewhere after compaction goes to the project its transcript started in', async (tool, first) => {
    await setup();
    const { rootQ, projectQ } = await setupQ();
    const { rootW, projectW } = await setupWorkspaceProject();
    // An earlier release reported it in W; compaction dropped every W event.
    writeSharedSnapshots({ resumed: 1 }, new Date().toISOString().slice(0, 10), projectW);
    // The resume appends to the transcript the session started, whose first cwd is W.
    const transcript = path.join(tmp, `${tool}-resumed.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify(first(rootW)) + '\n');
    await session(tool, { session_id: 'resumed', cwd: rootQ, transcript_path: transcript });

    expect(await report(projectQ)).toBeNull();
  });

  it('a Copilot session resumed elsewhere after compaction goes to the project its session log started in', async () => {
    await setup();
    const { rootQ, projectQ } = await setupQ();
    const { rootW, projectW } = await setupWorkspaceProject();
    writeSharedSnapshots({ 'copilot-w': 1 }, new Date().toISOString().slice(0, 10), projectW);
    // Copilot's own session log, found by the session ID: TeamAI stores no path of it (#666).
    const log = path.join(tmp, 'home', '.copilot', 'session-state', 'copilot-w', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, JSON.stringify({ type: 'session.start', data: { context: { cwd: rootW } } }) + '\n');
    await session('copilot', { session_id: 'copilot-w', cwd: rootQ });

    expect(await report(projectQ)).toBeNull();
  });

  it('main split a session across projects before any Stop: the owner credits what each already reported', async () => {
    const { root, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    // Main attributed each event to its scope by `dataHome` and reported each
    // part as its own count: 3 prompts in P, then 2 in Q, no Stop yet.
    const at = (s: number, type: string, cwd: string, dataHome: string) => JSON.stringify({
      type, timestamp: new Date(Date.now() - 600_000 + s * 1000).toISOString(), sessionId: 'split', tool: 'claude', cwd, dataHome,
    });
    const p = getDataHome(project);
    const q = getDataHome(projectQ);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      at(0, 'session_start', root, p), at(1, 'prompt_submit', root, p), at(2, 'prompt_submit', root, p), at(3, 'prompt_submit', root, p),
      at(10, 'prompt_submit', rootQ, q), at(11, 'prompt_submit', rootQ, q),
    ].join('\n') + '\n');
    const today = new Date().toISOString().slice(0, 10);
    writeSharedSnapshots({ split: 3 }, today, project);
    writeSharedSnapshots({ split: 2 }, today, projectQ);

    expect(await report(project)).toBeNull();
    expect(await report(projectQ)).toBeNull();
  });

  it('main split a session with the same prompts in each part: the owner still credits every part\'s active time', async () => {
    const { root, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    const p = getDataHome(project);
    const q = getDataHome(projectQ);
    const tokens = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 });
    const at = (minute: number, type: string, cwd: string, dataHome: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type, timestamp: new Date(Date.now() - 3_600_000 + minute * 60_000).toISOString(), sessionId: 'split', tool: 'claude', cwd, dataHome, ...extra,
    });
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // One prompt. P's part was active 4 minutes; Q's, after a pause, 3 more, with no new prompt.
    fs.writeFileSync(log, [
      at(0, 'prompt_submit', root, p), at(4, 'stop', root, p, { prompts: 1, tokens: tokens(100) }),
      at(10, 'tool_use', rootQ, q), at(12, 'tool_use', rootQ, q), at(13, 'stop', rootQ, q, { prompts: 1, tokens: tokens(150) }),
    ].join('\n') + '\n');
    const date = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);
    for (const [config, input, minutes] of [[project, 100, 4], [projectQ, 150, 3]] as const) {
      const dir = path.join(getDataHome(config), 'dashboard');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'reported-prompt-tokens.json'), JSON.stringify({ split: { prompts: 1, tokens: tokens(input) } }));
      fs.writeFileSync(path.join(dir, 'reported-interventions.json'), JSON.stringify({ split: { interrupt: 0, toolReject: 0, correction: 0 } }));
      fs.writeFileSync(path.join(dir, 'reported-daily-sessions.json'), JSON.stringify({ split: {
        date, prompts: 1, durationMs: minutes * 60_000, succeeded: 1, corrected: 0, requestDaily: {},
      } }));
    }

    // Both parts already reported their time: the owner sends none of it again.
    expect(await report(projectQ)).toBeNull();
    expect(await report(project)).toBeNull();
  });

  it('main split a session whose parts each ended in a cumulative Stop: a new prompt is reported once', async () => {
    const { root, project } = await setup();
    const { rootQ, projectQ } = await setupQ();
    const at = (s: number, type: string, cwd: string, dataHome: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type, timestamp: new Date(Date.now() - 600_000 + s * 1000).toISOString(), sessionId: 'split', tool: 'claude', cwd, dataHome, ...extra,
    });
    const p = getDataHome(project);
    const q = getDataHome(projectQ);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      at(0, 'session_start', root, p), at(1, 'prompt_submit', root, p), at(2, 'stop', root, p, { prompts: 3 }),
      at(10, 'prompt_submit', rootQ, q), at(11, 'stop', rootQ, q, { prompts: 5 }),
    ].join('\n') + '\n');
    const today = new Date().toISOString().slice(0, 10);
    // Each Stop carried the transcript's total, so Q's snapshot already spans P's part.
    writeSharedSnapshots({ split: 3 }, today, project);
    writeSharedSnapshots({ split: 5 }, today, projectQ);
    expect(await report(project)).toBeNull();
    expect(await report(projectQ)).toBeNull();
    fs.appendFileSync(log, [at(20, 'prompt_submit', rootQ, q), at(21, 'stop', rootQ, q, { prompts: 6 })].join('\n') + '\n');

    expect((await reportedPrompts(project)) + (await reportedPrompts(projectQ))).toBe(1);
  });

  it('a transcript that started in a project whose snapshot lacks the session does not hand it there', async () => {
    await setup();
    const { rootQ, projectQ } = await setupQ();
    const { rootW } = await setupWorkspaceProject();
    const transcript = path.join(tmp, 'forked.jsonl');
    // A fork copies W's history under a new ID W never reported: Q's as usual.
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: 'forked', cwd: rootW }) + '\n');
    await session('claude', { session_id: 'forked', cwd: rootQ, transcript_path: transcript });

    expect(await reportedSessions(projectQ)).toBe(1);
  });

  it('the session owners a report keeps hold no path (#666)', async () => {
    const { root, project } = await setup();
    await session('copilot', { session_id: 'copilot-p', cwd: root });
    await report(project);

    const owners = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'session-owners.jsonl'), 'utf-8');
    expect(owners).toContain('copilot-p');
    expect(owners).not.toContain(root);
    expect(owners).not.toContain(getDataHome(project));
  });

  it('a session resumed after compaction dropped its events is still the one already reported', async () => {
    const { root, project } = await setup();
    await session('claude', { session_id: 'resumed', cwd: root });
    await hook('session-end', 'claude', { session_id: 'resumed', cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    // `claude --resume`: the same session ID, compared against what P reported.
    await session('claude', { session_id: 'resumed', cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it.each([
    ['a shared snapshot, before #785', false],
    ['the scope\'s own snapshot, main since #795', true],
  ])('a later run of a bare ID that release never reported is sent: %s', async (_, ownSnapshot) => {
    const { root, project } = await setup();
    const [tool, payload] = ownSnapshot ? ['copilot', {}] : ['claude', { cwd: root }];
    const run = async () => {
      await session(tool, { ...payload, cwd: root });
      await hook('session-end', tool, { ...payload, cwd: root, hook_event_name: 'SessionEnd' });
    };
    // That release reported the first run; the second came after its last report.
    await asEarlierRelease(async () => { await run(); await run(); }, ownSnapshot ? getDataHome(project) : undefined);
    const events = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8');
    const id: string = JSON.parse(events.split('\n')[0]).sessionId;
    writeSharedSnapshots({ [id]: 1 }, new Date().toISOString().slice(0, 10), ownSnapshot ? project : undefined);

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedInterventionSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a pre-upgrade exit reported before the next run\'s first prompt does not count that run twice', async () => {
    const { project } = await setup();
    const p = await dataHomeKeyOf(project);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    const at = (type: string, s: number) =>
      JSON.stringify({ type, timestamp: new Date(Date.now() - 600_000 + s * 1000).toISOString(), sessionId: 'pid-9', tool: 'copilot', dataHomeKey: p });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // Run 1 ends; run 2 starts; a dashboard from before processExitAfter appends
    // the exit it observed for run 1. A pull runs before run 2's first prompt.
    fs.writeFileSync(log, [at('session_start', 0), at('prompt_submit', 1), at('stop', 2), at('session_end', 3),
      at('session_start', 10), at('process_exit', 11)].join('\n') + '\n');
    expect(await reportedInterventionSessions(project)).toBe(2);
    // Run 2 goes on: the exit is now followed by its activity, so it was run 1's,
    // and run 2 keeps its ID, compared against what the first pull reported.
    fs.appendFileSync(log, [at('prompt_submit', 20), at('stop', 21)].join('\n') + '\n');

    expect(await reportedInterventionSessions(project)).toBe(2);
    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('a fallback ID reused in a project after a user-scope run that never ended is the project\'s', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    await session('copilot', { cwd: elsewhere });
    // That invocation crashed with no dashboard running: nothing ended it. Its
    // process, recorded at SessionStart, is not the next invocation's.
    fs.writeFileSync(log, fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean)
      .map((line) => JSON.stringify({ ...JSON.parse(line), ...(line.includes('"monitorPid"') ? { monitorPid: 99999999 } : {}) }))
      .join('\n') + '\n');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
    expect(await reportedSessions(user)).toBe(1);
    expect(await reportedPrompts(user)).toBe(1);
  });

  it('a shared bare entry is consumed in the order of every scope\'s runs, not one scope\'s', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // A release before #666 recorded Copilot's cwd. It reported the user-scope
    // run of `pid-7` as 1 prompt, then recorded P's run of that ID unreported.
    const timestamp = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString();
    const event = (type: string, s: number, cwd: string) => ({ type, timestamp: timestamp(s), sessionId: 'pid-7', tool: 'copilot', cwd });
    const log = [
      event('session_start', 0, elsewhere), event('prompt_submit', 1, elsewhere), event('stop', 2, elsewhere), event('session_end', 3, elsewhere),
      event('session_start', 10, root), event('prompt_submit', 11, root), event('stop', 12, root), event('session_end', 13, root),
    ];
    fs.mkdirSync(path.join(teamaiHome(), 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeSharedSnapshots({ 'pid-7': 1 }, new Date().toISOString().slice(0, 10));

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
    expect(await report(user)).toBeNull();
  });

  it('the first report after the upgrade sends nothing a shared snapshot already reported', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await asEarlierRelease(async () => {
      await session('claude', { session_id: 'old-p', cwd: root });
      await session('claude', { session_id: 'old-u', cwd: elsewhere });
    });
    writeSharedSnapshots({ 'old-p': 1, 'old-u': 1 }, new Date().toISOString().slice(0, 10));

    expect(await report(user)).toBeNull();
    expect(await report(project)).toBeNull();
  });

  it('once seeded, a scope reads and writes only its own snapshot, even after a rollback rewrites the shared one', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const today = new Date().toISOString().slice(0, 10);
    writeSharedSnapshots({ 'old-p': 1 }, today);
    const before = SNAPSHOTS.map((name) => fs.readFileSync(shared(name), 'utf-8'));

    await session('claude', { session_id: 'new-p', cwd: root });
    expect(await reportedPrompts(project)).toBe(1);
    await session('claude', { session_id: 'new-u', cwd: elsewhere });
    expect(await reportedPrompts(user)).toBe(1);
    expect(SNAPSHOTS.map((name) => fs.readFileSync(shared(name), 'utf-8'))).toEqual(before);

    // An earlier release, after a rollback, records and reports two more
    // sessions and writes the shared snapshots again.
    await session('claude', { session_id: 'rollback-p', cwd: root });
    await session('claude', { session_id: 'rollback-u', cwd: elsewhere });
    writeSharedSnapshots({ 'old-p': 1, 'rollback-p': 1, 'rollback-u': 1 }, today);

    // Both scopes were seeded before the rollback and read only their own
    // snapshot, so each reports its session again, as the ticket asks.
    expect(await reportedPrompts(project)).toBe(2);
    expect(await reportedPrompts(user)).toBe(2);
  });

  it.each([
    ['nothing new', 1],
    ['a new prompt', 0],
  ])('a bare snapshot entry a run adopts is written back under the run ID only, with %s to report', async (_, reported) => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    // Main since #795 recorded and reported this run under its bare session ID.
    await asEarlierRelease(() => session('copilot', { cwd: root }), getDataHome(project));
    // Main writes this acknowledgement to P's own snapshot, not the shared file.
    writeSharedSnapshots({ [pid]: reported }, new Date().toISOString().slice(0, 10), project);
    await report(project);

    for (const name of SNAPSHOTS) {
      const own = JSON.parse(fs.readFileSync(path.join(getDataHome(project), 'dashboard', `reported-${name}.json`), 'utf-8'));
      expect(Object.keys(own)).toEqual([expect.stringMatching(new RegExp(`^${pid}@`))]);
    }
    // Compaction dropped that run; the next one in P reuses its ID and is a new session.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
  });

  it('a session the shared snapshot reported is not sent again after compaction dropped its events', async () => {
    const { root, project } = await setup();
    // Reported before #795 into the shared snapshot and compacted; P's first
    // pull seeds its own snapshot; then it is resumed in P, its Stop carrying 2.
    writeSharedSnapshots({ resumed: 1 }, new Date().toISOString().slice(0, 10));
    expect(await report(project)).toBeNull();
    await resume('resumed', root, 2);

    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a snapshot entry an earlier release wrote without tokens does not stop the report', async () => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    await asEarlierRelease(() => session('copilot', { cwd: root }), getDataHome(project));
    // Hand-edited or truncated: no `tokens`, under the bare fallback ID.
    const dir = path.join(getDataHome(project), 'dashboard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reported-prompt-tokens.json'), JSON.stringify({ [pid]: { prompts: 1 } }));

    expect(await report(project)).not.toBeNull();
    expect(await reportedPrompts(project)).toBe(0);
  });

  it('a scope first seeded after a rollback skips what the earlier release reported', async () => {
    const { root, project } = await setup();
    await asEarlierRelease(() => session('claude', { session_id: 'rollback-p', cwd: root }));
    writeSharedSnapshots({ 'rollback-p': 1 }, new Date().toISOString().slice(0, 10));

    expect(await report(project)).toBeNull();
  });
});
