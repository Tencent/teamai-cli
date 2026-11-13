/**
 * The evidence directory of one group, `$TEAMAI_RUN_DIR/<attempt>/`: main's evidence files, which `evidenceHash` covers,
 * and this design's own records beside them. `group.json` is what `score evidence` resolved, which every later verb of
 * the group reads back; `confined.json` the isolation the judge step needs; the stage records; and `labels.json`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { knownSecrets } from '../env-resolution.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { pushedSession } from '../session-flow/scoring.js';
import { firstPromptOnly, judgeSession, SessionWork, writeSessionEvidence, type JudgedSession } from '../session-flow/session-work.js';
import type { JsonValue } from '../types.js';
import { readFileIfExists } from '../utils/fs.js';
import { redact } from '@teamai/shared/redact';
import { CONFINED_FILE, ConfinedFileSchema, type ConfinedFile } from '../workflow/confined-place.js';
import type { RunState } from '../workflow/types.js';
import type { ScorerDefinition } from './definition.js';
import { answerSchema, rubricPrompt, type Rubrics } from './evidence.js';
import { requiredIsolation, scorerIsolationSource } from './isolation.js';
import { RunSubjectSchema, SessionLabelContextSchema, SessionSubjectSchema, type RunSubject } from './label.js';
import { pinnedDefinition, PinnedScorerSchema, type PinnedScorer } from './pin.js';
import { ScorerFolder } from './folder.js';
import { RunScorers } from './run-scorers.js';
import { plannedJudgesOf } from '../benchmark/run-plan.js';
import type { ScoreAttempt } from './score-attempt.js';
import { judgeablePass, plannedSessionPins, type Refusal } from './score-plan.js';
import { buildEvidence, isDelivered, missingEvidence } from './scoring-evidence.js';
import { scopeScoring } from './settings.js';
import { Subject } from './subject.js';

const GROUP = 'group.json';
const ANSWER_SCHEMA = 'answer.schema.json';
const REPLY_SCHEMA = 'reply.schema.json';

/** What the group judges: a pass, or a session with what one read of it gave; a hand label's gone session gave nothing. */
const JudgedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), subject: RunSubjectSchema }),
  z.object({ kind: z.literal('session'), subject: SessionSubjectSchema, context: SessionLabelContextSchema.optional() }),
]);

const ScorerSchema = z.object({ name: z.string().min(1), pin: PinnedScorerSchema });

const GroupRecordSchema = z.object({
  /** The subject as the instance's `item.subject` gave it. */
  subject: z.string().min(1),
  judged: JudgedSchema,
  scorers: z.tuple([ScorerSchema], ScorerSchema),
  delivers: z.boolean(),
  /** The group labels by hand: its evidence holds no transcript. */
  hand: z.boolean(),
});

export type GroupRecord = z.infer<typeof GroupRecordSchema>;

/** What `score evidence` prints: the directory, the rubric text the judge prompt quotes, the answer schema's path, and whether the pass delivers. */
export interface EvidenceOutput {
  dir: string;
  rubric: string;
  schema: string;
  delivers: boolean;
}

interface Pinned {
  scorers: GroupRecord['scorers'];
  rubrics: Rubrics;
}

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/**
 * The scorer each pinned scorer of a group is: parseable, since `pinsOf` read it, so a record that does not parse is
 * refused. With the evidence directory `dir`, a scorer folder's prompt names where its files are written in it.
 */
export function rubricsOf(scorers: GroupRecord['scorers'], dir?: string): Rubrics | undefined {
  const [first, ...rest] = scorers.map(({ name, pin }) => {
    const definition = pinnedDefinition(name, pin);

    return definition && dir !== undefined && pin.files !== undefined ? { ...definition, prompt: ScorerFolder.render(definition.prompt, ScorerFolder.dirIn(dir, name)) } : definition;
  });

  const others = rest.filter((each): each is ScorerDefinition => each !== undefined);

  return first && others.length === rest.length ? [first, ...others] : undefined;
}

/** The reply a confined judge gives: `{"answer": <the answer schema>}`. */
function replySchema(rubrics: Rubrics): JsonValue {
  return { type: 'object', properties: { answer: answerSchema(rubrics) }, required: ['answer'], additionalProperties: false };
}

/**
 * The scorers of the group as `read` pins them for the subject: by its run for a pass; for a session, as teamai pull
 * cached them, and a routing question as the session's captures ask it. `where` says where a missing one was looked for.
 * A scorer folder's prompt names where `writeRecords` writes its files in the evidence directory `dir`.
 */
function pinsOf(names: readonly string[], read: { ok: true; pins: Record<string, PinnedScorer> } | { ok: false; reason: string }, where: string, dir: string): Pinned | Refusal {
  if (!read.ok) return refused('scorer_not_found', `${read.reason} No evidence was written.`);
  const scorers = names.map((name) => ({ name, pin: read.pins[name] }));
  const missing = scorers.find(({ name, pin }) => !pin || !pinnedDefinition(name, pin));

  if (missing) return refused('scorer_not_found', `Scorer ${missing.name} is not ${where}, so the group has nothing to judge it by.`);
  const [first, ...rest] = scorers.flatMap(({ name, pin }) => (pin ? [{ name, pin }] : []));

  if (!first) return refused('invalid_arguments', '--scorers names no scorer. Pass the group\'s scorers, as plan printed them.');
  const rubrics = rubricsOf([first, ...rest], dir);

  return rubrics ? { scorers: [first, ...rest], rubrics } : refused('scorer_not_found', `A scorer of ${names.join(', ')} does not parse.`);
}

/** The session judged: one of this machine, or one a member pushed, read from the archive. */
async function sessionRead(attempt: ScoreAttempt, subject: Exclude<Subject, { kind: 'run' }>): Promise<{ ok: true; judged: JudgedSession } | Refusal> {
  const control = attempt.isControl;

  if (subject.kind === 'session') {
    const read = await SessionWork.read(attempt.config, subject.subject, { control });

    return read.ok ? read : refused('evidence_empty', `Session ${subject.subject.sessionId} of ${subject.subject.platform} is gone from this machine, or holds nothing to judge.`);
  }

  const pushed = await pushedSession(attempt.config, subject.subject);

  if ('error' in pushed) return refused(pushed.error.code, pushed.error.message);
  const envSecrets = await knownSecrets(pushed.config);
  const read = { platform: pushed.platform, found: control ? firstPromptOnly(pushed.found) : pushed.found, captures: [], mask: (text: string) => redact(text, { envSecrets }) };

  return { ok: true, judged: judgeSession(pushed.agent ? { ...read, agent: pushed.agent } : read) };
}

async function writeJson(dir: string, name: string, value: GroupRecord | ConfinedFile | JsonValue): Promise<void> {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** The record `schema` reads in `file`, or undefined when there is none or it does not parse. */
export async function readRecord<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readFileIfExists(file);

  try {
    return text === null ? undefined : schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** Writes the group record, and for a judge its scorer folders' files, its `confined.json`, the reply schema it names, and the answer schema. */
async function writeRecords(dir: string, group: GroupRecord, judge?: { confined: ConfinedFile; reply: JsonValue; answer: JsonValue }): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeJson(dir, GROUP, group);

  if (!judge) return;

  for (const { name, pin } of group.scorers) if (pin.files !== undefined) await ScorerFolder.write(ScorerFolder.dirIn(dir, name), pin.files);
  await writeJson(dir, CONFINED_FILE, judge.confined);
  await writeJson(dir, REPLY_SCHEMA, judge.reply);
  await writeJson(dir, ANSWER_SCHEMA, judge.answer);
}

/** Writes the run's evidence of a pass, which main's evidence holds; a commit or session it recorded that is gone refuses. */
async function passEvidence(attempt: ScoreAttempt, run: RunState, subject: RunSubject, rubrics: Rubrics): Promise<{ ok: true } | Refusal> {
  const missing = await missingEvidence(run, subject);

  if (missing.length > 0) {
    return refused('evidence_missing', `Pass ${subject.pass} of step ${subject.step} in run ${run.id} cannot be scored: no longer on this machine: ${missing.join('; ')}. Restore what is missing, or score another pass.`);
  }

  const built = await buildEvidence(attempt.config, run, subject, rubrics, attempt.dir);

  return built.ok ? built : refused(built.code, `The evidence of pass ${subject.pass} of step ${subject.step} in run ${run.id} is empty: the place it ran in kept none of its work.`);
}

/**
 * The records a judge reads beside the evidence: the isolation its scorers need, the tool the run requires, else the
 * tools to prefer, the one its scorers name before `worked`, the one the judged work ran in, and the answer schema.
 */
async function judgeRecords(attempt: ScoreAttempt, group: GroupRecord, rubrics: Rubrics, { worked, required }: { worked: string | undefined; required?: string }): Promise<EvidenceOutput | Refusal> {
  const scoring = await scopeScoring(attempt.config);

  if (!scoring.ok) return refused('scoring_settings_invalid', scoring.reason);
  const settings = group.scorers.map(({ name, pin }, index) => ({ source: scorerIsolationSource(name, pin.relativePath), value: rubrics[index]?.isolation }));
  const confined: ConfinedFile = { level: requiredIsolation([...scoring.isolation, ...settings]).level, schema: REPLY_SCHEMA };

  const [first, ...more] = [...new Set([rubrics[0].tool, worked].flatMap((tool) => tool ?? []))];

  if (required !== undefined) confined.require = required;
  else if (first !== undefined) confined.prefer = more.length > 0 ? [first, ...more] : first;
  await writeRecords(attempt.dir, group, { confined, reply: replySchema(rubrics), answer: answerSchema(rubrics) });

  return { dir: attempt.dir, rubric: rubricPrompt(rubrics), schema: path.join(attempt.dir, ANSWER_SCHEMA), delivers: group.delivers };
}

async function runEvidence(attempt: ScoreAttempt, subject: RunSubject, names: readonly string[], hand: boolean): Promise<EvidenceOutput | Refusal> {
  const ran = await judgeablePass(attempt.config, subject);

  if (!ran.ok) return ran;
  const pinned = pinsOf(names, await RunScorers.of(ran.config, ran.run), `a scorer of run ${ran.run.id} at the team revision it started from`, attempt.dir);

  if ('ok' in pinned) return pinned;
  const group: GroupRecord = { subject: Subject.format({ kind: 'run', subject }), judged: { kind: 'run', subject }, scorers: pinned.scorers, delivers: isDelivered(ran.run, subject), hand };

  if (hand) {
    await writeRecords(attempt.dir, { ...group, delivers: false });

    return { dir: attempt.dir, rubric: '', schema: '', delivers: false };
  }

  const written = await passEvidence(attempt, ran.run, subject, pinned.rubrics);

  // One judge tool for every arm: the group's scorers share the tool their benchmark plan requires, as they batch by it.
  const required = plannedJudgesOf(ran.run, subject.step)[group.scorers[0].name]?.tool;

  return written.ok ? judgeRecords(attempt, group, pinned.rubrics, { worked: ran.pass.tool, required }) : written;
}

async function sessionEvidence(attempt: ScoreAttempt, subject: Exclude<Subject, { kind: 'run' }>, names: readonly string[], hand: boolean): Promise<EvidenceOutput | Refusal> {
  const pinned = pinsOf(names, { ok: true, pins: await plannedSessionPins(attempt, subject, names) }, 'a scorer teamai pull cached or a routing question of the session', attempt.dir);

  if ('ok' in pinned) return pinned;
  const read = await sessionRead(attempt, subject);

  // A hand label needs no transcript: a session that is gone is still labelled, with what it used unknown.
  if (hand && subject.kind === 'session' && !read.ok) {
    await writeRecords(attempt.dir, { subject: Subject.format(subject), judged: { kind: 'session', subject: subject.subject }, scorers: pinned.scorers, delivers: false, hand });

    return { dir: attempt.dir, rubric: '', schema: '', delivers: false };
  }

  if (!read.ok) return read;
  const { judged } = read;
  const group: GroupRecord = { subject: Subject.format(subject), judged: { kind: 'session', subject: judged.subject, context: judged.context }, scorers: pinned.scorers, delivers: false, hand };

  if (hand) {
    await writeRecords(attempt.dir, group);

    return { dir: attempt.dir, rubric: '', schema: '', delivers: false };
  }

  await writeSessionEvidence(attempt.dir, judged, pinned.rubrics, Object.assign({}, ...pinned.scorers.map(({ pin }) => pin.evidence ?? {})));

  return judgeRecords(attempt, group, pinned.rubrics, { worked: AgentSession.toolForPlatform(judged.subject.platform) });
}

export const EvidenceDir = {
  /**
   * Writes the evidence of `scorers` on `subject` into the attempt's own directory. A hand label's group only resolves
   * the subject, so a session whose transcript is gone can still be labelled.
   */
  async write(attempt: ScoreAttempt, { subject, scorers, hand }: { subject: Subject; scorers: readonly string[]; hand: boolean }): Promise<{ ok: true; output: EvidenceOutput } | Refusal> {
    const written = subject.kind === 'run' ? await runEvidence(attempt, subject.subject, scorers, hand) : await sessionEvidence(attempt, subject, scorers, hand);

    return 'ok' in written ? written : { ok: true, output: written };
  },

  /** The group record `score evidence` wrote in `dir`, or why `dir` holds none. */
  async read(dir: string): Promise<{ ok: true; group: GroupRecord } | Refusal> {
    const group = await readRecord(path.join(dir, GROUP), GroupRecordSchema);

    return group ? { ok: true, group } : refused('evidence_unreadable', `${dir} holds no group record that teamai score evidence wrote. Pass the dir its step printed.`);
  },

  /** The isolation the group's judge needed and the tool it required or preferred, which a judge-group's evidence holds. */
  async confined(dir: string): Promise<ConfinedFile | undefined> {
    return readRecord(path.join(dir, CONFINED_FILE), ConfinedFileSchema);
  },
} as const;
