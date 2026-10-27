/**
 * Sessions published under `sessions.publish` `auto` (#1385): the captured sessions of a run mode once they are
 * finished, each archived once, scrubbed, on teamai-reports. A data home records each session it archived, so a later
 * pass skips it; a push that failed records nothing, and the next pass tries it again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { pushSession, type ArchiveSessionRef } from './archive.js';
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

export const SessionPublish = { captured } as const;
