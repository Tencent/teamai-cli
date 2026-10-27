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
import { runPasses } from '../workflow/loop.js';
import { localRuns, settledHere } from '../workflow/scoring.js';
import { installOwner } from '../workflow/store.js';
import { AgentSession, recordedToolRoots, type ToolRootsLookup } from './agent-session.js';
import { archiveSessions, pushSession, type ArchiveSessionRef } from './archive.js';
import { SessionCaptures } from './captures.js';
import { SessionWork } from './session-work.js';

/** What one publish pass archived, and what it could not, by why. */
export interface SessionsPublished {
  archived: number;
  unpublished: Array<{ sessions: number; reason: string }>;
}

/** A session by the platform teamai reads it from, or, when teamai reads no sessions from its tool, by that tool. */
type PublishedKey = ArchiveSessionRef | { tool: string; sessionId: string };

/** What a data home did with a session, once: archived it, or skipped it for a reason that will not change here. */
type PublicationRecord = PublishedKey & ({ publishedAt: string } | { skippedAt: string; reason: string });

/** The file that records what this data home did with `key`: its name hashes the platform, or the tool, and the id. */
function recordFile(config: LocalConfig, key: PublishedKey): string {
  const of = 'platform' in key ? `${key.platform}\0${key.sessionId}` : `tool\0${key.tool}\0${key.sessionId}`;
  const name = createHash('sha256').update(of).digest('hex').slice(0, 32);
  return path.join(getDataHome(config), 'sessions', 'published', `${name}.json`);
}

/** Whether this data home archived `key`, or recorded it as one it can never archive from here. */
async function isRecorded(config: LocalConfig, key: PublishedKey): Promise<boolean> {
  return fs.stat(recordFile(config, key)).then(() => true, () => false);
}

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
        await record(config, { ...ref, publishedAt: now });
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
async function unarchivable(key: PublishedKey, toolRootsFor: ToolRootsLookup): Promise<string | undefined> {
  if (!('platform' in key)) return `teamai reads no sessions from ${key.tool}`;
  const found = await AgentSession.find(key, { scrub: false, toolRootsFor });
  if (found.status === 'done') return undefined;
  return `the ${key.platform} session ${key.sessionId} cannot be read here: ${found.failure.message.replace(/\.$/, '')}`;
}

/**
 * Archives the step sessions of each run of this data home that ended in `mode` (a run with no mode counts as
 * attended): of each pass settled here that names its tool and session, the session, unless this data home recorded it
 * already. A session this machine cannot read is recorded as skipped, and the readable ones of its run are still
 * archived. One push per run, filed under the repository of the checkout the run started in.
 */
async function steps(config: LocalConfig, mode: RunMode, now: string): Promise<StepSessionsPublished[]> {
  const install = (await installOwner(config)).id;
  const published: StepSessionsPublished[] = [];
  for (const run of await localRuns(config)) {
    if (run.status === 'running' || (run.runMode ?? 'attended') !== mode) continue;
    const checkout = run.checkout ?? SessionWork.leaseCwd(config);
    const toolRoots = recordedToolRoots(checkout);
    const refs = new Map<string, ArchiveSessionRef>();
    const skipped: StepSessionsPublished['skipped'] = [];
    for (const pass of runPasses(run)) {
      if (pass.tool === undefined || pass.session === undefined || !settledHere(run, pass, install)) continue;
      const platform = AgentSession.platformForTool(pass.tool);
      const key: PublishedKey = platform ? { platform, sessionId: pass.session } : { tool: pass.tool, sessionId: pass.session };
      if (await isRecorded(config, key)) continue;
      const reason = await unarchivable(key, () => toolRoots);
      if (reason !== undefined) {
        skipped.push({ step: pass.step, pass: pass.pass, reason });
        await record(config, { ...key, skippedAt: now, reason });
      } else if ('platform' in key) refs.set(`${key.platform}\0${key.sessionId}`, key);
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
    for (const { platform, sessionId } of delivered.archived) await record(config, { platform, sessionId, publishedAt: now });
    published.push({ run: run.id, archived: delivered.archived.length, skipped });
  }
  return published;
}

export const SessionPublish = { captured, steps, isRecorded } as const;
