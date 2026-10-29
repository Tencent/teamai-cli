/** Archive finished captured sessions according to sessions.publish. Successful scrubbed publications are recorded once; failures remain retryable. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../launch-context.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { sessionKey } from './agent-session.js';
import { pushSession, type ArchiveSessionRef } from './archive.js';
import { SessionCaptures } from './captures.js';
import { finished } from './completion.js';

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
  for (const { platform, sessionId } of await finished(await SessionCaptures.list(config), now, (of) => of === mode)) {
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

export const SessionPublish = { captured, isRecorded } as const;
