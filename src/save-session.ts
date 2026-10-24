/**
 * `teamai session save` — persist a privacy-scrubbed summary of a coding session
 * to a local monthly log, and optionally push it to the team repo so it shows up
 * in `teamai digest`'s "Session Highlights".
 *
 * Implements Features 1 & 5 from docs/designs/team-intelligence-platform.md,
 * reusing the dashboard's existing per-session event stream rather than a new
 * collection path. Team upload is opt-in (`--push`) and only carries counts,
 * tool names, and a redacted first-prompt line — consistent with TeamAI's
 * "counts only, no prompt text" posture.
 */

import path from 'node:path';
import {
  requireInit,
  detectProjectConfig,
  loadLocalConfigForScope,
} from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { readEvents } from './dashboard-collector.js';
import {
  collectSession,
  appendMonthlyLog,
  pruneMonthlyLogs,
  monthKey,
} from './session-collector.js';
import { log, spinner } from './utils/logger.js';
import { withTimeout } from './utils/async.js';
import { agentSessionIdFromEnv } from './utils/session-id.js';
import { getSessionLogsDir, parseInstallScope } from './types.js';
import type { GlobalOptions, LocalConfig } from './types.js';

export interface SaveSessionOptions extends GlobalOptions {
  sessionId?: string;
  /** Push the summary to the team repo (default: local only). */
  push?: boolean;
  /** Push even when the session isn't judged "valuable". */
  force?: boolean;
  /** Include the redacted first-prompt line in the pushed summary (default: off). */
  includePrompt?: boolean;
  scope?: string;
}

/** Pick the session id of the most recently active session in the event log. */
function mostRecentSessionId(events: { sessionId: string; timestamp: string }[]): string | undefined {
  let best: { sessionId: string; timestamp: string } | undefined;
  for (const e of events) {
    if (!best || e.timestamp > best.timestamp) best = e;
  }
  return best?.sessionId;
}

export async function saveSession(options: SaveSessionOptions): Promise<void> {
  const events = await readEvents();
  if (events.length === 0) {
    log.info('No local session data yet — nothing to save.');
    return;
  }

  const sessionId =
    options.sessionId || (await agentSessionIdFromEnv()) || mostRecentSessionId(events);
  if (!sessionId) {
    log.error('Could not determine a session id. Pass --session-id <id>.');
    process.exitCode = 1;
    return;
  }

  const summary = collectSession(sessionId, events);
  if (!summary) {
    log.error(`No events found for session ${sessionId}.`);
    process.exitCode = 1;
    return;
  }

  // Always write the local monthly log.
  if (options.dryRun) {
    log.info(
      `[dry-run] Would record session ${sessionId.slice(0, 8)} ` +
        `(${summary.toolTotal} tools, ${summary.interventionCount} interventions, ` +
        `valuable=${summary.valuable}) to ${getSessionLogsDir()}/${monthKey(summary)}.md`,
    );
  } else {
    // Local logs live on the user's own machine, so keep the redacted prompt line.
    const written = await appendMonthlyLog(getSessionLogsDir(), summary, { includePrompt: true });
    if (written) {
      log.info(`Recorded session to ${written}`);
    } else {
      log.info(`Session ${sessionId.slice(0, 8)} already recorded this month.`);
    }
    await pruneMonthlyLogs(getSessionLogsDir(), new Date()).catch(() => []);
  }

  if (!options.push) return;

  // ── Team push (opt-in) ─────────────────────────────────
  if (!summary.valuable && !options.force) {
    log.info('Session not flagged as valuable (no interventions, few tools) — skipping team push. Use --force to override.');
    return;
  }

  // The flag reaches the loaders: a bare load migrates the legacy role config
  // in place, which would write under --dry-run (#850).
  const loadOpts = { dryRun: options.dryRun };
  let localConfig: LocalConfig;
  try {
    const scope = options.scope === undefined ? undefined : parseInstallScope(options.scope);
    if (scope === 'project') {
      const cfg = await loadLocalConfigForScope('project', process.cwd(), loadOpts);
      if (!cfg) {
        log.error('No workspace teamai config in the current directory.');
        process.exitCode = 1;
        return;
      }
      localConfig = cfg;
    } else if (scope === 'user') {
      localConfig = (await requireInit(loadOpts)).localConfig;
    } else {
      const projectConfig = await detectProjectConfig(undefined, undefined, loadOpts);
      localConfig = projectConfig ?? (await requireInit(loadOpts)).localConfig;
    }
  } catch (e) {
    log.error(`Cannot push: ${(e as Error).message}`);
    log.info('The local log was still saved.');
    process.exitCode = 1;
    return;
  }
  try {
    assertNotReadOnly(localConfig, 'teamai session save --push');
  } catch (e) {
    log.error((e as Error).message);
    log.info('The local log was still saved.');
    process.exitCode = 1;
    return;
  }

  const username = localConfig.username;
  const commitMsg = `[teamai] Session summary from ${username} (${monthKey(summary)})`;

  if (options.dryRun) {
    log.info(`[dry-run] Would push session summary to sessions/${username}/${monthKey(summary)}.md`);
    return;
  }

  // Session summaries are report data → the teamai-reports orphan branch,
  // written through an isolated worktree so the default branch (and in self
  // mode, the user's active tree) is never touched.
  const spin = (await spinner('Pushing session summary to team...')).start();
  try {
    const { updateReports } = await import('./utils/reports-branch.js');
    const rel = path.join('sessions', username, `${monthKey(summary)}.md`);
    const result = await withTimeout(
      updateReports(localConfig, async (wt) => {
        await appendMonthlyLog(path.join(wt, 'sessions', username), summary, { includePrompt: options.includePrompt });
        // Named even when the summary was already there: an earlier attempt may have committed it and failed to push.
        return { files: [rel], message: commitMsg };
      }),
      10_000,
      'Push timeout (10s)',
    );
    switch (result.status) {
      case 'published':
        spin.succeed(`Pushed: ${rel}`);
        return;
      case 'already-present':
        spin.info('Session already present in the team log — nothing to push.');
        return;
      case 'busy':
        spin.fail('Team push failed: another teamai write holds the team reports branch, so the session summary was not pushed.');
        break;
      case 'failed':
        spin.fail(`Team push failed: ${result.reason}`);
        break;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled reports publish result: ${JSON.stringify(unhandled)}`);
      }
    }
  } catch (e) {
    spin.fail(`Team push failed: ${(e as Error).message}`);
  }
  log.info('The local log was still saved. Retry later with: teamai session save --push');
  process.exitCode = 1;
}
