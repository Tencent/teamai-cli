import fs from 'node:fs/promises';
import type { RunMode } from '../launch-context.js';
import { AgentSession, sessionKey } from './agent-session.js';
import { SessionCaptures, type CapturedSession } from './captures.js';


/** Nothing happened in an attended session for this long: it is finished, and judge work. */
export const FINISHED_AFTER_MS = 6 * 60 * 60 * 1000;


/** The latest dashboard event of each session, by platform and session id. */
async function lastEvents(): Promise<Map<string, string>> {
  const { readEvents } = await import('../dashboard-collector.js');
  const latest = new Map<string, string>();
  for (const event of await readEvents()) {
    const platform = AgentSession.platformForTool(event.tool);
    if (!platform) continue;
    const key = sessionKey({ platform, sessionId: event.sessionId });
    if ((latest.get(key) ?? '') < event.timestamp) latest.set(key, event.timestamp);
  }
  return latest;
}


/**
 * When something last happened in `captured`: its latest dashboard event, its session file's last write, or its latest
 * start or resume. Undefined once a file its hooks named is gone, since its session cannot be read any more.
 */
async function lastActiveAt(captured: CapturedSession, events: ReadonlyMap<string, string>): Promise<number | undefined> {
  const files = [...new Set(captured.captures.flatMap((capture) => capture.sessionFile ?? []))];
  const written = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.mtimeMs, () => undefined)));
  const known = written.filter((at): at is number => at !== undefined);
  if (known.length < files.length) return undefined;
  const event = events.get(sessionKey(captured));
  return Math.max(...known, ...(event ? [Date.parse(event)] : []), ...captured.captures.map((capture) => Date.parse(capture.capturedAt)));
}


/**
 * The sessions of `captured` finished at `now`, oldest activity first, of the run modes `includes` keeps (a capture with
 * no mode counts as attended): an attended session once nothing happened in it for six hours, an unattended one once a
 * drain reached it (#1385). A session whose file is gone is never finished.
 */
async function finished(captured: readonly CapturedSession[], now: string, includes: (mode: RunMode) => boolean): Promise<CapturedSession[]> {
  const events = await lastEvents();
  const found: Array<{ captured: CapturedSession; activeAt: number }> = [];
  for (const one of captured) {
    const mode = SessionCaptures.runModeOf(one.captures) ?? 'attended';
    if (!includes(mode)) continue;
    const activeAt = await lastActiveAt(one, events);
    if (activeAt === undefined) continue;
    switch (mode) {
      case 'attended':
        if (activeAt + FINISHED_AFTER_MS <= Date.parse(now)) found.push({ captured: one, activeAt });
        break;
      case 'unattended':
        if (one.drained) found.push({ captured: one, activeAt });
        break;
      default: {
        const unhandled: never = mode;
        return unhandled;
      }
    }
  }
  return found.sort((left, right) => left.activeAt - right.activeAt).map((one) => one.captured);
}

export { finished };
