/**
 * Sessions published under `sessions.publish` `auto` (#1385): the captured sessions of a run mode once they are
 * finished, and the step sessions of the runs driven here in that mode once they ended, each archived once, scrubbed,
 * on teamai-reports. A data home records each session it archived, and each step session it can never archive from
 * here, so a later pass skips it; a push that failed records nothing, and the next pass tries it again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { runPasses, type RunPass } from '../workflow/loop.js';
import { localRuns, settledHere } from '../workflow/scoring.js';
import { installOwner } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { AgentSession, recordedToolRoots, sessionKey, type ToolRootsLookup } from './agent-session.js';
import { archiveSessions, pushSession, type ArchiveSessionRef } from './archive.js';
import { SessionCaptures } from './captures.js';
import { SessionWork } from './session-work.js';

/** What one publish pass archived, and what it could not, by why. */
export interface SessionsPublished {
  archived: number;
  unpublished: Array<{ sessions: number; reason: string }>;
}

/** A session by the platform teamai reads it from, or, when teamai reads no sessions from its tool, by that tool. */
type PublishedKey = { kind: 'platform'; platform: string; sessionId: string } | { kind: 'tool'; tool: string; sessionId: string };

const platformKey = ({ platform, sessionId }: ArchiveSessionRef): PublishedKey => ({ kind: 'platform', platform, sessionId });

/** What a data home did with a session, once: archived it, or skipped it for a reason that will not change here. */
type PublicationRecord = PublishedKey & ({ publishedAt: string } | { skippedAt: string; reason: string });

/** The file that records what this data home did with `key`: its name hashes the platform, or the tool, and the id. */
function recordFile(config: LocalConfig, key: PublishedKey): string {
  const name = createHash('sha256').update(recordName(key)).digest('hex').slice(0, 32);
  return path.join(getDataHome(config), 'sessions', 'published', `${name}.json`);
}

function recordName(key: PublishedKey): string {
  switch (key.kind) {
    case 'platform':
      return sessionKey(key);
    case 'tool':
      return `tool\0${key.tool}\0${key.sessionId}`;
    default: {
      const unhandled: never = key;
      return unhandled;
    }
  }
}

/** Whether this data home archived `key`, or recorded it as one it can never archive from here. */
async function hasRecord(config: LocalConfig, key: PublishedKey): Promise<boolean> {
  return fs.stat(recordFile(config, key)).then(() => true, () => false);
}

/** Whether this data home archived session `ref`. */
const isRecorded = (config: LocalConfig, ref: ArchiveSessionRef): Promise<boolean> => hasRecord(config, platformKey(ref));

async function record(config: LocalConfig, entry: PublicationRecord): Promise<void> {
  const file = recordFile(config, entry);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/** Counts one more session that failed for `reason` in `unpublished`, one entry per reason. */
function addUnpublished(unpublished: SessionsPublished['unpublished'], reason: string): void {
  const same = unpublished.find((entry) => entry.reason === reason);
  if (same) same.sessions += 1;
  else unpublished.push({ sessions: 1, reason });
}

/** Archives each session captured here in `mode` that is finished at `now` and not archived from here yet. */
async function captured(config: LocalConfig, mode: RunMode, now: string): Promise<SessionsPublished> {
  const published: SessionsPublished = { archived: 0, unpublished: [] };
  for (const { platform, sessionId } of await SessionWork.finished(await SessionCaptures.list(config), now, (of) => of === mode)) {
    const ref = { platform, sessionId };
    if (await isRecorded(config, ref)) continue;
    const pushed = await pushSession(config, ref);
    switch (pushed.status) {
      case 'archived':
        await record(config, { ...platformKey(ref), publishedAt: now });
        published.archived += 1;
        break;
      case 'busy':
      case 'failed':
        addUnpublished(published.unpublished, pushed.message);
        break;
      default: {
        const unhandled: never = pushed;
        return unhandled;
      }
    }
  }
  return published;
}

/** What one publish pass did with the step sessions of one run. */
export interface StepSessionsPublished {
  run: string;
  archived: number;
  /** The passes whose session cannot be archived from here, and why. Each is recorded, so no later pass lists it again. */
  skipped: Array<{ step: string; pass: number; reason: string }>;
  unpublished?: { sessions: number; reason: string };
}

/** Why step session `key` can never be archived from this machine, or undefined when this machine reads it. */
async function unarchivableReason(key: PublishedKey, toolRootsFor: ToolRootsLookup): Promise<string | undefined> {
  switch (key.kind) {
    case 'tool':
      return `teamai reads no sessions from ${key.tool}`;
    case 'platform': {
      const found = await AgentSession.find({ platform: key.platform, sessionId: key.sessionId }, { scrub: false, toolRootsFor });
      if (found.status === 'done') return undefined;
      return `the ${key.platform} session ${key.sessionId} cannot be read here: ${found.failure.message.replace(/\.$/, '')}`;
    }
    default: {
      const unhandled: never = key;
      return unhandled;
    }
  }
}

type UnrecordedPass = { pass: RunPass; key: PublishedKey };

/**
 * Each run of this data home that ended in `mode` (a run with no mode counts as attended), with the step sessions a
 * publish pass has yet to archive or skip: of each pass settled here that names its tool and session, the session,
 * unless this data home recorded it already.
 */
async function unrecordedSteps(config: LocalConfig, mode: RunMode): Promise<Array<{ run: RunState; passes: UnrecordedPass[] }>> {
  const ended = (await localRuns(config)).filter((run) => run.status !== 'running' && (run.runMode ?? 'attended') === mode);
  if (ended.length === 0) return [];
  const install = (await installOwner(config)).id;
  const runs: Array<{ run: RunState; passes: UnrecordedPass[] }> = [];
  for (const run of ended) {
    const passes: UnrecordedPass[] = [];
    for (const pass of runPasses(run)) {
      if (pass.tool === undefined || pass.session === undefined || !settledHere(run, pass, install)) continue;
      const platform = AgentSession.platformForTool(pass.tool);
      const key: PublishedKey = platform ? { kind: 'platform', platform, sessionId: pass.session } : { kind: 'tool', tool: pass.tool, sessionId: pass.session };
      if (!await hasRecord(config, key)) passes.push({ pass, key });
    }
    runs.push({ run, passes });
  }
  return runs;
}

/** How many step sessions of the runs that ended in `mode` the next publish pass in that mode archives or skips. */
async function waitingSteps(config: LocalConfig, mode: RunMode): Promise<number> {
  return (await unrecordedSteps(config, mode)).reduce((sum, { passes }) => sum + passes.length, 0);
}

/**
 * Archives the step sessions of each run of this data home that ended in `mode` and that it has not recorded yet. A
 * session this machine cannot read is recorded as skipped, and the readable ones of its run are still archived. One
 * push per run, filed under the repository of the checkout the run started in.
 */
async function steps(config: LocalConfig, mode: RunMode, now: string): Promise<StepSessionsPublished[]> {
  const published: StepSessionsPublished[] = [];
  for (const { run, passes } of await unrecordedSteps(config, mode)) {
    const checkout = run.checkout ?? SessionWork.leaseCwd(config);
    const toolRoots = recordedToolRoots(checkout);
    const refs = new Map<string, ArchiveSessionRef>();
    const skipped: StepSessionsPublished['skipped'] = [];
    for (const { pass, key } of passes) {
      const reason = await unarchivableReason(key, () => toolRoots);
      if (reason !== undefined) {
        skipped.push({ step: pass.step, pass: pass.pass, reason });
        await record(config, { ...key, skippedAt: now, reason });
      } else if (key.kind === 'platform') refs.set(sessionKey(key), { platform: key.platform, sessionId: key.sessionId });
    }
    if (refs.size === 0) {
      if (skipped.length > 0) published.push({ run: run.id, archived: 0, skipped });
      continue;
    }
    const delivered = await archiveSessions(config, [...refs.values()].map((ref) => [ref]), { run: run.id, checkout });
    if (delivered.status === 'failed') {
      published.push({ run: run.id, archived: 0, skipped, unpublished: { sessions: refs.size, reason: delivered.message } });
      continue;
    }
    for (const ref of delivered.archived) await record(config, { ...platformKey(ref), publishedAt: now });
    published.push({ run: run.id, archived: delivered.archived.length, skipped });
  }
  return published;
}

export const SessionPublish = { captured, steps, waitingSteps, isRecorded } as const;
