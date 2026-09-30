import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptBareKeys } from '../team-push.js';
import { filterEventsByScope } from '../dashboard-scope.js';
import { dataHomeKey } from '../dashboard-collector.js';
import type { DashboardEvent, LocalConfig } from '../types.js';

/** An event written before events carried a data home key, attributed by cwd. */
function makeEvent(cwd: string | undefined, sessionId = 's1'): DashboardEvent {
  return { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId, tool: 'claude', cwd };
}

/** An event recorded by the scope whose data home is `dataHome`. */
async function scopedEvent(cwd: string | undefined, sessionId: string, dataHome: string): Promise<DashboardEvent> {
  return { ...makeEvent(cwd, sessionId), dataHomeKey: await dataHomeKey(dataHome) };
}

const repo = { localPath: '/unused/team-repo', remote: 'https://example.test/team.git' };

function projectScope(projectRoot: string, dataHome = '/home/jeff/.teamai/projects/p'): LocalConfig {
  return { repo, username: 'jeff', scope: 'project', additionalRoles: [], projectRoot, dataHome };
}

function userScope(dataHome = '/home/jeff/.teamai'): LocalConfig {
  return { repo, username: 'jeff', scope: 'user', additionalRoles: [], dataHome };
}

/** The session of each event a scope keeps: its run ID without a fallback run's start. */
async function ids(events: DashboardEvent[], config?: LocalConfig): Promise<string[]> {
  return (await filterEventsByScope(events, config)).map((e) =>
    e.sessionId.startsWith('pid-') ? e.sessionId.slice(0, e.sessionId.lastIndexOf('@')) : e.sessionId);
}

describe('filterEventsByScope', () => {
  const events: DashboardEvent[] = [
    makeEvent('/Users/jeff/project-a', 's1'),
    makeEvent('/Users/jeff/project-a/src', 's2'),
    makeEvent('/Users/jeff/other-work', 's3'),
    makeEvent('/Users/jeff/project-b', 's4'),
    makeEvent(undefined, 's5'),
  ];

  it('returns all events when no scope is given', async () => {
    expect(await filterEventsByScope(events)).toEqual(events);
  });

  describe('events that carry a data home key', () => {
    const scoped = (): Promise<DashboardEvent[]> => Promise.all([
      scopedEvent('/Users/jeff/project-a', 'p1', '/home/jeff/.teamai/projects/p'),
      scopedEvent(undefined, 'p2', '/home/jeff/.teamai/projects/p'),
      scopedEvent('/Users/jeff/project-a', 'u1', '/home/jeff/.teamai'),
      scopedEvent('/Users/jeff/project-a', 'q1', '/home/jeff/.teamai/projects/q'),
    ]);

    it('a project keeps its own, whatever their cwd', async () => {
      expect(await ids(await scoped(), projectScope('/Users/jeff/project-a'))).toEqual(['p1', 'p2']);
    });

    it('the user scope keeps its own and no project\'s', async () => {
      expect(await ids(await scoped(), userScope())).toEqual(['u1']);
    });

    it('a session goes whole to the scope of its first keyed event', async () => {
      // A Stop carries the whole transcript's totals, so P must not count them again.
      const moved = [
        makeEvent('/Users/jeff/other-work', 'm1'),
        await scopedEvent('/Users/jeff/other-work', 'm1', '/home/jeff/.teamai'),
        { ...(await scopedEvent('/Users/jeff/project-a', 'm1', '/home/jeff/.teamai/projects/p')), type: 'stop' as const, prompts: 5 },
      ];
      expect(await ids(moved, userScope())).toEqual(['m1', 'm1', 'm1']);
      expect(await ids(moved, projectScope('/Users/jeff/project-a'))).toEqual([]);
    });

    it('a session ID reused after its session ended is decided anew', async () => {
      // A PID-fallback ID: the user-scope run ended, a later run in P reuses the ID.
      for (const end of ['session_end', 'process_exit'] as const) {
        const reused = [
          await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai'),
          { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai')), type: end },
          await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p'),
        ];
        const project = await filterEventsByScope(reused, projectScope('/Users/jeff/project-a'));
        const user = await filterEventsByScope(reused, userScope());
        // Each run is its own session, under the ID plus its first event's timestamp.
        const first = `pid-1@${reused[0].timestamp}`;
        expect(project).toEqual([{ ...reused[2], sessionId: `pid-1@${reused[2].timestamp}` }]);
        expect(user).toEqual([{ ...reused[0], sessionId: first }, { ...reused[1], sessionId: first }]);
      }
    });

    it('a second end of a run, with nothing recorded between the two, joins the run that just closed', async () => {
      // The dashboard monitor appends process_exit after the SessionEnd hook's session_end.
      const p = '/home/jeff/.teamai/projects/p';
      const at = (e: DashboardEvent, timestamp: string): DashboardEvent => ({ ...e, timestamp });
      const log = [
        at(await scopedEvent(undefined, 'pid-1', p), '2026-01-01T00:00:00.000Z'),
        at({ ...(await scopedEvent(undefined, 'pid-1', p)), type: 'session_end' }, '2026-01-01T00:01:00.000Z'),
        at({ ...(await scopedEvent(undefined, 'pid-1', p)), type: 'process_exit' }, '2026-01-01T00:01:05.000Z'),
        at(await scopedEvent(undefined, 'pid-1', p), '2026-01-01T00:02:00.000Z'),
        at({ ...(await scopedEvent(undefined, 'pid-1', p)), type: 'process_exit' }, '2026-01-01T00:03:00.000Z'),
      ];
      expect((await filterEventsByScope(log, projectScope('/Users/jeff/project-a'))).map((e) => e.sessionId)).toEqual([
        'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z',
        'pid-1@2026-01-01T00:02:00.000Z', 'pid-1@2026-01-01T00:02:00.000Z',
      ]);
    });

    it('a run keeps its ID after compaction drops the earlier runs of its ID', async () => {
      const ended = [
        await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p'),
        { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p')), type: 'session_end' as const },
      ];
      const later = { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p')), timestamp: '2099-01-01T00:00:00.000Z' };
      const before = await filterEventsByScope([...ended, later], projectScope('/Users/jeff/project-a'));
      const after = await filterEventsByScope([later], projectScope('/Users/jeff/project-a'));
      expect(after.map((e) => e.sessionId)).toEqual(['pid-1@2099-01-01T00:00:00.000Z']);
      expect(before[2].sessionId).toBe(after[0].sessionId);
    });

    it('an exit a dashboard before processExitAfter wrote just after the next run began ends the earlier run', async () => {
      // That monitor read the log before SessionEnd and the next SessionStart,
      // then appended its exit, unannotated, after them.
      const p = '/home/jeff/.teamai/projects/p';
      const at = async (type: DashboardEvent['type'], timestamp: string) =>
        ({ ...(await scopedEvent(undefined, 'pid-1', p)), type, timestamp });
      const log = [
        await at('session_start', '2026-01-01T00:00:00.000Z'),
        await at('session_end', '2026-01-01T00:01:00.000Z'),
        await at('session_start', '2026-01-01T00:01:01.000Z'),
        await at('process_exit', '2026-01-01T00:01:02.000Z'),
        await at('prompt_submit', '2026-01-01T00:01:03.000Z'),
      ];
      const project = await filterEventsByScope(log, projectScope('/Users/jeff/project-a'));
      expect(project.map((e) => e.sessionId)).toEqual([
        'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z',
        'pid-1@2026-01-01T00:01:01.000Z', 'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:01:01.000Z',
      ]);
    });

    it('an unannotated exit followed by more of the open run did not end it, however late it came', async () => {
      // A delayed callback or skewed clock: a dead process records nothing more,
      // so the prompt after the exit shows the open run went on.
      const p = '/home/jeff/.teamai/projects/p';
      const at = async (type: DashboardEvent['type'], timestamp: string) =>
        ({ ...(await scopedEvent(undefined, 'pid-1', p)), type, timestamp });
      const log = [
        await at('session_start', '2026-01-01T00:00:00.000Z'),
        await at('session_end', '2026-01-01T00:01:00.000Z'),
        await at('session_start', '2026-01-01T00:02:00.000Z'),
        await at('process_exit', '2026-01-01T00:03:00.000Z'),
        await at('prompt_submit', '2026-01-01T00:04:00.000Z'),
      ];
      const project = await filterEventsByScope(log, projectScope('/Users/jeff/project-a'));
      expect(project.map((e) => e.sessionId)).toEqual([
        'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z',
        'pid-1@2026-01-01T00:02:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:02:00.000Z',
      ]);
    });

    it('an unannotated exit of a run a new process superseded does not end the new run', async () => {
      // The first run crashed with nothing ending it; a dashboard before
      // processExitAfter appends its exit after the next invocation started.
      const p = '/home/jeff/.teamai/projects/p';
      const at = async (type: DashboardEvent['type'], timestamp: string, fields: Partial<DashboardEvent> = {}) =>
        ({ ...(await scopedEvent(undefined, 'pid-1', p)), type, timestamp, ...fields });
      const log = [
        await at('session_start', '2026-01-01T00:00:00.000Z', { monitorPid: 100 }),
        await at('prompt_submit', '2026-01-01T00:00:30.000Z'),
        await at('session_start', '2026-01-01T00:02:00.000Z', { monitorPid: 200 }),
        await at('process_exit', '2026-01-01T00:02:05.000Z'),
        await at('prompt_submit', '2026-01-01T00:03:00.000Z'),
      ];
      const project = await filterEventsByScope(log, projectScope('/Users/jeff/project-a'));
      expect(project.map((e) => e.sessionId)).toEqual([
        'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z',
        'pid-1@2026-01-01T00:02:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:02:00.000Z',
      ]);
    });

    it('an unannotated exit with nothing more of the open run ends it', async () => {
      const p = '/home/jeff/.teamai/projects/p';
      const at = async (type: DashboardEvent['type'], timestamp: string) =>
        ({ ...(await scopedEvent(undefined, 'pid-1', p)), type, timestamp });
      const log = [
        await at('session_start', '2026-01-01T00:00:00.000Z'),
        await at('session_end', '2026-01-01T00:01:00.000Z'),
        await at('session_start', '2026-01-01T00:02:00.000Z'),
        await at('process_exit', '2026-01-01T00:03:00.000Z'),
        await at('session_start', '2026-01-01T00:04:00.000Z'),
      ];
      const project = await filterEventsByScope(log, projectScope('/Users/jeff/project-a'));
      expect(project.map((e) => e.sessionId)).toEqual([
        'pid-1@2026-01-01T00:00:00.000Z', 'pid-1@2026-01-01T00:00:00.000Z',
        'pid-1@2026-01-01T00:02:00.000Z', 'pid-1@2026-01-01T00:02:00.000Z', 'pid-1@2026-01-01T00:04:00.000Z',
      ]);
    });

    it('a delayed observed exit targets the earlier run across scopes and is ignored after that run is compacted', async () => {
      const old = { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai')), timestamp: '2026-01-01T00:00:00Z' };
      const ended = { ...old, type: 'session_end' as const, timestamp: '2026-01-01T00:01:00Z' };
      const next = { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p')), timestamp: '2026-01-01T00:02:00Z' };
      const delayed = { ...old, type: 'process_exit' as const, timestamp: '2026-01-01T00:03:00Z', processExitAfter: old.timestamp };
      const prompt = { ...next, timestamp: '2026-01-01T00:04:00Z' };
      const exit = { ...next, type: 'process_exit' as const, timestamp: '2026-01-01T00:05:00Z', processExitAfter: prompt.timestamp };
      const later = { ...next, timestamp: '2026-01-01T00:06:00Z' };
      for (const history of [[old, ended], []]) {
        const log = [...history, next, delayed, prompt, exit, later];
        const project = await filterEventsByScope(log, projectScope('/Users/jeff/project-a'));
        expect(project.map(e => e.sessionId)).toEqual([
          `pid-1@${next.timestamp}`, `pid-1@${next.timestamp}`, `pid-1@${next.timestamp}`, `pid-1@${later.timestamp}`,
        ]);
        const user = await filterEventsByScope(log, userScope());
        expect(user).toHaveLength(history.length ? 3 : 0);
      }
    });

    it('a tool\'s own session ID stays one run across an end and a resume', async () => {
      // `claude --resume` after the dashboard recorded the exit: its Stop carries
      // the whole transcript, so a second run would count it again.
      for (const end of ['session_end', 'process_exit'] as const) {
        const log = [
          await scopedEvent(undefined, 'claude-uuid', '/home/jeff/.teamai'),
          { ...(await scopedEvent(undefined, 'claude-uuid', '/home/jeff/.teamai')), type: end },
          { ...(await scopedEvent(undefined, 'claude-uuid', '/home/jeff/.teamai/projects/p')), type: 'session_start' as const },
          await scopedEvent(undefined, 'claude-uuid', '/home/jeff/.teamai/projects/p'),
        ];
        const user = await filterEventsByScope(log, userScope());
        // Keyed by the ID alone, so it stays the same session after compaction drops its events.
        expect(user.map((e) => e.sessionId)).toEqual(Array(4).fill('claude-uuid'));
        expect(await ids(log, projectScope('/Users/jeff/project-a'))).toEqual([]);
      }
    });

    it('a fallback ID started by another process is a new run, though the last one never ended', async () => {
      // The user-scope run crashed with no dashboard running, so nothing ended it.
      const start = (sessionId: string, dataHome: string, monitorPid: number) => scopedEvent(undefined, sessionId, dataHome)
        .then((e) => ({ ...e, type: 'session_start' as const, monitorPid }));
      for (const id of ['pid-1', 'pid-1-/Users/jeff/project-a']) {
        const log = [
          await start(id, '/home/jeff/.teamai', 100),
          await scopedEvent(undefined, id, '/home/jeff/.teamai'),
          await start(id, '/home/jeff/.teamai/projects/p', 200),
          await scopedEvent(undefined, id, '/home/jeff/.teamai/projects/p'),
        ];
        expect(await ids(log, projectScope('/Users/jeff/project-a'))).toEqual([id, id]);
        expect(await ids(log, userScope())).toEqual([id, id]);
      }
    });

    it('a start from the same process, or under a tool\'s own session ID, stays in the open run', async () => {
      // Claude fires SessionStart again on compact and on resume, a new process for
      // the same session; its Stop carries the whole transcript, so it must stay one run.
      const cases: Array<[string, number]> = [['pid-1', 100], ['claude-uuid', 200]];
      for (const [id, pid] of cases) {
        const log = [
          { ...(await scopedEvent(undefined, id, '/home/jeff/.teamai')), type: 'session_start' as const, monitorPid: 100 },
          { ...(await scopedEvent(undefined, id, '/home/jeff/.teamai/projects/p')), type: 'session_start' as const, monitorPid: pid },
          await scopedEvent(undefined, id, '/home/jeff/.teamai/projects/p'),
        ];
        expect(await ids(log, userScope())).toEqual([id, id, id]);
        expect(await ids(log, projectScope('/Users/jeff/project-a'))).toEqual([]);
      }
    });

    it('an event that records its data home as a path, before keys were hashed, is keyed by it', async () => {
      const unhashed: DashboardEvent[] = [
        { ...makeEvent(undefined, 'c1'), tool: 'copilot', dataHome: '/home/jeff/.teamai/projects/p' },
        { ...makeEvent('/Users/jeff/project-a', 'u1'), dataHome: '/home/jeff/.teamai' },
      ];
      expect(await ids(unhashed, projectScope('/Users/jeff/project-a'))).toEqual(['c1']);
      expect(await ids(unhashed, userScope())).toEqual(['u1']);
    });

    it('a keyed event decides a session over an earlier unkeyed one', async () => {
      // Recorded across the upgrade: the unkeyed event's cwd is P's, the key the user scope's.
      const upgraded = [
        makeEvent('/Users/jeff/project-a', 'x1'),
        await scopedEvent('/Users/jeff/project-a', 'x1', '/home/jeff/.teamai'),
      ];
      expect(await ids(upgraded, projectScope('/Users/jeff/project-a'))).toEqual([]);
      expect(await ids(upgraded, userScope())).toEqual(['x1', 'x1']);
    });

    it('a project keeps what it recorded under its in-repo .teamai before moving to a partition', async () => {
      const legacy = [await scopedEvent(undefined, 'l1', '/Users/jeff/project-a/.teamai')];
      expect(await ids(legacy, projectScope('/Users/jeff/project-a'))).toEqual(['l1']);
      expect(await ids(legacy, userScope())).toEqual([]);
    });

    it('a project rooted at HOME does not take the user scope\'s events', async () => {
      const home = os.homedir();
      const evts = [await scopedEvent(undefined, 'u1', path.join(home, '.teamai'))];
      expect(await ids(evts, projectScope(home))).toEqual([]);
    });

    it('matches a data home reached through a symlink', async () => {
      const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-key-')));
      try {
        fs.mkdirSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'), 'dir');
        const evts = [await scopedEvent(undefined, 'k1', path.join(tmp, 'link', '.teamai'))];
        const config = projectScope(path.join(tmp, 'real'), path.join(tmp, 'real', '.teamai'));
        expect(await ids(evts, config)).toEqual(['k1']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('keeps what a project recorded in its in-repo .teamai after migration removed it', async () => {
      const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-gone-')));
      try {
        fs.mkdirSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'), 'dir');
        const evts = [await scopedEvent(undefined, 'g1', path.join(tmp, 'link', '.teamai'))];
        fs.rmSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        expect(await ids(evts, projectScope(path.join(tmp, 'link')))).toEqual(['g1']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('a Windows data home matches whatever its case or separators', async () => {
      const win = await Promise.all([scopedEvent(undefined, 'w1', 'C:\\Users\\Jeff\\.teamai'), scopedEvent(undefined, 'w2', 'C:\\Users\\jeff\\.teamai\\projects\\p')]);
      expect(await ids(win, userScope('c:/users/jeff/.teamai'))).toEqual(['w1']);
    });
  });

  it('an event whose key is not a string counts as written before keys existed', async () => {
    // A hand-edited or corrupted line in the shared log: a later keyed event decides the session.
    const corrupt: DashboardEvent[] = JSON.parse(JSON.stringify([
      { ...makeEvent('/Users/jeff/project-a', 'c1'), dataHomeKey: null },
      { ...makeEvent('/Users/jeff/project-a', 'c2'), dataHomeKey: 42 },
    ]));
    const decided = [
      corrupt[0], await scopedEvent(undefined, 'c1', '/home/jeff/.teamai/projects/p'),
      corrupt[1], await scopedEvent(undefined, 'c2', '/home/jeff/.teamai/projects/p'),
    ];
    expect(await ids(decided, projectScope('/Users/jeff/project-a'))).toEqual(['c1', 'c1', 'c2', 'c2']);
    expect(await ids(decided, userScope())).toEqual([]);
  });
});

describe('adoptBareKeys', () => {
  /** A run's event as filterEventsByScope returns it; an earlier release's unless `fields` key it. */
  const run = (sessionId: string, fields: Partial<DashboardEvent> = {}): DashboardEvent =>
    ({ type: 'prompt_submit', timestamp: 't', sessionId, tool: 'copilot', ...fields });
  /** A counter's share: up to the run's own, while any of the sum is left. */
  const take = (own: number, left: number) => (left > 0 ? { taken: Math.min(own, left), left: left - Math.min(own, left) } : undefined);

  it('consumes a bare entry, the sum of its runs, across them in order', () => {
    // An earlier release summed every run of the ID under it: each run takes up
    // to its own totals of what is left, so none is sent again.
    const events = [run('pid-1@t1'), run('pid-1@t2'), run('s2@t0'), run('s3@t3')];
    const reported = { 'pid-1': 6, 's2@t0': 1 };
    expect(adoptBareKeys(reported, events, { 'pid-1@t1': 5, 'pid-1@t2': 3, 's3@t3': 4 }, take))
      .toEqual({ 'pid-1@t1': 5, 'pid-1@t2': 1, 's2@t0': 1 });
  });

  it('a later run the sum does not reach takes nothing: it was not reported', () => {
    // Run 1 reported as 5; run 2 came after the last report of that release.
    const adopted = adoptBareKeys({ 'pid-1': 5 }, [run('pid-1@t1'), run('pid-1@t2')], { 'pid-1@t1': 5, 'pid-1@t2': 3 }, take);
    expect(adopted).toEqual({ 'pid-1@t1': 5 });
  });

  it('the first run takes the entry even when nothing of it is left to share', () => {
    // A bare entry means that release reported the ID, so its first run is not new.
    expect(adoptBareKeys({ 'pid-1': 0 }, [run('pid-1@t1'), run('pid-1@t2')], { 'pid-1@t1': 2, 'pid-1@t2': 1 }, take))
      .toEqual({ 'pid-1@t1': 0 });
  });

  it('never overrides a run\'s own entry, which still takes its share', () => {
    expect(adoptBareKeys({ 'pid-1': 3, 'pid-1@t1': 5 }, [run('pid-1@t1')], { 'pid-1@t1': 5 }, take)['pid-1@t1']).toBe(5);
    expect(adoptBareKeys({ 'pid-1': 3, 'pid-1@t1': 5 }, [run('pid-1@t1'), run('pid-1@t2')], { 'pid-1@t1': 2, 'pid-1@t2': 4 }, take))
      .toEqual({ 'pid-1@t1': 5, 'pid-1@t2': 1 });
  });

  it('retires the bare entry its runs read, so it is never read again', () => {
    expect(adoptBareKeys({ 'pid-1': 3, s2: 1 }, [run('pid-1@t1'), run('pid-1@t2')], { 'pid-1@t1': 1, 'pid-1@t2': 5 }, take))
      .toEqual({ 'pid-1@t1': 1, 'pid-1@t2': 2, s2: 1 });
  });

  it('leaves a tool\'s own session ID alone: its run is keyed by the ID itself', () => {
    const reported = { 'claude-uuid': 3 };
    expect(adoptBareKeys(reported, [run('claude-uuid')], { 'claude-uuid': 4 }, take)).toBe(reported);
  });

  it('returns the snapshot itself when it holds no bare entry to retire', () => {
    const reported = { 'pid-1@t1': 5, s2: 1 };
    expect(adoptBareKeys(reported, [run('pid-1@t1'), run('s3@t3')], { 'pid-1@t1': 5 }, take)).toBe(reported);
  });

  it('gives no bare entry to a run this build recorded: only an earlier release wrote them', () => {
    // Another scope's run, maybe: the bare entry says nothing about which scope reported it.
    const reported = { 'pid-1': 3 };
    expect(adoptBareKeys(reported, [run('pid-1@t1', { dataHomeKey: 'k' }), run('pid-1@t2')], { 'pid-1@t1': 1, 'pid-1@t2': 1 }, take))
      .toBe(reported);
  });

  it('a run recorded by main since #795, which wrote the data home path, is an earlier release\'s', () => {
    expect(adoptBareKeys({ 'pid-1': 3 }, [run('pid-1@t1', { dataHome: '/home/jeff/.teamai' })], { 'pid-1@t1': 3 }, take))
      .toEqual({ 'pid-1@t1': 3 });
  });

  it('does not give a path-keyed run a shared bare entry, but still adopts its own scope entry', () => {
    const reported = { 'pid-1': 3 };
    const events = [run('pid-1@t1', { dataHome: '/home/jeff/.teamai/projects/p' })];
    expect(adoptBareKeys(reported, events, { 'pid-1@t1': 3 }, take, 'shared')).toBe(reported);
    expect(adoptBareKeys(reported, events, { 'pid-1@t1': 3 }, take, 'scope')).toEqual({ 'pid-1@t1': 3 });
  });

  it('a run in progress across the upgrade is an earlier release\'s, by its first event', () => {
    expect(adoptBareKeys({ 'pid-1': 3 }, [run('pid-1@t1'), run('pid-1@t1', { dataHomeKey: 'k' })], { 'pid-1@t1': 4 }, take))
      .toEqual({ 'pid-1@t1': 3 });
  });
});
