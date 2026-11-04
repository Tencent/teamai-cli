/**
 * Judging a finished agent session with team scorers (#1178), on the judge, evidence and label store `src/scorers/`
 * keeps for every subject. The session is read redacted and goes only to the local judge; only its labels are published.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentObservation } from '../agent-observation.js';
import { knownSecrets } from '../env-resolution.js';
import { loadModelAliases } from '../models/aliases.js';
import { scoresDir } from '../scorers/home.js';
import { batchesScorers, verdictsOf, type Verdict } from '../scorers/batch.js';
import { NOT_A_SCORER, scorerSourceHash } from '../scorers/cache.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition } from '../scorers/definition.js';
import { answerSchema, evidenceDirOf, type Rubrics } from '../scorers/evidence.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scorerIsolationSource, type RequiredIsolation } from '../scorers/isolation.js';
import { scopeScoring } from '../scorers/settings.js';
import { runLocalJudge } from '../scorers/judge.js';
import { installedConfinedTools } from '../tool-launch/confined.js';
import { CONFINED_TOOLS } from '../tool-launch/tools.js';
import type { ConfinedTool } from '../tool-launch/tools.js';
import { chooseJudgeModel, type JudgeModelChoice } from '../scorers/judge-model.js';
import type { ScoreLabel, SessionLabelContext, SessionSubject } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { redact } from '../utils/redact.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { agentSessionFromEnv } from '../utils/session-id.js';
import { AgentSession } from './agent-session.js';
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import type { SubagentsRead } from './adapters/base.js';
import { SessionCaptures } from './captures.js';
import { safeText, sessionArchives } from './session-cmd-shared.js';
import { scrubSession } from './scrub.js';
import { getRepoIdentity, SyncManager, type SessionSyncMeta } from './sync.js';
import { firstPromptOnly, judgeSession, writeSessionEvidence, type JudgedSession } from './session-work.js';
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

interface Asked {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  /** The scorer file it was read from, relative to the current directory: its label is tried and never stored. */
  file: string;
}

/** The scorer file `value` names, relative to the current directory, read and parsed as `teamai pull` parses it. */
async function scorerFile(value: string): Promise<Asked | Failure> {
  const full = path.resolve(value);
  const file = path.relative(process.cwd(), full).split(path.sep).join('/');

  if (!file.endsWith('.md') || path.posix.basename(file) === 'README.md') return failure('scorer_invalid', formatScorerDiagnostic({ file, message: NOT_A_SCORER }));
  const content = await readFileSafe(full);

  if (content === null) return failure('scorer_not_found', formatScorerDiagnostic({ file, message: 'could not be read' }));
  const parsed = parseScorer(file, content);

  if (!parsed.ok) return failure('scorer_invalid', parsed.diagnostics.map(formatScorerDiagnostic).join('\n'));

  return { scorer: parsed.definition.name, file, definition: parsed.definition, pin: { sourceHash: scorerSourceHash(content), relativePath: file, content } };
}

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

/** The control's verdict on a scorer file, or why it has none. */
type ControlOutcome = { label: string; score: number; passed: boolean; warning?: string } | { error: { code: string; message: string } };

/** One scorer file the command tries: its verdict, the labels stored for its scorer, and the control's verdict. */
interface TriedAnswer {
  scorer: string;
  file: string;
  subject: SessionSubject;
  rubric: { sourceHash: string };
  label: string;
  score: number;
  passed: boolean;
  reasoning: string;
  stored: false;
  /** The team skills the session used, when it used any. */
  used?: SessionLabelContext['used'];
}

/** Why a rubric that passes the control may not judge the work. Printed, never a failure: a rubric may judge the prompt by design. */
const CONTROL_WARNING = 'This rubric passes a session where the agent did nothing, so it may not judge the work.';

type JudgeChoice = Extract<JudgeModelChoice<ConfinedTool>, { ok: true }>['choice'];

/**
 * One judge call of `members` on `judged`, its evidence written for it and removed after it: each member's verdict, or
 * the failure, with the judge's raw output saved when it gave one.
 */
async function judgeOnce(config: LocalConfig, judged: JudgedSession, members: readonly [Asked, ...Asked[]], choice: JudgeChoice, required: RequiredIsolation): Promise<
  | { ok: true; verdicts: Array<Verdict & { judged: Asked }> }
  | { ok: false; envelope: Failure }
> {
  const [head, ...tail] = members;
  const rubrics: Rubrics = [head.definition, ...tail.map((member) => member.definition)];
  const attempt = `a${randomBytes(4).toString('hex')}`;
  const evidence = evidenceDirOf(scoresDir(config), attempt);

  try {
    await writeSessionEvidence(evidence, judged, rubrics);
    const result = await runLocalJudge({ tool: choice.tool, model: choice.model, evidence, schema: answerSchema(rubrics), isolation: required.level });
    const verdicts = result.ok ? verdictsOf(members, (member) => member.definition, result.answer) : undefined;

    if (result.ok && verdicts?.ok) return { ok: true, verdicts: verdicts.verdicts };
    const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
    let saved = '';

    if (raw !== undefined) {
      const file = path.join(scoresDir(config), 'raw', `${attempt}.txt`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, raw, { mode: 0o600 });
      saved = ` Output saved to ${file}.`;
    }

    return { ok: false, envelope: result.ok
      ? failure('judge_answer_invalid', `The judge's answer names no label of the scorer: ${verdicts && !verdicts.ok ? verdicts.message : ''} No label was written.${saved}`)
      // oxlint-disable-next-line teamai/workflow-failure-codes -- forwards a code from a classified workflow or scorer producer
      : failure(result.code, result.message + (result.code === 'judge_tool_unavailable' && required.level === 'verified' ? ` ${required.setBy.join(' and ')} asks for verified.` : '') + saved) };
  } finally {
    await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The newest label this scope keeps of `scorer` on `subject` for each rubric and judge kind, newest first. */
function storedOf(labels: readonly ScoreLabel[], scorer: string, subject: SessionSubject) {
  return labels
    .filter((label) => label.source === 'session' && label.scorer === scorer && label.subject.platform === subject.platform && label.subject.sessionId === subject.sessionId)
    .sort((left, right) => (left.scoredAt < right.scoredAt ? 1 : left.scoredAt > right.scoredAt ? -1 : 0))
    .map(({ rubric, label, score, passed, judge }) => ({ rubric, label, score, passed, judge: judge.kind === 'model' ? { kind: judge.kind, tool: judge.tool } : { kind: judge.kind } }));
}

/** What the control's call gave `member`. */
function controlOf(controlled: Awaited<ReturnType<typeof judgeOnce>>, member: Asked): ControlOutcome {
  const verdict = controlled.ok ? controlled.verdicts.find(({ judged }) => judged === member) : undefined;

  if (!verdict) return { error: controlled.ok ? { code: 'judge_failed', message: 'The judge gave the control no label.' } : controlled.envelope.error };
  const outcome = { label: verdict.label.value, score: verdict.label.score, passed: verdict.passed };

  return verdict.passed ? { ...outcome, warning: CONTROL_WARNING } : outcome;
}

/** The scorer files `values` name, read once each, or why they cannot be tried together. */
async function scorerFiles(values: readonly string[]): Promise<Asked[] | Failure> {
  const asked: Asked[] = [];

  for (const value of new Set(values)) {
    const read = await scorerFile(value);

    if ('error' in read) return read;
    const twin = asked.find((other) => other.scorer === read.scorer);

    if (twin) return failure('invalid_arguments', `--scorer ${twin.file} and --scorer ${read.file} are both scorer ${read.scorer}. Judge them in separate commands.`);
    asked.push(read);
  }

  return asked;
}

type JudgeGroup = { choice: JudgeChoice; members: [Asked, ...Asked[]] };

/** One judge call per file, or with `batch` one per tool and model the files resolve to. */
function judgeGroups(asked: readonly Asked[], aliases: Awaited<ReturnType<typeof loadModelAliases>>, tools: readonly ConfinedTool[], batch: boolean): JudgeGroup[] | Failure {
  const groups: JudgeGroup[] = [];

  for (const member of asked) {
    const chosen = chooseJudgeModel(aliases, member.definition, tools);

    if (!chosen.ok) return failure('judge_model_unavailable', chosen.message);

    if (chosen.note) log.info(chosen.note);
    const { tool, model } = chosen.choice;
    const group = batch ? groups.find(({ choice }) => choice.tool === tool && choice.model?.name === model?.name && choice.model?.effort === model?.effort) : undefined;

    if (group) group.members.push(member);
    else groups.push({ choice: chosen.choice, members: [member] });
  }

  return groups;
}

type Tried = { answer: TriedAnswer; stored: ReturnType<typeof storedOf>; control: ControlOutcome };

/** Judges `group` on the session and on its control, and prints each file's verdict. */
async function tryGroup(config: LocalConfig, sessions: { judged: JudgedSession; control: JudgedSession }, group: JudgeGroup, required: RequiredIsolation, storedLabels: readonly ScoreLabel[]): Promise<Tried[] | Failure> {
  const { choice, members } = group;
  const { subject, context: { used } } = sessions.judged;
  const result = await judgeOnce(config, sessions.judged, members, choice, required);

  if (!result.ok) return result.envelope;
  const controlled = await judgeOnce(config, sessions.control, members, choice, required);

  return result.verdicts.map(({ judged: member, label, passed, reasoning }) => {
    const answer: TriedAnswer = {
      scorer: member.scorer, file: member.file, subject, rubric: { sourceHash: member.pin.sourceHash },
      label: label.value, score: label.score, passed, reasoning, stored: false,
    };

    if (used.skills.length > 0) answer.used = used;
    log.info(`${member.scorer} from ${member.file}: ${label.value} (score ${label.score}, ${passed ? 'passed' : 'did not pass'}). Not stored: a scorer file's label is only tried.`);

    if (!controlled.ok) log.warn(`${member.scorer}: the control could not be judged: ${controlled.envelope.error.message}`);
    const memberControl = controlOf(controlled, member);

    if ('warning' in memberControl) log.warn(`${member.scorer}: ${CONTROL_WARNING}`);

    return { answer, stored: storedOf(storedLabels, member.scorer, subject), control: memberControl };
  });
}

/** The command's answer: one file's label, stored labels and control, or each of them by scorer. */
function triedEnvelope(tried: readonly Tried[]): WorkflowEnvelope {
  const [only, ...more] = tried;

  if (only && more.length === 0) return { data: { label: only.answer, stored: only.stored, control: only.control } };

  return { data: {
    labels: tried.map(({ answer }) => answer),
    stored: Object.fromEntries(tried.map(({ answer, stored }) => [answer.scorer, stored])),
    control: Object.fromEntries(tried.map(({ answer, control }) => [answer.scorer, control])),
  } };
}

/**
 * Tries scorer files on one finished session, whatever their sampling says, and stores no label: each file's label is
 * printed next to the labels this scope keeps of its scorer and the control's verdict, a judge call on the session's
 * first prompt alone. Files that resolve to the same tool and model share one judge call with `--batch`, or when the
 * team's `scorers/scoring.yaml` sets `batch`. The session is read in the scope it ran in, whichever scope `from` is.
 */
export async function scoreSession(from: LocalConfig, demand: SessionDemand): Promise<WorkflowEnvelope> {
  const asked = await scorerFiles(demand.scorers);

  if ('error' in asked) return asked;
  const named = demand.teamSession ? await pushedSession(from, demand.teamSession) : await nativeSession(from, demand);

  if ('error' in named) return named;
  const { platform, found, config, pushedBy, agent } = named;
  const { session } = found;
  const unavailable = scoringUnavailable(config);

  if (unavailable) return failure('scoring_unavailable', unavailable);
  const scoring = await scopeScoring(config);

  if (!scoring.ok) return failure('scoring_settings_invalid', scoring.reason);
  log.info(safeText(`Scoring ${platform} session ${session.sessionId} in ${session.cwd || '(directory unknown)'}`));

  if (pushedBy !== undefined) log.info(`Pushed by ${safeText(pushedBy)}`);
  const envSecrets = await knownSecrets(config);
  const mask = (text: string): string => redact(text, { envSecrets });
  const captures = pushedBy === undefined ? await SessionCaptures.read(config, platform, session.sessionId) : [];
  const judged = judgeSession({ platform, found, captures, mask, agent });
  log.info(`First prompt: ${safeText(judged.context.prompt) || '(none)'}`);

  const tools = installedConfinedTools([]);

  if (tools.length === 0) {
    return failure('judge_tool_unavailable', `No installed tool can run a scorer judge with every tool turned off. Install one teamai runs confined: ${CONFINED_TOOLS.join(', ')}.`);
  }

  const groups = judgeGroups(asked, await loadModelAliases(config), tools, demand.batch || batchesScorers({ team: scoring.batch }));

  if ('error' in groups) return groups;
  const sessions = { judged, control: judgeSession({ platform, found: firstPromptOnly(found), captures, mask }) };
  const storedLabels = await LabelStore.local(config);
  const tried: Tried[] = [];

  for (const group of groups) {
    const required = requiredIsolation([...scoring.isolation, ...group.members.map(({ scorer, pin, definition }) => ({ source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }))]);
    const outcomes = await tryGroup(config, sessions, group, required, storedLabels);

    if ('error' in outcomes) return outcomes;
    tried.push(...outcomes);
  }

  return triedEnvelope(tried);
}
