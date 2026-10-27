/**
 * Sessions published under `sessions.publish` `auto` (#1385): the captured sessions of a run mode once they are
 * finished, and the step sessions of the runs driven here in that mode once they ended, each archived once, scrubbed,
 * on teamai-reports. A data home records each session it archived, so a later pass skips it; a push that failed
 * records nothing, and the next pass tries it again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { runPasses } from '../workflow/loop.js';
import { localRuns, settledHere } from '../workflow/scoring.js';
import { installOwner } from '../workflow/store.js';
import { AgentSession } from './agent-session.js';
import { archiveSessions, pushSession, type ArchiveSessionRef } from './archive.js';
import { SessionCaptures } from './captures.js';
import { SessionWork } from './session-work.js';

/** What one publish pass archived, and what it could not, by why. */
export interface SessionsPublished {
  archived: number;
  unpublished: Array<{ sessions: number; reason: string }>;
}

/** The file that records `ref` as archived from this data home: its name hashes the platform and the id. */
function recordFile(config: LocalConfig, ref: ArchiveSessionRef): string {
  const name = createHash('sha256').update(`${ref.platform}\0${ref.sessionId}`).digest('hex').slice(0, 32);
  return path.join(getDataHome(config), 'sessions', 'published', `${name}.json`);
}

async function isRecorded(config: LocalConfig, ref: ArchiveSessionRef): Promise<boolean> {
  return fs.stat(recordFile(config, ref)).then(() => true, () => false);
}

async function record(config: LocalConfig, ref: ArchiveSessionRef, now: string): Promise<void> {
  const file = recordFile(config, ref);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ platform: ref.platform, sessionId: ref.sessionId, publishedAt: now })}\n`, { mode: 0o600 });
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
        await record(config, ref, now);
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
  /** The passes whose tool teamai reads no sessions from. */
  skipped: Array<{ step: string; pass: number; tool: string }>;
  unpublished?: { sessions: number; reason: string };
}

/**
 * Archives the step sessions of each run of this data home that ended in `mode` (a run with no mode counts as
 * attended): of each pass settled here that names its tool and session, the session, unless it was archived from here
 * already. One push per run, filed under the repository of the checkout the run started in.
 */
async function steps(config: LocalConfig, mode: RunMode, now: string): Promise<StepSessionsPublished[]> {
  const install = (await installOwner(config)).id;
  const published: StepSessionsPublished[] = [];
  for (const run of await localRuns(config)) {
    if (run.status === 'running' || (run.runMode ?? 'attended') !== mode) continue;
    const refs = new Map<string, ArchiveSessionRef>();
    const skipped: StepSessionsPublished['skipped'] = [];
    for (const pass of runPasses(run)) {
      if (pass.tool === undefined || pass.session === undefined || !settledHere(run, pass, install)) continue;
      const platform = AgentSession.platformForTool(pass.tool);
      if (!platform) skipped.push({ step: pass.step, pass: pass.pass, tool: pass.tool });
      else if (!await isRecorded(config, { platform, sessionId: pass.session })) refs.set(`${platform}\0${pass.session}`, { platform, sessionId: pass.session });
    }
    if (refs.size === 0) {
      if (skipped.length > 0) published.push({ run: run.id, archived: 0, skipped });
      continue;
    }
    const chains = [...refs.values()].map((ref) => [ref]);
    const delivered = await archiveSessions(config, chains, { run: run.id, checkout: run.checkout ?? SessionWork.leaseCwd(config) });
    if (delivered.status === 'failed') {
      published.push({ run: run.id, archived: 0, skipped, unpublished: { sessions: refs.size, reason: delivered.message } });
      continue;
    }
    for (const ref of delivered.archived) await record(config, ref, now);
    published.push({ run: run.id, archived: delivered.archived.length, skipped });
  }
  return published;
}

export const SessionPublish = { captured, steps } as const;
