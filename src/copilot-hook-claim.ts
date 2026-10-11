/**
 * A Copilot session can load several copies of a built-in: every user hook
 * file a project configured, and a project copy from before built-ins moved to
 * user scope. Which ones it loaded is not on disk, so the copies decide among
 * themselves per event: the first to claim the event runs it, the rest exit.
 *
 * Copilot passes one payload, with its millisecond `timestamp`, to every hook
 * of an event, and runs them in turn (read from Copilot CLI 0.0.411). The claim
 * key is that payload with the event, the matcher and Copilot's session ID, so
 * each copy of one event shares it and two events do not. A payload without a
 * timestamp may repeat across events, so it claims nothing and every copy runs.
 * Any failure to claim also runs the copy: a duplicate is better than a loss.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTeamaiHomeDir } from './types.js';

const CLAIMS_DIR = 'copilot-hook-claims';
/** Days of claims kept; an event's copies all run well within the first. */
const KEEP_DAYS = 2;

function claimDay(raw: string): string | null {
  let timestamp: unknown;
  try {
    timestamp = (JSON.parse(raw) as { timestamp?: unknown } | null)?.timestamp;
  } catch {
    return null;
  }
  if (typeof timestamp !== 'number' && (typeof timestamp !== 'string' || !timestamp)) return null;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/** Keeps `day` itself, so a payload clock behind ours keeps its claims. */
function removeOldClaims(root: string, day: string): void {
  const oldest = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  try {
    for (const name of fs.readdirSync(root)) {
      if (name < oldest && name !== day) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {
    // Best effort: stale claims only cost disk space.
  }
}

/** True when this copy runs the event: it claimed it, or no claim could be made. */
export function claimCopilotHookEvent(event: string, matcher: string, raw: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const day = claimDay(raw);
  if (!day) return true;
  const root = path.join(getTeamaiHomeDir(), CLAIMS_DIR);
  removeOldClaims(root, day);
  const key = createHash('sha256').update(JSON.stringify([env.COPILOT_AGENT_SESSION_ID ?? '', event, matcher, raw])).digest('hex');
  try {
    fs.mkdirSync(path.join(root, day), { recursive: true });
    fs.writeFileSync(path.join(root, day, key), '', { flag: 'wx' });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'EEXIST';
  }
}
