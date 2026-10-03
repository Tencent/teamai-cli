/**
 * The dashboard events each scope reports (#785): the log split into runs, and
 * each run given, whole, to the scope it started in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataHomeKey, resolveCopilotUsageTranscript } from './dashboard-collector.js';
import { pathExists, readJson } from './utils/fs.js';
import type { DashboardEvent, LocalConfig } from './types.js';
import { getDataHome } from './types.js';
import { getUserHome } from './utils/home.js';
import { REPORTED_SNAPSHOTS, readSessionOwners, snapshotPathIn } from './session-owners.js';

/**
 * The dashboard events a scope reports (#785): every event of the sessions
 * recorded in it. A session is the run of one ID up to its session_end or
 * process_exit, since a PID-fallback ID comes back for a later run; each run
 * is returned under its own ID (see {@link adoptBareKeys}). It is
 * decided once, whole, by its first event keyed with a data home
 * (`dataHomeKey`, or the path an unreleased build of #795 wrote), because a
 * Stop carries the whole transcript's totals: split per event, a session that
 * moved into another scope would count there again the part recorded before
 * the move. A project also owns the key of its in-repo `.teamai`, where a
 * hook recorded until migration moved the project to a partition. A session
 * written before events carried a key is decided by its first cwd, by the
 * dispatcher's rule: the scope that directory resolves to now, so a nested
 * clone under a project is not the project's; one with no cwd, or a cwd gone
 * since, is no scope's. A tool's own session ID a scope has recorded as its
 * own (see `session-owners.jsonl`) is that scope's, whatever the log still
 * holds. A caller without a scope config reads the whole log. With `dryRun`,
 * the owners index is not seeded on disk (see {@link readSessionOwners}).
 */
export async function filterEventsByScope(
  events: DashboardEvent[],
  config?: LocalConfig,
  options: { dryRun?: boolean } = {},
): Promise<DashboardEvent[]> {
  if (!config) return events;
  const ownKey = await dataHomeKey(getDataHome(config));
  const keys = new Set([ownKey]);
  if (config.projectRoot) {
    // Unless the project is rooted at HOME, where that is the user scope's.
    const legacy = await dataHomeKey(path.join(config.projectRoot, '.teamai'));
    if (legacy !== (await dataHomeKey(path.join(getUserHome(), '.teamai')))) keys.add(legacy);
  }
  // Read paths: another directory's config is loaded, never migrated.
  const { resolveConfigForDir: resolve } = await import('./config.js');
  const resolveConfigForDir = (dir: string) => resolve(dir, undefined, { dryRun: true });
  const resolvesHere = new Map<string, Promise<boolean>>();
  const ownsCwd = (cwd: string): Promise<boolean> => {
    let owns = resolvesHere.get(cwd);
    if (!owns) {
      owns = pathExists(cwd).then(async (exists) => {
        const resolved = exists ? await resolveConfigForDir(cwd) : null;
        return !!resolved && keys.has(await dataHomeKey(getDataHome(resolved)));
      });
      resolvesHere.set(cwd, owns);
    }
    return owns;
  };
  const eventKeys = await keysOf(events);
  const { runOf, runIds, deciding } = splitRuns(events, eventKeys);
  const owners = await readSessionOwners(options);
  const transcripts = new Map<number, string[]>();
  events.forEach((e, i) => {
    const run = runOf[i];
    if (run === undefined) return;
    // Copilot's session log is found by its ID; the event holds no path (#666).
    const transcript = typeof e.transcriptPath === 'string' ? e.transcriptPath
      : e.tool === 'copilot' ? resolveCopilotUsageTranscript(e.sessionId) : null;
    const known = transcripts.get(run) ?? [];
    if (transcript && !known.includes(transcript)) transcripts.set(run, [...known, transcript]);
  });
  const owned = await Promise.all(deciding.map(async (i, run) => {
    // Recorded by the scope that first reported it, so a session resumed
    // elsewhere after compaction dropped its events stays that scope's.
    const owner = owners.get(runIds[run]) ?? (runIds[run].startsWith('pid-') ? undefined
      : await transcriptOwner(runIds[run], transcripts.get(run) ?? [], resolveConfigForDir));
    if (owner !== undefined) return keys.has(owner);
    if (i === undefined) return false;
    const key = eventKeys[i];
    const cwd = events[i].cwd;
    return key !== undefined ? keys.has(key) : !!cwd && await ownsCwd(cwd);
  }));
  return events.flatMap((e, i) => {
    const run = runOf[i];
    return run !== undefined && owned[run] ? [{ ...e, sessionId: runIds[run] }] : [];
  });
}

/**
 * The key of the scope a tool's own session started in, by its transcript,
 * when that scope's snapshots already hold it: an earlier release reported it
 * there, and compaction has since dropped the events that would say so. The
 * latest transcript path first, since a tool may relocate the file. Undefined
 * when there is no such transcript, origin, scope or snapshot entry (a fork
 * under a new ID, a scope that never reported it).
 */
async function transcriptOwner(
  sessionId: string,
  paths: string[],
  resolveConfigForDir: (dir: string) => Promise<LocalConfig | null>,
): Promise<string | undefined> {
  for (const transcript of [...paths].reverse()) {
    const origin = await transcriptOrigin(transcript);
    if (origin === undefined) continue;
    const config = (await pathExists(origin)) ? await resolveConfigForDir(origin) : null;
    if (!config) return undefined;
    const dataHome = getDataHome(config);
    const snapshots = await Promise.all(REPORTED_SNAPSHOTS.map((name) =>
      readJson<Record<string, unknown>>(snapshotPathIn(dataHome, name))));
    const held = snapshots.some((snapshot) => !!snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, sessionId));
    return held ? dataHomeKey(dataHome) : undefined;
  }
  return undefined;
}

/**
 * The directory a transcript's session started in: the first `cwd` a Claude
 * transcript records (a resume from another project appends to the same file),
 * a Codex rollout's `session_meta`, or a Copilot session log's `session.start`.
 * Reads a bounded head of the file; the format is the tool's own, so anything
 * else is undefined.
 */
async function transcriptOrigin(transcript: string): Promise<string | undefined> {
  let head: string;
  try {
    const fh = await fs.promises.open(transcript, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  for (const line of head.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if ('cwd' in entry && typeof entry.cwd === 'string') return entry.cwd;
    if ('type' in entry && entry.type === 'session_meta' && 'payload' in entry && entry.payload
      && typeof entry.payload === 'object' && 'cwd' in entry.payload && typeof entry.payload.cwd === 'string') {
      return entry.payload.cwd;
    }
    if ('type' in entry && entry.type === 'session.start' && 'data' in entry && entry.data && typeof entry.data === 'object'
      && 'context' in entry.data && entry.data.context && typeof entry.data.context === 'object'
      && 'cwd' in entry.data.context && typeof entry.data.context.cwd === 'string') {
      return entry.data.context.cwd;
    }
  }
  return undefined;
}

/**
 * Each event's data home key. The log is hand-editable: a key that is not a
 * string counts as absent. An unreleased build of #795 recorded the data home
 * path in place of its key.
 */
async function keysOf(events: DashboardEvent[]): Promise<Array<string | undefined>> {
  const hashes = new Map<string, Promise<string>>();
  return Promise.all(events.map((e) => {
    if (typeof e.dataHomeKey === 'string') return e.dataHomeKey;
    if (typeof e.dataHome !== 'string') return undefined;
    let key = hashes.get(e.dataHome);
    if (!key) {
      key = dataHomeKey(e.dataHome);
      hashes.set(e.dataHome, key);
    }
    return key;
  }));
}

/**
 * The runs of a log: each event's run (none for an exit whose run is gone),
 * each run's ID, and the event that decides its scope.
 *
 * A tool's own session ID is one run, whatever ends it records: `claude
 * --resume` continues it, in a new process, and its Stop carries the whole
 * transcript. It is returned under the ID itself, so it stays the session
 * already reported after compaction drops its events. A PID-fallback ID
 * (`pid-…`) names one run until it ends, then comes back for a later one,
 * maybe in another scope, so each run is decided on its own and returned under
 * the ID plus its first event's timestamp, which stays the same whichever
 * earlier runs compaction has dropped. A second end with nothing recorded since
 * the first (the dashboard monitor's process_exit after SessionEnd) belongs to
 * the run just closed. A start from another process than its open run's begins
 * a new run, though nothing ended that one (a crash with no dashboard running).
 * The monitor's exit names the last event it observed (`processExitAfter`).
 * A dashboard started before that field existed wrote none; since a dead
 * process records nothing more, such an exit followed by more events of its
 * fallback ID before the next start did not end the open run: it was observed
 * before that run began, and belongs to the run closed before it.
 */
function splitRuns(events: DashboardEvent[], eventKeys: Array<string | undefined>): {
  runOf: Array<number | undefined>;
  runIds: string[];
  deciding: Array<number | undefined>;
} {
  const runOf: Array<number | undefined> = [];
  const runPid: Array<number | undefined> = [];
  const observedRuns = new Map<string, number>();
  const openRun = new Map<string, number>();
  const closedRun = new Map<string, number>();
  const deciding: Array<number | undefined> = [];
  const runIds: string[] = [];
  // Whether each event is followed by activity of its ID (anything but a start
  // or a monitor exit) before that ID's next start.
  const continues: boolean[] = [];
  const active = new Map<string, boolean>();
  for (let i = events.length - 1; i >= 0; i--) {
    const { sessionId, type } = events[i];
    continues[i] = active.get(sessionId) ?? false;
    if (type === 'session_start') active.set(sessionId, false);
    else if (type !== 'process_exit') active.set(sessionId, true);
  }
  events.forEach((e, i) => {
    const fallback = e.sessionId.startsWith('pid-');
    const ends = e.type === 'session_end' || e.type === 'process_exit';
    const observed = e.type === 'process_exit' && typeof e.processExitAfter === 'string';
    const starts = e.type === 'session_start' && typeof e.monitorPid === 'number';
    const open = openRun.get(e.sessionId);
    if (starts && open !== undefined && fallback
      && typeof runPid[open] === 'number' && runPid[open] !== e.monitorPid) {
      // Nothing ended it (a crash), but a late exit of it must still find it.
      openRun.delete(e.sessionId);
      closedRun.set(e.sessionId, open);
    }
    const closed = closedRun.get(e.sessionId);
    const stale = e.type === 'process_exit' && !observed && fallback && open !== undefined && closed !== undefined
      && continues[i];
    let run = observed ? observedRuns.get(`${e.sessionId}@${e.processExitAfter}`)
      : stale ? closed : openRun.get(e.sessionId) ?? (ends ? closed : undefined);
    // The observed run may have been compacted. Its delayed exit must not
    // manufacture a new session or close a later reuse of the same ID.
    if (observed && run === undefined) {
      runOf.push(undefined);
      return;
    }
    if (run === undefined) {
      run = deciding.push(undefined) - 1;
      runIds.push(fallback ? `${e.sessionId}@${e.timestamp}` : e.sessionId);
    }
    if (ends && fallback && !stale && (!observed || openRun.get(e.sessionId) === run)) {
      openRun.delete(e.sessionId);
      closedRun.set(e.sessionId, run);
    } else if (!ends || !fallback) {
      openRun.set(e.sessionId, run);
    }
    if (starts) runPid[run] ??= e.monitorPid;
    runOf.push(run);
    observedRuns.set(`${e.sessionId}@${e.timestamp}`, run);
    const current = deciding[run];
    if (eventKeys[i] !== undefined ? current === undefined || eventKeys[current] === undefined
      : current === undefined && !!e.cwd) deciding[run] = i;
  });
  return { runOf, runIds, deciding };
}

/** Every event of the log under its run ID, whichever scope it belongs to. */
export async function runsOfLog(events: DashboardEvent[]): Promise<DashboardEvent[]> {
  const { runOf, runIds } = splitRuns(events, await keysOf(events));
  return events.flatMap((e, i) => {
    const run = runOf[i];
    return run !== undefined ? [{ ...e, sessionId: runIds[run] }] : [];
  });
}

