/**
 * A finished agent session as judge work (#1178, #1179). One redacted read gives the evidence of every judge call and
 * the context its labels carry. A session captured in a scope is judge work there once it is finished, for each scorer
 * that sets `sessions: true`: an attended one once nothing happened in it for the `idle` of teamai-finished-sessions, an unattended one once
 * `teamai score --drain` reached it. teamai-finished-sessions lists it and teamai-score judges it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentObservation } from '../agent-observation.js';
import { knownSecrets } from '../env-resolution.js';
import type { RunMode } from '../launch-context.js';
import { cachedScorerNames, pinScorers, scorerNamespaces } from '../scorers/cache.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import {
  fencedEvidence, keepEnds, rubricPrompt, writeEvidence, EVIDENCE_MAX_CHARS, TOOL_CALL_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import type { ScoreLabel, SessionLabel, SessionLabelContext, SessionSubject } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { Marks, type MarkFacts, type MarkKey } from '../scorers/marks.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import { isSampled } from '../scorers/sampling.js';
import { GeneratedQuestions, type QuestionSession, type QuestionSwitches } from '../scorers/generated-questions.js';
import { skillsEvidence, type SkillsEvidence } from '../scorers/skill-evidence.js';
import type { Subject } from '../scorers/subject.js';
import { typedIn, usedSkills } from '../skill-use.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { mapStrings, isJsonObject, JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { redact } from '@teamai/shared/redact';
import { AgentSession, sessionKey } from './agent-session.js';
import type { SubagentsRead } from '@teamai/tool-core/sessions/base';
import { SessionCaptures, type CapturedSession, type SessionCapture } from './captures.js';
import type { ArchivedEvidence, EvidenceFile } from './session-evidence.js';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { pushedSession, type TeamSession } from './scoring.js';

/** `value` with `mask` applied to each string in it, object keys included. */
function maskedArguments(value: JsonValue, mask: (text: string) => string): JsonValue {
  if (Array.isArray(value)) return value.map((item) => maskedArguments(item, mask));

  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskedArguments(item, mask)]));

  return mapStrings(value, mask);
}

/**
 * Each string of a tool call's arguments, keys included, is masked before they are serialized: a `"password": "…"` pair
 * or a known secret with a quote is escaped once serialized, and escaped again in the transcript, so masking the body misses it.
 */
function transcriptOf(session: Session, budget: number, mask: (text: string) => string): string {
  const capped: Session = {
    ...session,
    messages: session.messages.map((message) => ({ ...message, content: message.content.map((block) =>
      block.type === 'tool_call' ? { ...block, arguments: { excerpt: keepEnds(JSON.stringify(maskedArguments(JsonValueSchema.parse(block.arguments ?? {}), mask)), TOOL_CALL_MAX_CHARS) } } : block) })),
  };

  return keepEnds(AgentSession.transcript(capped).map((entry) => `### ${entry.role}\n${entry.text}\n${entry.toolOutput}`).join('\n\n'), budget);
}

/** A transcript a judge reads, and what of the session it could not read. */
export interface JudgedTranscript {
  body: string;
  gaps: EvidenceGap[];
}

/**
 * The directory a step confined to a directory works in, under its run's `$TEAMAI_RUN_DIR`: no other step works there.
 * A child agent the session started for such a step read only that directory, so its transcript is not the session's
 * work, and a judge of the session never reads it.
 */
const RUN_SCRATCH = /[\\/]runs[\\/]r[0-9a-f]{16}[\\/]scratch[\\/]/;

/** `found` without the subagents that worked a step confined to a directory of a workflow run. */
function ownWork<T extends { subagents?: SubagentsRead }>(found: T): T {
  if (found.subagents?.status !== 'read') return found;

  return { ...found, subagents: { ...found.subagents, agents: found.subagents.agents.filter((agent) => !RUN_SCRATCH.test(firstPrompt(agent.session))) } };
}

/**
 * A read session's transcript followed by each of its subagents', each kept to its budget, and what of them could not
 * be read. A subagent that worked a confined step is left out.
 */
export function judgedTranscript(
  found: { session: Session; subagents?: SubagentsRead },
  budget: { session: number; subagent: number },
  mask: (text: string) => string,
): JudgedTranscript {
  const gaps: EvidenceGap[] = [];
  const { session, subagents } = ownWork(found);
  let body = transcriptOf(session, budget.session, mask);

  if (subagents?.status !== 'read') gaps.push('subagents_unread');
  else for (const agent of subagents.agents) {
    if (agent.start === 'unknown') gaps.push('subagent_boundary_unknown');
    body += `\n\n## Subagent (depth ${agent.depth}${agent.finished === false ? ', not finished' : ''})\n\n${transcriptOf(agent.session, budget.subagent, mask)}`;
  }

  return { body, gaps };
}

/**
 * The team skills a session's checkout held as delivered at a message's time: those of the latest capture at or before
 * it. A message with no time takes the ones every capture records alike, else none.
 */
function capturedTeamSkillsAt(captures: readonly SessionCapture[]): (timestamp: string | undefined) => Readonly<Record<string, readonly string[]>> {
  const [first, ...rest] = captures;
  const alike = first !== undefined && rest.every((capture) => isDeepStrictEqual(capture.teamSkills ?? {}, first.teamSkills ?? {}));

  return (timestamp) => {
    const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);

    if (Number.isNaN(at)) return alike ? first.teamSkills ?? {} : {};
    const inEffect = captures.findLast((capture) => Date.parse(capture.capturedAt) <= at);

    return inEffect?.teamSkills ?? {};
  };
}

/** The first text the member typed in `session`, on one line, cut to 200 characters. */
export function firstPrompt(session: Session): string {
  const text = session.messages.flatMap((message) => message.content.map((block) => typedIn(message, block))).find((typed) => typed !== '') ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** A session read down to its first prompt, with no subagents. */
export interface PromptOnlyRead {
  session: Session;
  subagents: SubagentsRead;
}

/**
 * `found` with only its first prompt as the member typed it: no tool calls, no replies, no subagents. The control a
 * scorer file is tried on (#1399): a rubric that passes it may not judge the agent's work.
 */
export function firstPromptOnly(found: { session: Session }): PromptOnlyRead {
  const { session } = found;
  const first = session.messages.find((message) => message.content.some((block) => typedIn(message, block) !== ''));

  const typed = first?.content.flatMap((block) => {
    const text = typedIn(first, block);

    return text === '' ? [] : [{ type: 'text' as const, text }];
  });

  return { session: { ...session, messages: first && typed ? [{ ...first, content: typed }] : [] }, subagents: { status: 'read', agents: [] } };
}

/**
 * A file of the evidence the session's step left, as `evidence.json` lists it: a text file by its path in the evidence
 * directory, a listed one, whose content never left the machine that ran the step, by its path there.
 */
export type StepEvidenceListing = Omit<Extract<EvidenceFile, { kind: 'text' }>, 'text'> | Extract<EvidenceFile, { kind: 'listed' }>;

/** A session as one read gives it to a judge. In memory only: its body is the session's redacted text. */
export interface JudgedSession {
  subject: SessionSubject;
  /** The redacted transcript and its subagents', kept to the evidence cap with the evidence framing. */
  body: string;
  /** The text files of the evidence its step left, masked, by their path in the evidence directory. */
  stepEvidence: Array<{ path: string; text: string }>;
  manifest: { subject: SessionSubject; kind: 'session'; gaps: EvidenceGap[]; skills?: SkillsEvidence; evidence?: StepEvidenceListing[]; evidenceLeftOut?: number };
  context: SessionLabelContext;
  /** The owning scope's mask: the rubric prompt goes through it too, since a scorer may quote a team secret. */
  mask: (text: string) => string;
}

/**
 * Reads `found` for a judge once: its transcript with its subagents', its first prompt, the agent its captures agree on
 * with the one model its messages name, and the team skills it used, all redacted with `mask`.
 */
export function judgeSession({ platform, found, captures, mask, agent: archived, evidence }: {
  platform: string;
  found: { session: Session; subagents?: SubagentsRead };
  captures: readonly SessionCapture[];
  mask: (text: string) => string;
  /** What a pushed session ran as, as its archive records it: it has no captures here. */
  agent?: AgentObservation;
  /** The evidence its step left, as the archive keeps it beside a pushed session. */
  evidence?: ArchivedEvidence;
}): JudgedSession {
  const { session } = found;
  const transcript = judgedTranscript(found, { session: Number.POSITIVE_INFINITY, subagent: Number.POSITIVE_INFINITY }, mask);
  const subject = { platform, sessionId: session.sessionId };
  const used = usedSkills(AgentSession.toolForPlatform(platform), ownWork(found), capturedTeamSkillsAt(captures));
  const skills = skillsEvidence(captures, used, mask);

  const manifest: JudgedSession['manifest'] = {
    subject, kind: 'session',
    gaps: 'gap' in skills ? [...transcript.gaps, skills.gap] : transcript.gaps,
  };

  if ('skills' in skills) manifest.skills = skills.skills;
  const step = stepEvidenceOf(evidence, mask);

  if (evidence) manifest.evidence = step.listing;

  if (evidence?.leftOut !== undefined) manifest.evidenceLeftOut = evidence.leftOut;

  const framing = `## evidence.json\n\n${JSON.stringify(manifest)}\n\n## transcripts/session.md\n\n`.length
    + stepPromptSections(step.files).reduce((sum, section) => sum + `\n\n## ${section.title}\n\n`.length + section.body.length, 0);

  const agent = archived ?? SessionCaptures.agentOf(captures, SessionCaptures.reportedModelOf(session));
  const runMode = SessionCaptures.runModeOf(captures);
  const context: SessionLabelContext = { used: { skills: used }, prompt: mask(firstPrompt(session)) };

  if (agent) context.agent = agent;

  if (runMode) context.runMode = runMode;

  return {
    subject,
    body: keepEnds(mask(transcript.body), EVIDENCE_MAX_CHARS - framing),
    stepEvidence: step.files,
    manifest,
    context,
    mask,
  };
}

/** The most of the prompt the text files of a step's evidence take, so the transcript keeps the rest. */
const STEP_EVIDENCE_PROMPT_MAX_CHARS = 50_000;

/** The text files of a step's evidence as the prompt carries them: each cut at its ends to an even share of the step's. */
function stepPromptSections(files: JudgedSession['stepEvidence']): Array<{ title: string; body: string }> {
  const share = Math.floor(STEP_EVIDENCE_PROMPT_MAX_CHARS / Math.max(1, files.length));

  return files.map((file) => ({ title: file.path, body: keepEnds(file.text, share) }));
}

/** What a file name may not hold on Windows: control characters, and what a masked name's placeholders (`<REDACTED:…>`, `<repo>`) carry. */
const UNWRITABLE_NAME_CHARS = /[<>:"|?*\\\p{Cc}]/gu;

/** A name Windows opens as a device, with any extension: `nul.txt` is NUL ("Naming Files, Paths, and Namespaces"). */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;

/** One segment of a judge's path as Windows writes it: without what it refuses, never a device, and with nothing it strips at the end. */
function writableSegment(segment: string): string {
  const named = segment.replace(UNWRITABLE_NAME_CHARS, '_').replace(/[. ]+$/u, (stripped) => '_'.repeat(stripped.length)) || '_';

  return WINDOWS_DEVICE_NAME.test(named) ? `_${named}` : named;
}

/**
 * Where masked path `masked` goes in the judge's directory so every platform can write it: each segment as Windows
 * writes it (`writableSegment`), and, when that path or a directory on it is taken by an earlier file, as one numbered
 * name.
 */
function judgeDirPath(masked: string, taken: { files: Set<string>; dirs: Set<string> }): string {
  const segments = masked.split('/').map(writableSegment);
  const dirsOf = (parts: readonly string[]): string[] => parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  const isFree = (parts: readonly string[]): boolean => !taken.files.has(parts.join('/')) && !taken.dirs.has(parts.join('/')) && dirsOf(parts).every((dir) => !taken.files.has(dir));
  let chosen = segments;

  for (let number = 2; !isFree(chosen); number++) chosen = [`${segments.join('_')}~${number}`];
  taken.files.add(chosen.join('/'));

  for (const dir of dirsOf(chosen)) taken.dirs.add(dir);

  return chosen.join('/');
}

/**
 * `evidence` as a judge reads it, each text and path masked with `mask`: its text files under `evidence/`, each at a
 * path every platform can write, and every file listed for `evidence.json`.
 */
function stepEvidenceOf(evidence: ArchivedEvidence | undefined, mask: (text: string) => string) {
  const files: JudgedSession['stepEvidence'] = [];
  const listing: StepEvidenceListing[] = [];
  const taken = { files: new Set<string>(), dirs: new Set<string>() };

  for (const file of evidence?.files ?? []) {
    switch (file.kind) {
      case 'text': {
        const at = `evidence/${judgeDirPath(mask(file.path), taken)}`;
        files.push({ path: at, text: mask(file.text) });
        listing.push({ kind: 'text', path: at, type: file.type, size: file.size, cut: file.cut });
        break;
      }

      case 'listed':
        listing.push({ kind: 'listed', path: mask(file.path), type: file.type, size: file.size, sha256: file.sha256 });
        break;
      default: {
        const unhandled: never = file;

        return unhandled;
      }
    }
  }

  return { files, listing };
}

/**
 * Writes the evidence of one judge call of `rubrics` on `judged` into `dir`, `.ready` last, with `files`, which its
 * questions pinned to be read beside the transcript, by their path in `dir`, masked as the transcript is, and the text
 * files of the evidence its step left.
 */
export async function writeSessionEvidence(dir: string, judged: JudgedSession, rubrics: Rubrics, files: Readonly<Record<string, string>> = {}): Promise<void> {
  const { body, manifest, mask, stepEvidence } = judged;
  const asked = Object.entries(files).map(([file, text]) => ({ title: file, body: mask(text) }));
  const pinned = [...asked, ...stepEvidence.map((file) => ({ title: file.path, body: file.text }))];
  const prompted = [...asked, ...stepPromptSections(stepEvidence)];

  await writeEvidence(dir, async (tmp) => {
    await fs.mkdir(path.join(tmp, 'transcripts'));
    await fs.writeFile(path.join(tmp, 'transcripts', 'session.md'), body);
    await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));

    for (const { title, body: text } of pinned) {
      await fs.mkdir(path.dirname(path.join(tmp, title)), { recursive: true });
      await fs.writeFile(path.join(tmp, title), text);
    }

    await fs.writeFile(path.join(tmp, 'prompt.md'), mask(rubricPrompt(rubrics)) + fencedEvidence([
      { title: 'evidence.json', body: JSON.stringify(manifest) },
      { title: 'transcripts/session.md', body },
      ...prompted,
    ], [['transcripts/session.md', ...pinned.map(({ title }) => title)].join(', '), 'evidence.json'].join(' and ')));
  });
}

/** The label of a verdict on a session, with the context one read of it gave. */
export function sessionLabel(verdict: Omit<SessionLabel, 'source' | 'subject' | 'agent' | 'used' | 'runMode'>, subject: SessionSubject, context: SessionLabelContext): SessionLabel {
  const { scorer, rubric, label, score, passed, judge, scoredAt } = verdict;

  const sessionLabeled: SessionLabel = { scorer, rubric, label, score, passed, source: 'session', subject, used: context.used, judge, scoredAt };

  if (context.agent) sessionLabeled.agent = context.agent;

  if (context.runMode) sessionLabeled.runMode = context.runMode;

  return sessionLabeled;
}

function sameSessionKey(label: ScoreLabel, scorer: string, sourceHash: string, subject: SessionSubject): boolean {
  return label.source === 'session' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.platform === subject.platform && label.subject.sessionId === subject.sessionId;
}

/** A cached scorer that sets `sessions: true`; `namespace` is the scorers namespace it is in, none for the root or a shared dir. */
export interface SessionScorer {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  namespace?: string;
}

/** The scorers of this scope that judge sessions. */
async function sessionScorers(config: LocalConfig): Promise<SessionScorer[]> {
  const pins = await pinScorers(config, await cachedScorerNames(config));

  const scorers = Object.entries(pins).flatMap(([scorer, pin]) => {
    const definition = pinnedDefinition(scorer, pin);
    const [, dir, file] = (pin.relativePath ?? '').split('/');

    return definition?.sessions ? [{ scorer, pin, definition, dir: file === undefined ? undefined : dir }] : [];
  });

  const { shared } = await scorerNamespaces(config, [...new Set(scorers.flatMap(({ dir }) => dir ?? []))]);

  return scorers.map(({ dir, ...scorer }) => (dir === undefined || shared.includes(dir) ? scorer : { ...scorer, namespace: dir }));
}

/** `subject` as generated questions ask of it, with its captures; a pushed session has no captures here, so none. */
async function questionSession(config: LocalConfig, subject: Exclude<Subject, { kind: 'run' }>): Promise<QuestionSession | undefined> {
  return subject.kind === 'session' ? { subject: subject.subject, captures: await SessionCaptures.read(config, subject.subject.platform, subject.subject.sessionId) } : undefined;
}

/** The generated questions of `subject` that `switches` ask, each a scorer of the session. */
async function generatedQuestions(config: LocalConfig, subject: Exclude<Subject, { kind: 'run' }>, switches: QuestionSwitches): Promise<SessionScorer[]> {
  return GeneratedQuestions.questions(config, await questionSession(config, subject), switches);
}

/**
 * The pins of `names` for `subject`: a scorer as teamai pull cached it, a generated question as `subject` asks it. A
 * name with neither is left out; `unpinned` says why for a generated question's name.
 */
async function pinsOf(config: LocalConfig, subject: Exclude<Subject, { kind: 'run' }>, names: readonly string[]): Promise<{ pins: Record<string, PinnedScorer>; unpinned: Map<string, string> }> {
  const generated = names.filter(GeneratedQuestions.isGenerated);
  const pinned = await pinScorers(config, names);
  const unpinned = new Map<string, string>();

  if (generated.length === 0) return { pins: pinned, unpinned };
  const session = await questionSession(config, subject);

  for (const name of generated) {
    const found = await GeneratedQuestions.questionOf(config, name, session);

    if (found.ok) pinned[name] = found.question.pin;
    else unpinned.set(name, found.why);
  }

  return { pins: pinned, unpinned };
}

type CaptureSelection = NonNullable<NonNullable<SessionCapture['agent']['team']>['selection']>;

/**
 * `scope` as a capture's selection had it, so the namespaces it resolves are the ones the session was delivered. Its
 * workspace children count only while the capture saw the same ones; else none is known, and undefined.
 */
function selectedAs(scope: LocalConfig, selection: CaptureSelection): LocalConfig | undefined {
  const { children, roleUnresolved: _roleUnresolved, ...own } = scope;

  if (selection.children !== children?.fingerprint) return undefined;

  const selected: LocalConfig = {
    ...own,
    primaryRole: selection.primaryRole,
    additionalRoles: selection.additionalRoles,
    projects: selection.projects ?? [],
    subscribedTags: selection.subscribedTags,
    excludedSkills: selection.excludedSkills,
  };

  if (children) selected.children = children;

  return selected;
}

/**
 * The scorers namespaces of `dirs` active for every capture of a session, each resolved as its selection had the scope.
 * None when a capture records no selection, or the session has no capture: only root and shared scorers judge such a
 * session.
 */
async function sessionNamespaces(scope: LocalConfig, captures: readonly SessionCapture[], dirs: readonly string[]): Promise<Set<string>> {
  let active = new Set(captures.length > 0 ? dirs : []);

  for (const capture of captures) {
    const selection = capture.agent.team?.selection;
    const selected = selection && selectedAs(scope, selection);
    const resolved = selected ? (await scorerNamespaces(selected, dirs)).active : [];
    active = new Set(resolved.filter((dir) => active.has(dir)));
  }

  return active;
}

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

/** Whether a file the hooks of `captured` named is gone, so it is never finished, judged or published. */
async function isGone(captured: CapturedSession): Promise<boolean> {
  return await lastActiveAt(captured, new Map()) === undefined;
}

/**
 * The sessions of `captured` finished at `now`, oldest activity first, of the run modes `includes` keeps (a capture with
 * no mode counts as attended): an attended session once nothing happened in it for `idleMs`, as {@link SessionCaptures.finishedAfter} gives it, an
 * unattended one once a drain reached it (#1385), each with when something last happened in it. A session whose file
 * is gone is never finished.
 */
async function finished(captured: readonly CapturedSession[], now: string, includes: (mode: RunMode) => boolean, idleMs: number): Promise<Array<CapturedSession & { activeAt: number }>> {
  const events = await lastEvents();
  const found: Array<{ captured: CapturedSession; activeAt: number }> = [];

  for (const one of captured) {
    const mode = SessionCaptures.runModeOf(one.captures) ?? 'attended';

    if (!includes(mode)) continue;
    const activeAt = await lastActiveAt(one, events);

    if (activeAt === undefined) continue;

    switch (mode) {
      case 'attended':
        if (activeAt + idleMs <= Date.parse(now)) found.push({ captured: one, activeAt });
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

  return found.sort((left, right) => left.activeAt - right.activeAt).map((one) => ({ ...one.captured, activeAt: one.activeAt }));
}

/**
 * The scorers of this scope that judge sessions (`scorers`, else read) and apply to a session: the scorer lives at the
 * root, in a shared dir, or in a namespace every capture of the session was delivered, and it samples the session.
 */
async function samplingScorers(config: LocalConfig, scorers?: readonly SessionScorer[]): Promise<(session: { platform: string; sessionId: string; captures: readonly SessionCapture[] }) => Promise<SessionScorer[]>> {
  const all = scorers ?? await sessionScorers(config);
  const dirs = [...new Set(all.flatMap(({ namespace }) => namespace ?? []))];
  const scope = dirs.length > 0 ? await readWorkspaceChildren(config) : config;

  return async ({ platform, sessionId, captures }) => {
    const active = dirs.length > 0 ? await sessionNamespaces(scope, captures, dirs) : new Set<string>();

    return all.filter(({ scorer, namespace, definition }) => (namespace === undefined || active.has(namespace)) && isSampled(scorer, { platform, sessionId }, definition.samplingRate));
  };
}

/**
 * Reads the session for a judge, redacted with this scope's team secrets: from the file its hooks last named, else
 * where its tool keeps it; with `control`, its first prompt alone. Not ok when it is gone or holds nothing to judge.
 */
async function read(config: LocalConfig, subject: SessionSubject, { control = false }: { control?: boolean } = {}): Promise<{ ok: true; judged: JudgedSession } | { ok: false }> {
  const captures = await SessionCaptures.read(config, subject.platform, subject.sessionId);
  const filePath = captures.flatMap((capture) => capture.sessionFile ?? []).at(-1);
  const found = await AgentSession.find(filePath ? { ...subject, filePath } : { ...subject }, { subagents: true });

  if (found.status !== 'done' || found.session.messages.length === 0) return { ok: false };
  const envSecrets = await knownSecrets(config);

  // The control keeps the captures, so the skills the session had stay in its evidence while those it used go.
  return { ok: true, judged: judgeSession({ platform: subject.platform, found: control ? firstPromptOnly(found) : found, captures, mask: (text) => redact(text, { envSecrets }) }) };
}

/**
 * The session a teammate pushed as `teamSession`, for the repository `identities` name, as a judge of it reads it: redacted as
 * `read` redacts a session of this machine, with what its archive records it ran as.
 */
async function readPushed(config: LocalConfig, teamSession: TeamSession, identities: ReadonlyArray<string | null>): Promise<{ ok: true; sessionId: string; platform: string; judged: JudgedSession } | { ok: false; code: string; message: string }> {
  const pushed = await pushedSession(config, teamSession, identities);

  if ('error' in pushed) return { ok: false, ...pushed.error };
  const envSecrets = await knownSecrets(pushed.config);
  const archived = { platform: pushed.platform, found: pushed.found, captures: [], mask: (text: string) => redact(text, { envSecrets }) };

  return { ok: true, sessionId: pushed.found.session.sessionId, platform: pushed.platform, judged: judgeSession(pushed.agent ? { ...archived, agent: pushed.agent } : archived) };
}

/**
 * A directory whose teamai resolves to this scope's data home: the project's root, or for the user scope its data home,
 * which no project holds.
 */
function scopeCwd(config: LocalConfig): string {
  return config.scope === 'project' && config.projectRoot ? config.projectRoot : getDataHome(config);
}

/**
 * The scorers that sample session `subject` as automatic judging picks them (#1179) and could judge it now: no label of
 * the session holds their rubric, and their mark is one automatic judging starts, whether or not the session is
 * finished or its mode's policy is `auto`. The teamai-share-learnings offer proposes them (#1388).
 */
async function sampledScorers(config: LocalConfig, subject: SessionSubject, facts: MarkFacts): Promise<SessionScorer[]> {
  const [sampling, captures, labels] = await Promise.all([samplingScorers(config), SessionCaptures.read(config, subject.platform, subject.sessionId), LabelStore.local(config)]);
  const sampled = (await sampling({ ...subject, captures })).filter(({ scorer, pin }) => !labels.some((label) => sameSessionKey(label, scorer, pin.sourceHash, subject)));
  const states = await Marks.states(config, sampled.map(({ scorer, pin }): MarkKey => ({ scorer, sourceHash: pin.sourceHash, subject: { kind: 'session', subject } })), facts);

  return sampled.filter((_, index) => {
    const state = states[index];

    return state !== undefined && Marks.startsAgain(state);
  });
}

export const SessionWork = { finished, read, readPushed, scopeCwd, sampledScorers, samplingScorers, sessionScorers, generatedQuestions, pinsOf, isGone } as const;
