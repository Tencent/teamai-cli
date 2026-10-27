/**
 * The Session sharing panel (#1385): for one workspace, whether its sessions are published and scored in each run
 * mode and why, and what waits for a drain. Policy names, setting names and counts only: never a transcript, a
 * prompt, a judge's reasoning or a native path.
 */
import { loadTeamConfig } from '../config.js';
import { explainRunMode, RUN_MODE_ENV, RUN_MODES, type ExplainedRunMode, type RunMode } from '../launch-context.js';
import { scoringUnavailable } from '../scorers/home.js';
import { LabelStore } from '../scorers/label-store.js';
import { scopeScoring } from '../scorers/settings.js';
import { AgentSession, sessionKey } from '../session-flow/agent-session.js';
import { SessionCaptures } from '../session-flow/captures.js';
import { sessionArchiveRoot } from '../session-flow/session-cmd-shared.js';
import { SessionPolicy, type SessionPolicies } from '../session-flow/session-policy.js';
import { SessionPublish } from '../session-flow/session-publish.js';
import { SessionWork } from '../session-flow/session-work.js';
import { isAgentExcluded, scopedToolPaths, type LocalConfig } from '../types.js';

/** The sessions of one run mode that a drain or the background pass has finished, by what became of them. */
type Settled = { finished: number; waitingToArchive: number; archived: number };

/** The sessions captured on this machine in each run mode, by state. */
export type CapturedSessions = { attended: Settled & { active: number }; unattended: Settled & { waitingForDrain: number } };

export type SessionSharing =
  | { configured: false }
  | {
    configured: true;
    /** The run mode this dashboard's environment launches, and what set it. */
    runMode: ExplainedRunMode;
    /** Where this scope archives published sessions: teamai-reports, or nowhere on an HTTP team. */
    archive: 'teamai-reports' | 'none';
    publish: SessionPolicies;
    /** Scoring as this scope resolves it, with the scorers that set `sessions: true`; unavailable when it cannot score. */
    scoring: { state: 'ok'; policies: SessionPolicies; dailyLimit: number; scorers: string[] } | { state: 'unavailable'; reason: string };
    /** Each problem of the session settings, as `teamai doctor` prints it. */
    problems: string[];
    /** The enabled tools teamai reads no sessions from: their sessions are never captured, published or judged. */
    unreadTools: string[];
    captured: CapturedSessions;
    /** The step sessions of the runs that ended here in each run mode that wait to be archived: none while `publish` is not `auto` for it. */
    stepSessionsWaitingToArchive: Record<RunMode, number>;
    /** Labels judged here that a drain publishes to teamai-reports. */
    pendingLabels: number;
    /** The drain to run for what waits: one per run mode whose sessions wait for it, else this machine's for pending labels. */
    next: Array<{ mode: RunMode; command: string }>;
  };

type Configured = Extract<SessionSharing, { configured: true }>;

/**
 * Each session captured here by run mode (a capture with no mode counts as attended) and state: an attended one is
 * active until it is finished, an unattended one waits for a drain until one reaches it; a finished one waits to be
 * archived while `publish` is `auto` for its mode. One whose file is gone and that was not archived is left out.
 */
async function capturedHere(config: LocalConfig, now: string, publish: SessionPolicies): Promise<CapturedSessions> {
  const sessions = await SessionCaptures.list(config);
  const finished = new Set((await SessionWork.finished(sessions, now, () => true)).map(sessionKey));
  const counts: CapturedSessions = {
    attended: { active: 0, finished: 0, waitingToArchive: 0, archived: 0 },
    unattended: { waitingForDrain: 0, finished: 0, waitingToArchive: 0, archived: 0 },
  };
  for (const one of sessions) {
    const mode = SessionCaptures.runModeOf(one.captures) ?? 'attended';
    if (await SessionPublish.isRecorded(config, one)) {
      counts[mode].archived += 1;
      continue;
    }
    if (await SessionWork.isGone(one)) continue;
    if (finished.has(sessionKey(one))) {
      if (publish[mode].policy === 'auto') counts[mode].waitingToArchive += 1;
      else counts[mode].finished += 1;
      continue;
    }
    switch (mode) {
      case 'attended':
        counts.attended.active += 1;
        break;
      case 'unattended':
        if (one.drained) counts.unattended.finished += 1;
        else counts.unattended.waitingForDrain += 1;
        break;
      default: {
        const unhandled: never = mode;
        return unhandled;
      }
    }
  }
  return counts;
}

/** The step sessions of the runs that ended here in each run mode that a drain in that mode archives. */
async function stepsWaitingToArchive(config: LocalConfig, publish: SessionPolicies): Promise<Record<RunMode, number>> {
  const waiting = async (mode: RunMode) => (publish[mode].policy === 'auto' ? SessionPublish.waitingSteps(config, mode) : 0);
  const [attended, unattended] = await Promise.all([waiting('attended'), waiting('unattended')]);
  return { attended, unattended };
}

/**
 * A drain finishes and publishes the sessions of its own run mode only, while any drain publishes pending labels. So
 * each mode with sessions that a drain would act on gets its drain, run in that mode, and pending labels alone get
 * this machine's. Another mode is set as the shell of `platform` sets a variable: PowerShell on Windows.
 */
function nextSteps(
  { runMode, archive, publish, scoring, captured, stepSessionsWaitingToArchive, pendingLabels }: Omit<Configured, 'configured' | 'problems' | 'unreadTools' | 'next'>,
  platform: NodeJS.Platform,
): Configured['next'] {
  const acts = (mode: RunMode) => publish[mode].policy === 'auto'
    || (scoring.state === 'ok' && scoring.policies[mode].policy === 'auto' && scoring.scorers.length > 0);
  const waits: Record<RunMode, boolean> = {
    attended: captured.attended.waitingToArchive > 0 || stepSessionsWaitingToArchive.attended > 0,
    unattended: captured.unattended.waitingToArchive > 0 || stepSessionsWaitingToArchive.unattended > 0 || (captured.unattended.waitingForDrain > 0 && acts('unattended')),
  };
  const modes = RUN_MODES.filter((mode) => waits[mode]);
  if (modes.length === 0 && pendingLabels > 0 && archive === 'teamai-reports') modes.push(runMode.mode);
  const inMode = (mode: RunMode) => (platform === 'win32' ? `$env:${RUN_MODE_ENV}='${mode}'; teamai score --drain` : `${RUN_MODE_ENV}=${mode} teamai score --drain`);
  // PowerShell keeps a variable a command sets for the rest of the session, so once one command sets the mode, each does.
  const setsEach = platform === 'win32' && modes.some((mode) => mode !== runMode.mode);
  return modes.map((mode) => ({ mode, command: mode === runMode.mode && !setsEach ? 'teamai score --drain' : inMode(mode) }));
}

/** What the panel shows for `config`, read with `env` as this machine's environment and `platform` as its OS, at `now`. */
export async function readSessionSharing(config: LocalConfig, { env, platform, now }: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; now: string }): Promise<SessionSharing> {
  const unavailable = scoringUnavailable(config);
  const [team, scored] = await Promise.all([
    loadTeamConfig(config.repo.localPath),
    unavailable === undefined ? scopeScoring(config) : { ok: false as const, reason: unavailable },
  ]);
  const publish = SessionPolicy.publish(config, team);
  const [scorers, captured, stepSessionsWaitingToArchive, pendingLabels] = await Promise.all([
    scored.ok ? SessionWork.sessionScorers(config) : [],
    capturedHere(config, now, publish.policies),
    stepsWaitingToArchive(config, publish.policies),
    LabelStore.unpublished(config),
  ]);
  const read = {
    runMode: explainRunMode(env),
    archive: sessionArchiveRoot(config) ? 'teamai-reports' : 'none',
    publish: publish.policies,
    scoring: scored.ok
      ? { state: 'ok', policies: scored.sessions.policies, dailyLimit: scored.sessions.dailyLimit, scorers: scorers.map(({ scorer }) => scorer).sort() }
      : { state: 'unavailable', reason: scored.reason },
    captured,
    stepSessionsWaitingToArchive,
    pendingLabels,
  } satisfies Omit<Configured, 'configured' | 'problems' | 'unreadTools' | 'next'>;
  return {
    configured: true,
    ...read,
    problems: [...publish.problems, ...(scored.ok ? scored.problems : [])].map((problem) => `${problem}.`),
    unreadTools: team ? AgentSession.toolsWithoutSessions(Object.keys(scopedToolPaths(team, config)).filter((tool) => !isAgentExcluded(config, tool))).sort() : [],
    next: nextSteps(read, platform),
  };
}
