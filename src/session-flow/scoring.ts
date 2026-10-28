/**
 * Judging a finished agent session with team scorers (#1178), on the judge, evidence and label store `src/scorers/`
 * keeps for every subject. The session is read redacted and goes only to the local judge; only its labels are published.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { observedModel } from '../agent-observation.js';
import { knownSecrets } from '../env-resolution.js';
import { loadModelAliases } from '../models/aliases.js';
import { AttemptStore, newAttemptId, scoresDir } from '../scorers/attempts.js';
import { batchesScorers, verdictsOf, type Verdict } from '../scorers/batch.js';
import { cachedScorerNames, NOT_A_SCORER, pinScorers, scorerSourceHash } from '../scorers/cache.js';
import { formatScorerDiagnostic, isScorerFile, parseScorer, type ScorerDefinition, type ScorerLabel } from '../scorers/definition.js';
import { answerSchema, evidenceDirOf, type Rubrics } from '../scorers/evidence.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scorerIsolationSource, type RequiredIsolation } from '../scorers/isolation.js';
import { scopeScoring } from '../scorers/settings.js';
import { installedJudgeTools, runLocalJudge, type LocalJudgeResult } from '../scorers/judge.js';
import type { JudgeTool } from '../tool-launch/tools.js';
import { chooseJudgeModel, type JudgeModelChoice } from '../scorers/judge-model.js';
import type { ScoreLabel, SessionSubject } from '../scorers/label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from '../scorers/label-store.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { readFileSafe } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { redact } from '../utils/redact.js';
import { sessionJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { agentSessionFromEnv } from '../utils/session-id.js';
import { AgentSession } from './agent-session.js';
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import type { SubagentsRead } from './adapters/base.js';
import { SessionCaptures } from './captures.js';
import { safeText, sessionArchives } from './session-cmd-shared.js';
import { scrubSession } from './scrub.js';
import { getRepoIdentity, SyncManager } from './sync.js';
import { firstPromptOnly, judgeSession, sessionLabel, writeSessionEvidence, type JudgedSession } from './session-work.js';
import type { Session } from './ir.js';

type Failure = Extract<WorkflowEnvelope, { error: unknown }>;

function failure(code: string, message: string): Failure {
  return { error: { code, message } };
}

/** The judge a driver offers for a session: the `score --next` payload's `driver`, its `can.judge`, and `running`. */
export type OwnJudge = Pick<JudgeRequest, 'driver' | 'judge' | 'running'>;

/** `teamai score --team-session <name> [--author <member>]`: a session as `teamai session list` names it. */
export interface TeamSession {
  name: string;
  author?: string;
}

/**
 * What `teamai score [--session <id> [--source <platform>] | --team-session <name>] --scorer <name>… [--batch] [--push]
 * [--json <driver>]` asks for: a session of a tool on this machine, or one a member pushed to the team archive.
 */
export type SessionDemand = {
  /** Cached scorers by name, or scorer files (`isScorerFile`) relative to the current directory, whose labels are only tried. */
  scorers: readonly [string, ...string[]];
  batch?: boolean;
  /** Publish the scope's pending labels after scoring, as `teamai score --push` does. */
  push?: boolean;
  /** A value of the one scorer, given by hand: stored as the member's label, and no judge runs. */
  label?: string;
  /** Lease the session to this driver's own judge instead of judging it here. */
  ownJudge?: OwnJudge;
} & (
  | { teamSession: TeamSession; session?: never; source?: never }
  | { teamSession?: never; session?: string; source?: string }
);

interface Asked {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  /** The scorer file it was read from, relative to the current directory: its label is tried and never stored. */
  file?: string;
  /** The scorer's `model` when it is an alias, also when the tool default judges in its place. */
  alias?: string;
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
interface NamedSession {
  platform: string;
  found: { session: Session; subagents?: SubagentsRead };
  config: LocalConfig;
  pushedBy?: string;
}

/** The session of a tool on this machine that `--session`, or the agent session variable, names. */
async function nativeSession(from: LocalConfig, demand: SessionDemand): Promise<NamedSession | Failure> {
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
async function pushedSession(config: LocalConfig, { name, author }: TeamSession): Promise<NamedSession | Failure> {
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
    try {
      ({ session } = archive.loadSession(repoIdentity, name, entry.author));
    } catch (e) {
      return failure('session_not_found', `The pushed session ${name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!session.platform || !session.sessionId) return failure('session_not_found', `The pushed session ${name} records no platform or session id it ran as, so it cannot be scored.`);
    return { platform: session.platform, found: { session: scrubSession(session).session }, config, pushedBy: entry.author };
  }
  return failure('session_not_found', `No session ${name} is pushed for ${repoIdentity ?? 'this directory'}. Run teamai session list to see the pushed sessions, after teamai session pull for the newest.`);
}

/** One scorer file the command tries: the labels stored for its scorer, and the control's verdict or why it has none. */
interface Tried {
  scorer: string;
  stored: Array<Record<string, unknown>>;
  control: Record<string, unknown>;
}

/** Why a rubric that passes the control may not judge the work. Printed, never a failure: a rubric may judge the prompt by design. */
const CONTROL_WARNING = 'This rubric passes a session where the agent did nothing, so it may not judge the work.';

type JudgeChoice = Extract<JudgeModelChoice<JudgeTool>, { ok: true }>['choice'];

/**
 * One judge call of `members` on `judged`, its evidence written for it and removed after it: each member's verdict and
 * what the judge reported, or the failure, with the judge's raw output saved when it gave one.
 */
async function judgeOnce(config: LocalConfig, judged: JudgedSession, members: readonly [Asked, ...Asked[]], choice: JudgeChoice, required: RequiredIsolation): Promise<
  | { ok: true; verdicts: Array<Verdict & { judged: Asked }>; judge: Extract<LocalJudgeResult, { ok: true }>['judge'] }
  | { ok: false; envelope: Failure }
> {
  const [head, ...tail] = members;
  const rubrics: Rubrics = [head.definition, ...tail.map((member) => member.definition)];
  const attempt = newAttemptId();
  const evidence = evidenceDirOf(scoresDir(config), attempt);
  try {
    await writeSessionEvidence(evidence, judged, rubrics);
    const result = await runLocalJudge({ tool: choice.tool, model: choice.model, evidence, schema: answerSchema(rubrics), isolation: required.level });
    const verdicts = result.ok ? verdictsOf(members, (member) => member.definition, result.answer) : undefined;
    if (result.ok && verdicts?.ok) return { ok: true, verdicts: verdicts.verdicts, judge: result.judge };
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
      : failure(result.code, result.message + (result.code === 'judge_tool_unavailable' && required.level === 'verified' ? ` ${required.setBy.join(' and ')} asks for verified.` : '') + saved) };
  } finally {
    await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The newest label this scope keeps of `scorer` on `subject` for each rubric and judge kind, newest first. */
function storedOf(labels: readonly ScoreLabel[], scorer: string, subject: SessionSubject): Array<Record<string, unknown>> {
  return labels
    .filter((label) => label.source === 'session' && label.scorer === scorer && label.subject.platform === subject.platform && label.subject.sessionId === subject.sessionId)
    .sort((left, right) => (left.scoredAt < right.scoredAt ? 1 : left.scoredAt > right.scoredAt ? -1 : 0))
    .map(({ rubric, label, score, passed, judge }) => ({ rubric, label, score, passed, judge: judge.kind === 'model' ? { kind: judge.kind, tool: judge.tool } : { kind: judge.kind } }));
}

/**
 * Judges one finished session with the named scorers, whatever their sampling says, and keeps one label per scorer on
 * this machine, in the scope the session ran in, whichever scope `from` is. Scorers that resolve to the same tool and
 * model share one judge call with `--batch`, or when the team's `scorers/scoring.yaml` sets `batch`. A scorer file's
 * label is tried and never kept: it is printed next to the stored labels of its scorer and the control's verdict.
 */
export async function scoreSession(from: LocalConfig, demand: SessionDemand, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  if (demand.ownJudge) {
    const file = demand.scorers.find(isScorerFile);
    if (file !== undefined) return failure('invalid_arguments', `A lease judges cached scorers, and ${file} is a scorer file. Leave out --json to try it here.`);
    if (new Set(demand.scorers).size > 1 && !demand.batch) return failure('invalid_arguments', 'A lease judges one scorer, or several in one judge call. Pass one --scorer, or add --batch.');
    if (demand.push) return failure('invalid_arguments', 'A lease\'s label is published when its answer is submitted. Leave out --push.');
    if (demand.teamSession) return failure('invalid_arguments', 'A lease\'s judge reads the session from a tool on this machine, and --team-session names a pushed one. Leave out --json to judge it here.');
  }
  if (demand.label !== undefined) {
    const [scorer, ...more] = new Set(demand.scorers);
    if (more.length > 0) return failure('invalid_arguments', '--label is a value of one scorer. Pass one --scorer.');
    if (scorer !== undefined && isScorerFile(scorer)) {
      return failure('invalid_arguments', `--label is stored, and the label of the scorer file ${scorer} is never stored. Pass the name of a scorer teamai pull cached.`);
    }
    if (demand.batch || demand.ownJudge) return failure('invalid_arguments', '--label runs no judge. Leave out --batch and --json.');
  }
  const files = new Map<string, Asked>();
  for (const value of new Set(demand.scorers)) {
    if (!isScorerFile(value)) continue;
    const read = await scorerFile(value);
    if ('error' in read) return read;
    files.set(value, read);
  }
  const named = demand.teamSession ? await pushedSession(from, demand.teamSession) : await nativeSession(from, demand);
  if ('error' in named) return named;
  const { platform, found, config, pushedBy } = named;
  const { session } = found;
  const unavailable = scoringUnavailable(config);
  if (unavailable) return failure('scoring_unavailable', unavailable);
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return failure('scoring_settings_invalid', scoring.reason);
  const pins = await pinScorers(config, demand.scorers.filter((value) => !files.has(value)));
  const asked: Asked[] = [];
  for (const value of new Set(demand.scorers)) {
    const file = files.get(value);
    const pin = pins[value];
    const definition = pin && pinnedDefinition(value, pin);
    const candidate = file ?? (pin && definition ? { scorer: value, pin, definition } : undefined);
    if (!candidate) {
      const known = await cachedScorerNames(config);
      return failure('scorer_not_found', `Scorer ${value} is not cached here. ${known.length > 0 ? `Scorers: ${known.join(', ')}.` : 'Run teamai pull to cache the team\'s scorers.'}`);
    }
    const twin = asked.find((other) => other.scorer === candidate.scorer);
    if (twin) {
      return failure('invalid_arguments', `--scorer ${twin.file ?? twin.scorer} and --scorer ${candidate.file ?? candidate.scorer} are both scorer ${candidate.scorer}. Judge them in separate commands: a file's output lists the labels stored for its scorer.`);
    }
    asked.push(candidate);
  }
  if (demand.ownJudge) {
    const subject = { platform, sessionId: session.sessionId };
    return sessionJudgeLease(config, { ...demand.ownJudge, entries: { source: 'session', subject, scorers: asked, batch: demand.batch === true } }, now);
  }
  const byHand = demand.label === undefined ? undefined : handValueOf(asked, demand.label);
  if (byHand && 'error' in byHand) return byHand;
  log.info(safeText(`${byHand ? 'Labelling' : 'Scoring'} ${platform} session ${session.sessionId} in ${session.cwd || '(directory unknown)'}`));
  if (pushedBy !== undefined) log.info(`Pushed by ${safeText(pushedBy)}`);
  const envSecrets = await knownSecrets(config);
  const mask = (text: string): string => redact(text, { envSecrets });
  const captures = pushedBy === undefined ? await SessionCaptures.read(config, platform, session.sessionId) : [];
  const judged = judgeSession({ platform, found, captures, mask });
  const { subject, context: { prompt, used } } = judged;
  log.info(`First prompt: ${safeText(prompt) || '(none)'}`);
  if (byHand) {
    const labelled = await labelByHand(config, { ...byHand, judged, now });
    return 'error' in labelled ? labelled : answered(config, labelled, demand.push);
  }

  const tools = installedJudgeTools([]);
  if (tools.length === 0) {
    return failure('judge_tool_unavailable', 'No installed tool can run a scorer judge with every tool turned off. Install a supported version of Claude Code, Codex or OpenCode.');
  }
  const aliases = await loadModelAliases(config);
  const batch = demand.batch || batchesScorers({ team: scoring.batch });
  const groups: Array<{ choice: JudgeChoice; members: [Asked, ...Asked[]] }> = [];
  for (const member of asked) {
    const chosen = chooseJudgeModel(aliases, member.definition, tools);
    if (!chosen.ok) return failure('judge_model_unavailable', chosen.message);
    if (chosen.note) log.info(chosen.note);
    const judged = { ...member, ...(chosen.choice.alias !== undefined ? { alias: chosen.choice.alias } : {}) };
    const group = batch ? groups.find(({ choice }) => choice.tool === chosen.choice.tool && choice.model?.name === chosen.choice.model?.name && choice.model?.effort === chosen.choice.model?.effort) : undefined;
    if (group) group.members.push(judged);
    else groups.push({ choice: chosen.choice, members: [judged] });
  }
  const control = files.size > 0 ? judgeSession({ platform, found: firstPromptOnly(found), captures: [], mask }) : undefined;
  const answers: Array<Record<string, unknown>> = [];
  const tried: Tried[] = [];
  for (const { choice, members } of groups) {
    const required = requiredIsolation([...scoring.isolation, ...members.map(({ scorer, pin, definition }) => ({ source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }))]);
    const result = await judgeOnce(config, judged, members, choice, required);
    if (!result.ok) return result.envelope;
    const labels = result.verdicts.map(({ judged: member, label, passed, reasoning }) => {
      const model = observedModel({ ...result.judge.model, alias: member.alias });
      return { member, reasoning, label: sessionLabel({
        scorer: member.scorer,
        rubric: { sourceHash: member.pin.sourceHash, ...(member.pin.teamRevision ? { teamRevision: member.pin.teamRevision } : {}) },
        label: label.value,
        score: label.score,
        passed,
        judge: { kind: 'model', ...result.judge, ...(model ? { model } : {}), ...(members.length > 1 ? { batched: true as const } : {}) },
        scoredAt: now,
      }, subject, judged.context) };
    });
    const write = async () => {
      const outcomes: Array<(typeof labels)[number] & ({ kind: 'stored'; kept: { id: string; version: string } } | { kind: 'tried'; file: string })> = [];
      for (const one of labels) {
        const { file } = one.member;
        outcomes.push(file === undefined ? { ...one, kind: 'stored', kept: await LabelStore.append(config, one.label, one.reasoning, prompt) } : { ...one, kind: 'tried', file });
      }
      return outcomes;
    };
    // Only a cached scorer's label is written, so a group of scorer files never waits on the label store's lock.
    const written = labels.some(({ member }) => member.file === undefined) ? await AttemptStore.locked(config, write) : { status: 'done' as const, value: await write() };
    if (written.status === 'busy') return failure('busy', 'Another teamai process holds the label store, so no label was written. Score the session again.');
    const [fileHead, ...fileTail] = members.filter((member) => member.file !== undefined);
    // After the labels are kept, so a control that fails loses none of them.
    const controlled = control && fileHead ? await judgeOnce(config, control, [fileHead, ...fileTail], choice, required) : undefined;
    const storedLabels = fileHead ? await LabelStore.local(config) : [];
    for (const outcome of written.value) {
      const { member, label } = outcome;
      const verdict = `${label.label} (score ${label.score}, ${label.passed ? 'passed' : 'did not pass'})`;
      const answer = { scorer: label.scorer, subject, label: label.label, score: label.score, passed: label.passed, ...(used.skills.length > 0 ? { used } : {}) };
      if (outcome.kind === 'stored') {
        const file = reasoningPath(config, outcome.kept.version);
        log.info(`${label.scorer}: ${verdict}. Reasoning: ${file}`);
        if (!label.passed) log.info(shareFailedLabelHint(file, session.sessionId));
        answers.push({ ...answer, labelId: outcome.kept.id, reasoning: file });
        continue;
      }
      log.info(`${label.scorer} from ${outcome.file}: ${verdict}. Not stored: a scorer file's label is only tried.`);
      answers.push({ ...answer, file: outcome.file, rubric: label.rubric, reasoning: outcome.reasoning, stored: false });
      const controlVerdict = controlled?.ok ? controlled.verdicts.find(({ judged: one }) => one === member) : undefined;
      if (controlled && !controlled.ok) log.warn(`${label.scorer}: the control could not be judged: ${controlled.envelope.error.message}`);
      if (controlVerdict?.passed) log.warn(`${label.scorer}: ${CONTROL_WARNING}`);
      tried.push({
        scorer: label.scorer,
        stored: storedOf(storedLabels, label.scorer, subject),
        control: controlVerdict
          ? { label: controlVerdict.label.value, score: controlVerdict.label.score, passed: controlVerdict.passed, ...(controlVerdict.passed ? { warning: CONTROL_WARNING } : {}) }
          : { error: controlled && !controlled.ok ? controlled.envelope.error : { code: 'judge_failed', message: 'The judge gave the control no label.' } },
      });
    }
  }
  const [only, ...more] = answers;
  const [firstTried] = tried;
  const scored = only && more.length === 0
    ? { label: only, ...(firstTried ? { stored: firstTried.stored, control: firstTried.control } : {}) }
    : { labels: answers, ...(firstTried ? { stored: Object.fromEntries(tried.map(({ scorer, stored }) => [scorer, stored])), control: Object.fromEntries(tried.map(({ scorer, control }) => [scorer, control])) } : {}) };
  return answered(config, scored, demand.push);
}

/** The answer of a scoring, after publishing the scope's pending labels with `push`. */
async function answered(config: LocalConfig, scored: Record<string, unknown>, push: boolean | undefined): Promise<WorkflowEnvelope> {
  if (!push) return { data: scored };
  const pushed = await LabelStore.push(config);
  return 'data' in pushed ? { data: { ...scored, ...pushed.data } } : pushed;
}

/** The label `value` of the one scorer `asked` names, as `--label` gives it, or why it is not one of its labels. */
function handValueOf([member]: readonly Asked[], value: string): { member: Asked; given: ScorerLabel } | Failure {
  if (!member) return failure('invalid_arguments', 'Pass --scorer <name> with --label: the scorer the value is a label of.');
  const given = member.definition.labels.find((candidate) => candidate.value === value);
  if (given) return { member, given };
  return failure('label_invalid', `"${value}" is not a label of scorer ${member.scorer}. Use one of: ${member.definition.labels.map((candidate) => candidate.value).join(', ')}.`);
}

/**
 * Keeps the member's own label of `judged` with `value`, its score and verdict as the scorer gives them, as a model
 * label is kept but with no judge and no reasoning file. It shares no key with a model label, so neither replaces the other.
 */
async function labelByHand(config: LocalConfig, { member, given, judged, now }: { member: Asked; given: ScorerLabel; judged: JudgedSession; now: string }): Promise<{ label: Record<string, unknown> } | Failure> {
  const { scorer, pin, definition } = member;
  const passed = given.score >= definition.passingScore;
  const label = sessionLabel({
    scorer,
    rubric: { sourceHash: pin.sourceHash, ...(pin.teamRevision ? { teamRevision: pin.teamRevision } : {}) },
    label: given.value,
    score: given.score,
    passed,
    judge: { kind: 'human' },
    scoredAt: now,
  }, judged.subject, judged.context);
  const written = await AttemptStore.locked(config, () => LabelStore.append(config, label, undefined));
  if (written.status === 'busy') return failure('busy', 'Another teamai process holds the label store, so no label was written. Label the session again.');
  log.info(`${scorer}: ${given.value} (score ${given.score}, ${passed ? 'passed' : 'did not pass'}), by hand. No judge ran.`);
  return { label: { scorer, subject: judged.subject, label: given.value, score: given.score, passed, judge: { kind: 'human' }, labelId: written.value.id } };
}
