/**
 * `teamai score label`, `write` and `settle`: the labels of one group, from its hand label, else the stage that decided
 * it, else its judge's answer; the same labels checked again and written to local storage, which closes their marks;
 * and the failed attempt of a group whose verbs broke.
 */
import path from 'node:path';
import { z } from 'zod';
import { ConfinedUsageSchema, CostSchema, type ConfinedUsage } from '../tool-launch/confined-level.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { writeFileAtomic } from '../utils/fs.js';
import { findRunConfig } from '../workflow/run-location.js';
import { privateSteps } from '../workflow/scope.js';
import type { RunState } from '../workflow/types.js';
import { isIsolated } from '../workflow/workspace.js';
import { JudgeAnswerSchema, verdictsOf } from './batch.js';
import type { ScorerDefinition, ScorerLabel } from './definition.js';
import { removeSubjectEvidence } from './evidence.js';
import { readRecord, type GroupRecord } from './evidence-dir.js';
import { GeneratedQuestions } from './generated-questions.js';
import { scoresDir } from './home.js';
import { JUDGE_FAILURES, labelVersion, ScoreLabelSchema, type Decider, type JudgeFailureCode, type ScoreLabel } from './label.js';
import { LabelStore } from './label-store.js';
import { Marks, type MarkKey, type MarkOutcome } from './marks.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import type { ScoreAttempt } from './score-attempt.js';
import { markFacts, plannedSessionPins, scorerStages, type Refusal } from './score-plan.js';
import { ScoreStage, type StageRecord } from './score-stage.js';
import { ScoreSubjects } from './score-subjects.js';
import { evidenceHash, judgedFacts, type JudgedFacts } from './scoring-evidence.js';
import { failingLabel } from './scoring-stages.js';
import { Subject } from './subject.js';
import { ConfinedRunReportSchema, TokenUsageSchema, type ConfinedRunReport } from '../workflow/step-state.js';

/** The confined run that judge step `step` of `run` recorded on its pass, or undefined when it recorded none. */
const readJudgeRun = (run: RunState, step: string): ConfinedRunReport | undefined => z.object({ confined: ConfinedRunReportSchema }).safeParse(run.steps.find((state) => state.id === step)).data?.confined;

const JudgeSpendSchema = z.object({ confined: z.object({ usage: ConfinedUsageSchema.optional() }).optional(), tokens: TokenUsageSchema.optional(), cost: CostSchema.optional() });

/** The usage of a report's `tokens` and `cost`, or undefined when it gave neither. */
function reportedUsage({ tokens, cost }: Omit<z.infer<typeof JudgeSpendSchema>, 'confined'>): ConfinedUsage | undefined {
  const usage: ConfinedUsage = {};

  if (tokens?.input !== undefined) usage.inputTokens = tokens.input;

  if (tokens?.output !== undefined) usage.outputTokens = tokens.output;

  if (cost) usage.cost = cost;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * What judge step `step` of `run` spent: its confined run's usage, or the tokens and cost its report gave, which is all a
 * confined run that failed reports. Undefined when it reported nothing.
 */
function judgeSpend(run: RunState, step: string): ConfinedUsage | undefined {
  const spent = JudgeSpendSchema.safeParse(run.steps.find((state) => state.id === step)).data;

  return spent?.confined?.usage ?? (spent ? reportedUsage(spent) : undefined);
}

/** The judge step of the group attempt `attempt` runs a step of. */
function judgeStepOf(attempt: ScoreAttempt): string {
  return [...attempt.step.split('.').slice(0, -1), 'judge'].join('.');
}

/** A failed attempt, with what its judge call spent when one ran: counted once, on the first mark it closes. */
function failedOutcome(code: JudgeFailureCode, usage: ConfinedUsage | undefined): MarkOutcome {
  const outcome: Extract<MarkOutcome, { kind: 'failed' }> = { kind: 'failed', code };

  if (usage) outcome.usage = usage;

  return outcome;
}

/** Why `score label` gave a planned scorer no label: the code in its entry. */
export const LABEL_CODES = [...JUDGE_FAILURES, 'ci_pending'] as const;

/** A scorer's entry: its label, with the reasoning kept locally, or the code of why it has none. */
const EntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('labelled'), scorer: z.string().min(1), label: ScoreLabelSchema, reasoning: z.string().optional(), prompt: z.string().optional() }),
  /** `usage`: what the judge call spent, on the first entry of a group whose judge ran and gave no label. */
  z.object({ kind: z.literal('failed'), scorer: z.string().min(1), code: z.enum(LABEL_CODES), message: z.string(), usage: ConfinedUsageSchema.optional() }),
]);

type Entry = z.infer<typeof EntrySchema>;

/** A scorer's entry in a group's labels.json: its label with the reasoning, or the code of why it has none. */
export type LabelEntry = Entry;

const LabelsFileSchema = z.object({ entries: z.array(EntrySchema) });

const LABELS = 'labels.json';

/** What an entry's step output holds for a field it has no value of: the output declares a string, so not null. */
const NONE = '';

/** What `score label` prints of each planned scorer: never the reasoning. */
export interface LabelOutput {
  scorer: string;
  label: string;
  code: string;
}

interface Member {
  name: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** What the label of a member records, besides the judge: the subject's facts, the rubric, and the verdict. */
interface Labelling {
  attempt: ScoreAttempt;
  group: GroupRecord;
  run: RunState | undefined;
  now: string;
  hash: string | undefined;
}

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

function failedAll(members: readonly Member[], code: (typeof LABEL_CODES)[number], message: string, usage?: ConfinedUsage): Entry[] {
  return members.map(({ name }, index) => {
    const entry: Entry = { kind: 'failed', scorer: name, code, message };

    if (usage && index === 0) entry.usage = usage;

    return entry;
  });
}

/** Each scorer of the group with the rubric its pin holds, or undefined when one does not parse. */
function membersOf(group: GroupRecord): Member[] | undefined {
  const members = group.scorers.flatMap(({ name, pin }) => {
    const definition = pinnedDefinition(name, pin);

    return definition ? [{ name, pin, definition }] : [];
  });

  return members.length === group.scorers.length ? members : undefined;
}

/** The label of `member` with `given`, as a pass's or a session's label holds it. */
function labelOf({ group, run, now, hash }: Labelling, member: Member, given: ScorerLabel, judge: ScoreLabel['judge'], decidedBy: Decider | undefined): ScoreLabel {
  const rubric = member.pin.teamRevision ? { sourceHash: member.pin.sourceHash, teamRevision: member.pin.teamRevision } : { sourceHash: member.pin.sourceHash };
  const verdict = { scorer: member.name, rubric, label: given.value, score: given.score, passed: given.score >= member.definition.passingScore, judge, scoredAt: now };

  if (group.judged.kind === 'session') {
    const { context, subject } = group.judged;
    const label: ScoreLabel = { ...verdict, source: 'session', subject };

    if (!context) return label;
    const { prompt: _prompt, ...facts } = context;

    return { ...label, ...facts };
  }

  const facts: JudgedFacts = run ? judgedFacts(run, group.judged.subject) : {};
  const label: ScoreLabel = { ...verdict, source: 'workflow', subject: group.judged.subject, ...facts };

  if (decidedBy) label.decidedBy = decidedBy;

  if (hash) label.evidenceHash = hash;

  return label;
}

function stageEntries(labelling: Labelling, members: readonly Member[], record: Exclude<StageRecord, { kind: 'judge' }>): Entry[] {
  switch (record.kind) {
    case 'unrunnable':
      return failedAll(members, 'check_could_not_run', record.message);
    case 'pending':
      return failedAll(members, 'ci_pending', `The CI of commit ${record.head} has not finished; the group is judged once it has.`);
    case 'decided':
      return members.map((member) => ({ kind: 'labelled', scorer: member.name, label: labelOf(labelling, member, failingLabel(member.definition), { kind: 'stage' }, record.by), reasoning: record.reasoning }));

    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/** The verdict on each member that the judge's `answer` gives, or why it gives none. */
function verdictsIn(members: readonly [Member, ...Member[]], answer: string | undefined): ReturnType<typeof verdictsOf<Member>> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(answer ?? '');
  } catch {
    parsed = undefined;
  }

  const given = JudgeAnswerSchema.safeParse(parsed);

  return given.success ? verdictsOf(members, (member) => member.definition, given.data) : { ok: false, message: 'The answer is not JSON of the answer schema.' };
}

/** The entries of the judge's answer: one label per member, or one code for all of them. */
function judgeEntries(labelling: Labelling, members: readonly [Member, ...Member[]], { answer, judged, run, spent }: { answer: string | undefined; judged: string | undefined; run: ConfinedRunReport | undefined; spent: ConfinedUsage | undefined }): Entry[] {
  if (judged !== 'success') return failedAll(members, 'judge_failed', `The judge step ended ${judged || 'without running'}, so it gave no answer.`, spent);
  const verdicts = verdictsIn(members, answer);

  if (!verdicts.ok) return failedAll(members, 'judge_answer_invalid', verdicts.message, spent);

  if (!run) return failedAll(members, 'judge_failed', 'The judge step recorded no confined run, so what judged is unknown.', spent);

  return verdicts.verdicts.map(({ judged: member, label, reasoning }, index) => {
    const { usage, ...ran } = run;
    const judge: ScoreLabel['judge'] = { kind: 'model', ...ran };

    // The usage of one launch is counted once, on the first label.
    if (usage && index === 0) judge.usage = usage;

    if (members.length > 1) judge.batched = true;

    return { kind: 'labelled', scorer: member.name, label: labelOf(labelling, member, label, judge, 'judge'), reasoning };
  });
}

/** Why `label` is not one `member` gives on the group's subject, by hand when `byHand`. */
function labelProblem(group: GroupRecord, member: Member, label: ScoreLabel, byHand: boolean): string | undefined {
  const given = member.definition.labels.find((candidate) => candidate.value === label.label);

  if (label.scorer !== member.name || label.rubric.sourceHash !== member.pin.sourceHash) return `the label of ${member.name} is not of its pinned rubric`;

  if (!given || label.score !== given.score || label.passed !== given.score >= member.definition.passingScore) return `"${label.label}" with score ${label.score} is not a label of scorer ${member.name}`;

  if ((label.judge.kind === 'human') !== byHand) return `the label of ${member.name} ${byHand ? 'is not' : 'is'} a hand label, which only a run a person started gives`;

  return canonicalJson(label.subject) === canonicalJson(group.judged.subject) ? undefined : `the label of ${member.name} is of another subject`;
}

/** Why an entry is not the label its group may give: the same rules `label` built it by, read again. */
function entryProblem(group: GroupRecord, members: readonly Member[], entry: Entry, index: number): string | undefined {
  const member = members[index];

  if (!member || member.name !== entry.scorer) return `entry ${index + 1} is not of scorer ${member?.name ?? '(none)'}`;

  return entry.kind === 'failed' ? undefined : labelProblem(group, member, entry.label, group.hand);
}

/** The run of a pass subject, when it is still on this machine. */
async function subjectRun(attempt: ScoreAttempt, group: GroupRecord): Promise<RunState | undefined> {
  if (group.judged.kind !== 'run') return undefined;
  const found = await findRunConfig(group.judged.subject.runId, attempt.config);

  return 'run' in found ? found.run : undefined;
}

/** Whether the group's hand label is the person's: the instance has one, and a person started the root run. */
const isByHand = (attempt: ScoreAttempt, group: GroupRecord) => group.hand && attempt.hand !== '' && attempt.run.startedBy === 'person';

async function readEntries(dir: string): Promise<Entry[] | undefined> {
  return (await readRecord(path.join(dir, LABELS), LabelsFileSchema))?.entries;
}

/** The marks keys of `scorers` on `subject`; a session's are keyed by rubric too. */
function keysOf(subject: Subject, scorers: ReadonlyArray<{ name: string; pin?: PinnedScorer }>): MarkKey[] {
  return scorers.flatMap(({ name, pin }): MarkKey[] => {
    if (subject.kind === 'run') return [{ scorer: name, subject }];

    return pin ? [{ scorer: name, subject, sourceHash: pin.sourceHash }] : [];
  });
}

/**
 * Closes each key the attempt's root run holds open with its outcome; a key it does not hold, as a hand label's, is left
 * alone. A pass whose every mark is then closed, and no scorer its step lists waits for, has its evidence staged from a
 * clone removed: no judge reads it again.
 */
async function closeHeld(attempt: ScoreAttempt, outcomes: ReadonlyArray<{ key: MarkKey; outcome: MarkOutcome }>, now: string): Promise<{ ok: true; closed: number } | Refusal> {
  const facts = markFacts(attempt.config, now);
  const states = await Marks.states(attempt.config, outcomes.map(({ key }) => key), facts);

  const held = outcomes.filter((_, index) => {
    const state = states[index];

    return state?.kind === 'open' && state.run === attempt.run.id;
  });

  for (const { key, outcome } of held) {
    if ((await Marks.close(attempt.config, [key], outcome, facts)).status === 'busy') return refused('busy', 'Another teamai process is writing the scoring marks of this data home. Run the step again.');
  }

  await removeSubjectEvidence(scoresDir(attempt.config), await ScoreSubjects.settled(attempt.config, (await Marks.passes(attempt.config, facts)).closed, facts));

  return { ok: true, closed: held.length };
}

export const ScoreLabels = {
  /** The entries `label` left in the group directory `dir`, one per scorer; undefined when it wrote none. */
  read: readEntries,

  /**
   * The labels of the group in `dir`, written with their reasoning to `<dir>/labels.json`, and one entry per scorer
   * without it. A scorer with a check on a delivered pass is refused until its check stage recorded what it found.
   */
  async label(attempt: ScoreAttempt, dir: string, group: GroupRecord, { answer, judged, now }: { answer?: string; judged?: string; now: string }): Promise<{ ok: true; labels: LabelOutput[] } | Refusal> {
    const members = membersOf(group);
    const [first, ...rest] = members ?? [];

    if (!first) return refused('evidence_unreadable', `${dir} names a scorer that does not parse.`);

    if (group.hand && !isByHand(attempt, group)) return refused('hand_label_refused', `Run ${attempt.run.id} was not started by a person, so its label input is not a hand label.`);
    const run = await subjectRun(attempt, group);
    const labelling: Labelling = { attempt, group, run, now, hash: group.hand ? undefined : await evidenceHash(dir) };
    const records = await ScoreStage.records(dir);
    const unchecked = [first, ...rest].find((member) => member.definition.check && group.delivers && scorerStages(attempt, member.definition).includes('check'));

    if (!group.hand && unchecked && !records.some(({ stage }) => stage === 'check')) {
      return refused('stage_record_missing', `Scorer ${unchecked.name} has a check, and the delivered pass has no record of it in ${dir}: run teamai score stage check first.`);
    }

    const decided = records.flatMap(({ record }) => (record.kind === 'judge' ? [] : [record]))[0];
    let entries: Entry[];

    if (group.hand) {
      const given = first.definition.labels.find((label) => label.value === attempt.hand);

      if (!given) return refused('label_invalid', `"${attempt.hand}" is not a label of scorer ${first.name}. Use one of: ${first.definition.labels.map((label) => label.value).join(', ')}.`);
      entries = [{ kind: 'labelled', scorer: first.name, label: labelOf(labelling, first, given, { kind: 'human' }, undefined) }];
    } else if (decided) {
      entries = stageEntries(labelling, [first, ...rest], decided);
    } else {
      const step = judgeStepOf(attempt);

      entries = judgeEntries(labelling, [first, ...rest], { answer, judged, run: readJudgeRun(attempt.run, step), spent: judgeSpend(attempt.run, step) });
    }

    await writeFileAtomic(path.join(dir, LABELS), JSON.stringify({ entries }));

    return { ok: true, labels: entries.map((entry) => (entry.kind === 'labelled' ? { scorer: entry.scorer, label: entry.label.label, code: NONE } : { scorer: entry.scorer, label: NONE, code: entry.code })) };
  },

  /**
   * Writes the labels `label` left in `dir` to local storage, after checking each again; one that fails writes none. A
   * label of a private or isolated run stays out of the outbox, and an instance that only tries its labels writes none. Each scorer's mark the root run holds closes. Answers
   * the version of each label written, so a reader takes the labels this run wrote and no other run's.
   */
  async write(attempt: ScoreAttempt, dir: string, group: GroupRecord, { now }: { now: string }): Promise<{ ok: true; written: string[] } | Refusal> {
    const members = membersOf(group);
    const entries = await readEntries(dir);

    if (!members || !entries) return refused('evidence_unreadable', `${dir} holds no labels that teamai score label wrote. Run the label step first.`);

    if (group.hand && !isByHand(attempt, group)) return refused('hand_label_refused', `Run ${attempt.run.id} was not started by a person, so its label input is not a hand label.`);
    const problems = entries.length === members.length ? entries.flatMap((entry, index) => entryProblem(group, members, entry, index) ?? []) : ['the entries are not one per scorer of the group'];

    if (problems.length > 0) return refused('label_invalid', `${dir}/${LABELS} cannot be written: ${problems.join('; ')}. Nothing was written.`);

    // A tried label stays in labels.json, which the run's directory holds until the run is removed.
    if (!attempt.storesLabels) return { ok: true, written: [] };

    // Before the labels: what a generated question's label does is claimed once per session, so a retry adds nothing.
    if (group.judged.kind === 'session') {
      const generated = entries.flatMap((entry, index) => {
        const pin = group.scorers[index]?.pin;

        return entry.kind === 'labelled' && pin && GeneratedQuestions.isGenerated(entry.scorer) ? [{ scorer: entry.scorer, pin, passed: entry.label.passed }] : [];
      });

      await GeneratedQuestions.written(attempt.config, group.judged.subject, generated);
    }

    const run = await subjectRun(attempt, group);
    const keepLocal = group.judged.kind === 'run' && run !== undefined && (privateSteps(run)(group.judged.subject.step) || isIsolated(run));

    const written = await LabelStore.append(attempt.config, entries.flatMap((entry) => (entry.kind === 'labelled' ? [entry] : [])), { outbox: !keepLocal });

    if (written.status === 'busy') return refused('busy', 'Another teamai process holds the label store, so no label was written. Run the step again.');
    const subject = Subject.parse(group.subject);

    if (!subject.ok) return subject;

    const outcomes = entries.flatMap((entry, index) => keysOf(subject.subject, [group.scorers[index] ?? { name: entry.scorer }]).map((key) => ({
      key,
      outcome: entry.kind === 'labelled' ? { kind: 'labelled' } as const : entry.code === 'ci_pending' ? { kind: 'waiting' } as const : failedOutcome(entry.code, entry.usage),
    })));

    const closed = await closeHeld(attempt, outcomes, now);

    return closed.ok ? { ok: true, written: entries.flatMap((entry) => (entry.kind === 'labelled' ? [labelVersion(entry.label)] : [])) } : closed;
  },

  /** Records a failed attempt of each scorer the root run holds open on `subject`, so automatic judging does not start it again. */
  async settle(attempt: ScoreAttempt, subject: Subject, scorers: readonly string[], { now }: { now: string }): Promise<{ ok: true; settled: number } | Refusal> {
    if (attempt.hand !== '') return { ok: true, settled: 0 };
    const pins = subject.kind === 'run' ? {} : await plannedSessionPins(attempt, subject, scorers);
    const keys = keysOf(subject, scorers.map((name) => ({ name, pin: pins[name] })));
    const spent = judgeSpend(attempt.run, judgeStepOf(attempt));
    const closed = await closeHeld(attempt, keys.map((key, index) => ({ key, outcome: failedOutcome('judge_failed', index === 0 ? spent : undefined) })), now);

    return closed.ok ? { ok: true, settled: closed.closed } : closed;
  },
} as const;
