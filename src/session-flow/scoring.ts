/**
 * The finished agent session a scoring names (#1178): one of a tool on this machine, or one a member pushed to the team
 * archive, read redacted, in the scope its labels are kept in. teamai-score judges it; only its labels are published.
 */
import type { AgentObservation } from '../agent-observation.js';
import type { LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { agentSessionFromEnv } from '../utils/session-id.js';
import { AgentSession } from './agent-session.js';
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import type { SubagentsRead } from './adapters/base.js';
import { SessionCaptures } from './captures.js';
import { safeText, sessionArchives } from './session-cmd-shared.js';
import { scrubSession } from './scrub.js';
import { getRepoIdentity, SyncManager, type SessionSyncMeta } from './sync.js';
import type { Session } from './ir.js';

type Failure = Extract<WorkflowEnvelope, { error: unknown }>;

function failure(code: string, message: string): Failure {
  return { error: { code, message } };
}

/** `teamai score --team-session <name> [--author <member>]`: a session as `teamai session list` names it. */
export interface TeamSession {
  name: string;
  author?: string;
}

/**
 * What `teamai score [--session <id> [--source <platform>] | --team-session <name>] --scorer <name>… [--batch] [--push]`
 * asks for: a session of a tool on this machine, or one a member pushed to the team archive.
 */
export type SessionDemand = {
  /** Cached scorers by name, or scorer files (`isScorerFile`) relative to the current directory, whose labels are only tried. */
  scorers: readonly [string, ...string[]];
  batch?: boolean;
  /** Publish the scope's pending labels after scoring, as `teamai score --push` does. */
  push?: boolean;
  /** A value of the one scorer, given by hand: stored as the member's label, and no judge runs. */
  label?: string;
} & (
  | { teamSession: TeamSession; session?: never; source?: never }
  | { teamSession?: never; session?: string; source?: string }
);

async function sessionOf(config: LocalConfig, demand: SessionDemand): Promise<{ platform: string; sessionId: string } | Failure> {
  const env = await agentSessionFromEnv();
  const current = env.unambiguous && env.id ? { sessionId: env.id, platform: env.agent && AgentSession.platformForTool(env.agent) } : undefined;
  const sessionId = demand.session ?? current?.sessionId;

  if (sessionId === undefined) return { error: { code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' } };
  const captured = await SessionCaptures.platformsOf(config, sessionId);
  const platform = demand.source ?? (current?.sessionId === sessionId ? current.platform : undefined) ?? (captured.length === 1 ? captured[0] : undefined);

  if (platform !== undefined) return { platform, sessionId };
  const holding: string[] = [];

  for (const candidate of listInstalledPlatforms()) {
    if ((await AgentSession.find({ platform: candidate, sessionId }, { scrub: false })).status === 'done') holding.push(candidate);
  }

  return { error: { code: 'source_required', message: holding.length > 0
    ? `Pass --source with --session ${sessionId}: the platform that holds it. Found in: ${holding.join(', ')}.`
    : `No installed tool holds session ${sessionId}. Pass --source <platform> to read it from one of: ${listAvailablePlatforms().join(', ')}.` } };
}

/**
 * The config of the scope a session ran in, found from its directory as the hooks that captured it found it, else
 * `config`, with its workspace children, whose namespaces it receives too.
 */
async function scopeOf(config: LocalConfig, platform: string, session: Session): Promise<LocalConfig> {
  if (!session.cwd) return config;
  const { resolveHookConfig } = await import('../dashboard-collector.js');
  const resolved = await resolveHookConfig({ cwd: session.cwd, session_id: session.sessionId }, AgentSession.toolForPlatform(platform));

  return resolved ? readWorkspaceChildren(resolved) : config;
}

/**
 * The session a scoring names, read redacted, and the scope its labels are kept in. A pushed one names the member who
 * pushed it, and has no captures here.
 */
export interface NamedSession {
  platform: string;
  found: { session: Session; subagents?: SubagentsRead };
  config: LocalConfig;
  pushedBy?: string;
  /** What a pushed session ran as, as its archive records it. */
  agent?: AgentObservation;
}

/** The session of a tool on this machine that `--session`, or the agent session variable, names. */
export async function nativeSession(from: LocalConfig, demand: SessionDemand): Promise<NamedSession | Failure> {
  const named = await sessionOf(from, demand);

  if ('error' in named) return named;
  const { platform, sessionId } = named;
  const found = await AgentSession.find({ platform, sessionId }, { subagents: true });

  if (found.status !== 'done') return failure('session_not_found', found.failure.message);
  const { session } = found;

  if (session.sessionId !== sessionId) {
    const ids = (await AgentSession.list({ platforms: [platform], archived: true })).sessions.map((listed) => listed.sessionId).filter((id) => id.endsWith(sessionId)).sort();

    if (ids.length > 1) return failure('session_ambiguous', `--session ${sessionId} names more than one ${platform} session: ${ids.join(', ')}. Pass the whole id of one.`);
  }

  return { platform, found, config: await scopeOf(from, platform, session) };
}

/**
 * The session pushed to the team archive as `name`, for this directory's repository, where `teamai session resume` looks
 * for it: on teamai-reports, else in the archive a git-kind team kept on its default branch before. Where resume takes
 * the first member who pushed that name, this fails unless `author` picks one of those who pushed it to the first archive
 * that holds the name. Its subject is its origin, so its labels pair with those of the same session scored where it ran.
 * It is redacted as `AgentSession.find` redacts a session.
 */
export async function pushedSession(config: LocalConfig, { name, author }: TeamSession): Promise<NamedSession | Failure> {
  let archives: Awaited<ReturnType<typeof sessionArchives>>;

  try {
    archives = await sessionArchives(config, { dryRun: false, read: true });
  } catch (e) {
    return failure('reports_unreachable', `teamai-reports, where pushed sessions are kept, could not be read (${e instanceof Error ? e.message : String(e)}). Check the connection and run the command again.`);
  }

  if (!archives) return failure('unsupported_repo', 'This team keeps no session archive here, so it has no pushed session to score. Score a session on this machine with --session <id>.');
  const repoIdentity = getRepoIdentity(process.cwd());
  const kept = [{ root: archives.root, where: 'teamai-reports' }, ...(archives.legacy ? [{ root: archives.legacy, where: 'the default branch' }] : [])];

  for (const { root, where } of kept) {
    const archive = new SyncManager(root);
    const named = archive.listSessions(repoIdentity).filter((entry) => entry.sessionName === name);

    if (named.length === 0) continue;
    const held = author === undefined ? named : named.filter((entry) => entry.author === author);
    const [entry, ...others] = held;

    if (!entry) {
      return failure('session_not_found', `--team-session ${name} on ${where} names sessions pushed by ${named.map((one) => safeText(one.author)).join(', ')}, not by ${safeText(author ?? '')}, and a name found there is read only there. Pass --author with one of them.`);
    }

    if (others.length > 0) {
      return failure('session_ambiguous', `--team-session ${name} names sessions pushed by ${held.map((one) => safeText(one.author)).join(', ')}. Pass --author with one of them.`);
    }

    let session: Session;
    let meta: SessionSyncMeta;

    try {
      ({ session, meta } = archive.loadSession(repoIdentity, name, entry.author));
    } catch (e) {
      return failure('session_not_found', `The pushed session ${name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!session.platform || !session.sessionId) return failure('session_not_found', `The pushed session ${name} records no platform or session id it ran as, so it cannot be scored.`);

    const pushed: NamedSession = { platform: session.platform, found: { session: scrubSession(session).session }, config, pushedBy: entry.author };

    if (meta.agent) pushed.agent = meta.agent;

    return pushed;
  }

  return failure('session_not_found', `No session ${name} is pushed for ${repoIdentity ?? 'this directory'}. Run teamai session list to see the pushed sessions, after teamai session pull for the newest.`);
}
