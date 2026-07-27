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
import { pushRepoDirectly, pullRepo } from './utils/git.js';
import { readEvents } from './dashboard-collector.js';
import {
  collectSession,
  appendMonthlyLog,
  pruneMonthlyLogs,
  monthKey,
} from './session-collector.js';
import { log, spinner } from './utils/logger.js';
import { withTimeout } from './utils/async.js';
import { SESSION_LOGS_LOCAL_DIR } from './types.js';
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
    options.sessionId || process.env.CLAUDE_SESSION_ID || mostRecentSessionId(events);
  if (!sessionId) {
    log.error('Could not determine a session id. Pass --session-id <id>.');
    return;
  }

  const summary = collectSession(sessionId, events);
  if (!summary) {
    log.error(`No events found for session ${sessionId}.`);
    return;
  }

  // Always write the local monthly log.
  if (options.dryRun) {
    log.info(
      `[dry-run] Would record session ${sessionId.slice(0, 8)} ` +
        `(${summary.toolTotal} tools, ${summary.interventionCount} interventions, ` +
        `valuable=${summary.valuable}) to ${SESSION_LOGS_LOCAL_DIR}/${monthKey(summary)}.md`,
    );
  } else {
    // Local logs live on the user's own machine, so keep the redacted prompt line.
    const written = await appendMonthlyLog(SESSION_LOGS_LOCAL_DIR, summary, { includePrompt: true });
    if (written) {
      log.info(`Recorded session to ${written}`);
    } else {
      log.info(`Session ${sessionId.slice(0, 8)} already recorded this month.`);
    }
    await pruneMonthlyLogs(SESSION_LOGS_LOCAL_DIR, new Date()).catch(() => []);
  }

  if (!options.push) return;

  // ── Team push (opt-in) ─────────────────────────────────
  if (!summary.valuable && !options.force) {
    log.info('Session not flagged as valuable (no interventions, few tools) — skipping team push. Use --force to override.');
    return;
  }

  let localConfig: LocalConfig;
  try {
    if (options.scope === 'project') {
      const cfg = await loadLocalConfigForScope('project', process.cwd());
      if (!cfg) {
        log.error('No project-level teamai config in the current directory.');
        return;
      }
      localConfig = cfg;
    } else if (options.scope === 'user') {
      localConfig = (await requireInit()).localConfig;
    } else {
      const projectConfig = await detectProjectConfig();
      localConfig = projectConfig ?? (await requireInit()).localConfig;
    }
  } catch (e) {
    log.error(`Cannot push: ${(e as Error).message}`);
    log.info('The local log was still saved.');
    return;
  }
  try {
    assertNotReadOnly(localConfig, 'teamai session save --push');
  } catch (e) {
    log.error((e as Error).message);
    log.info('The local log was still saved.');
    return;
  }

  const repoPath = localConfig.repo.localPath;
  const username = localConfig.username;
  const teamDir = path.join(repoPath, 'sessions', username);

  if (options.dryRun) {
    log.info(`[dry-run] Would push session summary to sessions/${username}/${monthKey(summary)}.md`);
    return;
  }

  const spin = spinner('Pushing session summary to team...').start();
  try {
    try {
      await pullRepo(repoPath);
    } catch {
      log.debug('session save: pull failed, continuing with local state');
    }

    // Team upload defaults to counts + tools only; the redacted prompt line is
    // opt-in via --include-prompt, since redact() is best-effort.
    const written = await appendMonthlyLog(teamDir, summary, { includePrompt: options.includePrompt });
    if (!written) {
      spin.info('Session already present in the team log — nothing to push.');
      return;
    }
    const rel = path.relative(repoPath, written);
    const commitMsg = `[teamai] Session summary from ${username} (${monthKey(summary)})`;

    await withTimeout(pushRepoDirectly(repoPath, commitMsg, [rel]), 10_000, 'Push timeout (10s)');

    spin.succeed(`Pushed: ${rel}`);
  } catch (e) {
    spin.fail(`Team push failed: ${(e as Error).message}`);
    log.info('The local log was still saved. Retry later with: teamai session save --push');
  }
}
