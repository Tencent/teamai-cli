/**
 * A finished agent session as judge work (#1178, #1179). One redacted read gives the evidence of every judge call and
 * the context its labels carry, so `teamai score --session` and a session judge lease build both alike. A session
 * captured in a scope is judge work there once nothing happened in it for six hours, for each scorer that sets
 * `sessions: true`; the lease machinery (`workflow/scoring.ts`) hands it out and settles it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { collectTeamSecrets } from '../env-resolution.js';
import { AttemptStore, type AttemptRecord } from '../scorers/attempts.js';
import { batchesScorers } from '../scorers/batch.js';
import { cachedScorerNames, pinScorers, scorerNamespaces } from '../scorers/cache.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import { hasLapsed, sessionEntryIdOf, sessionEntryState, type SessionEntryState } from '../scorers/entry.js';
import {
  fencedEvidence, isEvidenceReady, keepEnds, rubricPrompt, writeEvidence, EVIDENCE_MAX_CHARS, TOOL_CALL_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import type { ScoreLabel, SessionLabel, SessionLabelContext, SessionSubject } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import { isSampled } from '../scorers/sampling.js';
import type { ScopeScoring } from '../scorers/settings.js';
import { typedIn, usedSkills } from '../skill-use.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { collectEnvSecrets, redact } from '../utils/redact.js';
import { AgentSession } from './agent-session.js';
import type { SubagentsRead } from './adapters/base.js';
import { SessionCaptures, type CapturedSession, type SessionCapture } from './captures.js';
import type { Session } from './ir.js';

function transcriptOf(session: Session, budget: number): string {
  const capped: Session = {
    ...session,
    messages: session.messages.map((message) => ({ ...message, content: message.content.map((block) =>
      block.type === 'tool_call' ? { ...block, arguments: { excerpt: keepEnds(JSON.stringify(block.arguments), TOOL_CALL_MAX_CHARS) } } : block) })),
  };
  return keepEnds(AgentSession.transcript(capped).map((entry) => `### ${entry.role}\n${entry.text}\n${entry.toolOutput}`).join('\n\n'), budget);
}

/** A read session's transcript followed by each of its subagents', each kept to its budget, and what of them could not be read. */
export function judgedTranscript(found: { session: Session; subagents?: SubagentsRead }, budget: { session: number; subagent: number }): { body: string; gaps: EvidenceGap[] } {
  const gaps: EvidenceGap[] = [];
  let body = transcriptOf(found.session, budget.session);
  if (found.subagents?.status !== 'read') gaps.push('subagents_unread');
  else for (const agent of found.subagents.agents) {
    if (agent.start === 'unknown') gaps.push('subagent_boundary_unknown');
    body += `\n\n## Subagent (depth ${agent.depth}${agent.finished === false ? ', not finished' : ''})\n\n${transcriptOf(agent.session, budget.subagent)}`;
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
    const inEffect = captures.filter((capture) => Date.parse(capture.capturedAt) <= at).pop();
    return inEffect?.teamSkills ?? {};
  };
}

function firstPrompt(session: Session): string {
  const text = session.messages.flatMap((message) => message.content.map((block) => typedIn(message, block))).find((typed) => typed !== '') ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** A session as one read gives it to a judge. In memory only: its body is the session's redacted text. */
export interface JudgedSession {
  subject: SessionSubject;
  /** The redacted transcript and its subagents', kept to the evidence cap with the evidence framing. */
  body: string;
  manifest: { subject: SessionSubject; kind: 'session'; gaps: EvidenceGap[] };
  context: SessionLabelContext;
  /** The owning scope's mask: the rubric prompt goes through it too, since a scorer may quote a team secret. */
  mask: (text: string) => string;
}

/**
 * Reads `found` for a judge once: its transcript with its subagents', its first prompt, the agent its captures agree on
 * with the one model its messages name, and the team skills it used, all redacted with `mask`.
 */
export function judgeSession({ platform, found, captures, mask }: {
  platform: string;
  found: { session: Session; subagents?: SubagentsRead };
  captures: readonly SessionCapture[];
  mask: (text: string) => string;
}): JudgedSession {
  const { session } = found;
  const transcript = judgedTranscript(found, { session: Number.POSITIVE_INFINITY, subagent: Number.POSITIVE_INFINITY });
  const subject = { platform, sessionId: session.sessionId };
  const manifest = { subject, kind: 'session' as const, gaps: transcript.gaps };
  const framing = `## evidence.json\n\n${JSON.stringify(manifest)}\n\n## transcripts/session.md\n\n`.length;
  const models = new Set(session.messages.flatMap((message) => message.metadata?.model ?? []));
  const [reportedModel] = models.size === 1 ? models : [];
  const agent = SessionCaptures.agentOf(captures, reportedModel);
  return {
    subject,
    body: keepEnds(mask(transcript.body), EVIDENCE_MAX_CHARS - framing),
    manifest,
    context: {
      ...(agent ? { agent } : {}),
      used: { skills: usedSkills(AgentSession.toolForPlatform(platform), found, capturedTeamSkillsAt(captures)) },
      prompt: mask(firstPrompt(session)),
    },
    mask,
  };
}

/** Writes the evidence of one judge call of `rubrics` on `judged` into `dir`, `.ready` last. */
export async function writeSessionEvidence(dir: string, judged: JudgedSession, rubrics: Rubrics): Promise<void> {
  const { body, manifest, mask } = judged;
  await writeEvidence(dir, async (tmp) => {
    await fs.mkdir(path.join(tmp, 'transcripts'));
    await fs.writeFile(path.join(tmp, 'transcripts', 'session.md'), body);
    await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(tmp, 'prompt.md'), mask(rubricPrompt(rubrics)) + fencedEvidence([
      { title: 'evidence.json', body: JSON.stringify(manifest) },
      { title: 'transcripts/session.md', body },
    ], 'transcripts/session.md and evidence.json'));
  });
}

/** The label of a verdict on a session, with the context one read of it gave. */
export function sessionLabel(verdict: Omit<SessionLabel, 'source' | 'subject' | 'agent' | 'used'>, subject: SessionSubject, context: SessionLabelContext): SessionLabel {
  const { scorer, rubric, label, score, passed, judge, scoredAt } = verdict;
  return { scorer, rubric, label, score, passed, source: 'session', subject, ...(context.agent ? { agent: context.agent } : {}), used: context.used, judge, scoredAt };
}

/** Nothing happened in a session for this long: it is finished, and judge work. */
export const FINISHED_AFTER_MS = 6 * 60 * 60 * 1000;

/** One sampled (scorer, finished session) of this scope with its derived state. */
export interface SessionEntry {
  source: 'session';
  id: string;
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  subject: SessionSubject;
  state: SessionEntryState;
  /** Whether its scorers share one judge call: the team's `batch`, as `score --session` decides it. */
  batch: boolean;
}

function sameSessionKey(label: ScoreLabel, scorer: string, sourceHash: string, subject: SessionSubject): boolean {
  return label.source === 'session' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.platform === subject.platform && label.subject.sessionId === subject.sessionId;
}

/** A cached scorer that sets `sessions: true`; `namespace` is the scorers namespace it is in, none for the root or a shared dir. */
interface SessionScorer {
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

type CaptureSelection = NonNullable<NonNullable<SessionCapture['agent']['team']>['selection']>;

/**
 * `scope` as a capture's selection had it, so the namespaces it resolves are the ones the session was delivered. Its
 * workspace children count only while the capture saw the same ones; else none is known, and undefined.
 */
function selectedAs(scope: LocalConfig, selection: CaptureSelection): LocalConfig | undefined {
  const { children, roleUnresolved: _roleUnresolved, ...own } = scope;
  if (selection.children !== children?.fingerprint) return undefined;
  return {
    ...own,
    primaryRole: selection.primaryRole,
    additionalRoles: selection.additionalRoles,
    projects: selection.projects ?? [],
    subscribedTags: selection.subscribedTags,
    excludedSkills: selection.excludedSkills,
    ...(children ? { children } : {}),
  };
}

/**
 * The scorers namespaces of `dirs` active for every capture of a session, each resolved as its selection had the scope.
 * None when a capture records no selection: only root and shared scorers judge such a session.
 */
async function sessionNamespaces(scope: LocalConfig, captures: readonly SessionCapture[], dirs: readonly string[]): Promise<Set<string>> {
  let active = new Set(dirs);
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
    const key = sessionKey(platform, event.sessionId);
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
  const event = events.get(sessionKey(captured.platform, captured.sessionId));
  return Math.max(...known, ...(event ? [Date.parse(event)] : []), ...captured.captures.map((capture) => Date.parse(capture.capturedAt)));
}

const sessionKey = (platform: string, sessionId: string) => `${platform}\0${sessionId}`;

/** Every session captured here by `platform\0sessionId`, while a session attempt is kept here to prune by it; else none. */
async function prunableBy(config: LocalConfig): Promise<ReadonlySet<string> | undefined> {
  const attempts = [...(await AttemptStore.read(config)).values()].flat();
  if (!attempts.some((attempt) => attempt.source === 'session')) return undefined;
  return new Set((await SessionCaptures.list(config)).map((one) => sessionKey(one.platform, one.sessionId)));
}

/**
 * The session entries of this scope, oldest activity first: each finished session captured here, for each scorer of
 * the scope that judges sessions and samples it, and every session captured here by `platform\0sessionId`. None while
 * the scope does not turn session scoring on or no scorer judges sessions; `captured` is then listed only while
 * session attempts are kept, so they are pruned after the team or the member turned it off.
 */
async function entries(config: LocalConfig, now: string, scoring: Extract<ScopeScoring, { ok: true }>): Promise<{ entries: SessionEntry[]; captured?: ReadonlySet<string> }> {
  if (!scoring.sessions.enabled) return { entries: [], captured: await prunableBy(config) };
  const scorers = await sessionScorers(config);
  if (scorers.length === 0) return { entries: [], captured: await prunableBy(config) };
  const captured = await SessionCaptures.list(config);
  const keys = new Set(captured.map((one) => sessionKey(one.platform, one.sessionId)));
  if (captured.length === 0) return { entries: [], captured: keys };
  const events = await lastEvents();
  const finished: Array<{ captured: CapturedSession; activeAt: number }> = [];
  for (const one of captured) {
    const activeAt = await lastActiveAt(one, events);
    if (activeAt !== undefined && activeAt + FINISHED_AFTER_MS <= Date.parse(now)) finished.push({ captured: one, activeAt });
  }
  finished.sort((left, right) => left.activeAt - right.activeAt);
  const [labels, attempts] = await Promise.all([LabelStore.local(config), AttemptStore.read(config)]);
  const batch = batchesScorers({ team: scoring.batch });
  const dirs = [...new Set(scorers.flatMap(({ namespace }) => namespace ?? []))];
  const scope = dirs.length > 0 ? await readWorkspaceChildren(config) : config;
  const sessions: Array<{ platform: string; sessionId: string; scorers: SessionScorer[] }> = [];
  for (const { captured } of finished) {
    const active = dirs.length > 0 ? await sessionNamespaces(scope, captured.captures, dirs) : new Set<string>();
    sessions.push({ ...captured, scorers: scorers.filter(({ namespace }) => namespace === undefined || active.has(namespace)) });
  }
  const found = sessions.flatMap(({ platform, sessionId, scorers: applying }) => applying.flatMap(({ scorer, pin, definition }): SessionEntry[] => {
    const subject = { platform, sessionId };
    if (!isSampled(scorer, subject, definition.samplingRate)) return [];
    const id = sessionEntryIdOf(scorer, pin.sourceHash, subject);
    const state = sessionEntryState({ labels: labels.filter((label) => sameSessionKey(label, scorer, pin.sourceHash, subject)), attempts: attempts.get(id) ?? [], now });
    // A tried or labelled key is never work again; leaving it out keeps the attempts lock's scan to open and live keys.
    return state.kind === 'open' || state.kind === 'leased' ? [{ source: 'session', id, scorer, pin, definition, subject, state, batch }] : [];
  }));
  return { entries: found, captured: keys };
}

/** Whether a judge has labelled this key with a model label on this machine since it was offered. */
async function isLabelled(config: LocalConfig, entry: Pick<SessionEntry, 'scorer' | 'pin' | 'subject'>): Promise<boolean> {
  return (await LabelStore.local(config)).some((label) => label.judge.kind === 'model' && sameSessionKey(label, entry.scorer, entry.pin.sourceHash, entry.subject));
}

const localDay = (at: string) => new Date(at).toDateString();

/** The day's launches: distinct attempt ids of session attempts leased on `now`'s local date. A batch shares one id. */
function launchesToday(attempts: Iterable<AttemptRecord>, now: string): number {
  const today = localDay(now);
  return new Set([...attempts].filter((attempt) => attempt.source === 'session' && localDay(attempt.leasedAt) === today).map((attempt) => attempt.attempt)).size;
}

/**
 * The session entries whose attempts can go: every attempt is of a session no longer captured here, so it is never
 * judge work again, and none was leased today, which it would count towards, or is still live.
 */
function gone(attempts: ReadonlyMap<string, readonly AttemptRecord[]>, captured: ReadonlySet<string>, now: string): string[] {
  const today = localDay(now);
  return [...attempts].filter(([, ofEntry]) => ofEntry.length > 0 && ofEntry.every((attempt) => attempt.source === 'session'
    && !captured.has(sessionKey(attempt.subject.platform, attempt.subject.sessionId))
    && localDay(attempt.leasedAt) !== today
    && !(attempt.status === 'leased' && !hasLapsed(attempt, now)))).map(([entry]) => entry);
}

/**
 * Reads the session for a judge, redacted with this scope's team secrets: from the file its hooks last named, else
 * where its tool keeps it. Not ok when it is gone or holds nothing to judge.
 */
async function read(config: LocalConfig, subject: SessionSubject): Promise<{ ok: true; judged: JudgedSession } | { ok: false }> {
  const captures = await SessionCaptures.read(config, subject.platform, subject.sessionId);
  const filePath = captures.flatMap((capture) => capture.sessionFile ?? []).at(-1);
  const found = await AgentSession.find({ ...subject, ...(filePath ? { filePath } : {}) }, { subagents: true });
  if (found.status !== 'done' || found.session.messages.length === 0) return { ok: false };
  const envSecrets = { ...collectEnvSecrets(), ...await collectTeamSecrets(config) };
  return { ok: true, judged: judgeSession({ platform: subject.platform, found, captures, mask: (text) => redact(text, { envSecrets }) }) };
}

/** A session lease's evidence in `dir`: kept when it is ready, else read again and written. */
async function ensureEvidence(config: LocalConfig, subject: SessionSubject, rubrics: Rubrics, dir: string): Promise<{ ok: true } | { ok: false; code: 'evidence_empty' }> {
  if (await isEvidenceReady(dir)) return { ok: true };
  const session = await read(config, subject);
  if (!session.ok) return { ok: false, code: 'evidence_empty' };
  await writeSessionEvidence(dir, session.judged, rubrics);
  return { ok: true };
}

/**
 * Where a session lease is submitted from: a directory whose teamai resolves to this scope's data home, which holds
 * its attempt. The project's root, or for the user scope its data home, which no project holds.
 */
function leaseCwd(config: LocalConfig): string {
  return config.scope === 'project' && config.projectRoot ? config.projectRoot : getDataHome(config);
}

export const SessionWork = { entries, isLabelled, launchesToday, gone, read, ensureEvidence, leaseCwd } as const;
