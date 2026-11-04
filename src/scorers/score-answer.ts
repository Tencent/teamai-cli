/**
 * What `teamai score` answers once the local driver drove the teamai-score run it started: the labels the run wrote for
 * the scorers the person named, or, when one got none, the code that says why, beside the labels the others got.
 */
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import type { StepState } from '../workflow/step-state.js';
import { readRun } from '../workflow/store.js';
import type { RunState, WorkflowEnvelope } from '../workflow/types.js';
import { labelId, labelVersion, type ScoreLabel } from './label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from './label-store.js';
import { LABEL_CODES } from './score-labels.js';
import { ScoreItem } from './judging-workflows.js';

const DoneSchema = z.object({ outcome: z.string() });

const LabelEntriesSchema = z.object({ labels: z.array(z.object({ scorer: z.string(), label: z.string(), code: z.string() })) });

const WrittenSchema = z.object({ labels: z.array(z.string()) });

const GroupsSchema = z.object({ groups: z.array(z.object({ scorers: z.string() })) });

/** Why a scorer of the run got no label, as the member reads it, for each code its label step gives. */
const UNLABELLED: Record<(typeof LABEL_CODES)[number], string> = {
  check_could_not_run: 'its check could not run, so no judge ran',
  ci_pending: 'the CI of its pull request has not finished; the next teamai score --drain labels it once CI finishes',
  judge_failed: 'its judge failed',
  judge_answer_invalid: 'its judge answered outside the answer schema',
  judge_tool_unavailable: 'no judge tool here runs it',
  evidence_empty: 'nothing of its transcript or diff was kept, so there was nothing to judge',
  lease_expired: 'an earlier teamai\'s judge lease lapsed before anyone answered it',
};

const LabelCodeSchema = z.enum(LABEL_CODES);

const NOT_PLANNED = 'it was not planned: another teamai-score run holds its judge work';

const OPEN = new Set(['pending', 'waiting', 'leased', 'running']);

/** What the label step of one item gave a scorer, with what its judge step said when that failed. */
type Entry = z.infer<typeof LabelEntriesSchema>['labels'][number] & { why: string | undefined };

/** How the item of one plan group stands: a step still open for a driver, a step that broke, or every step done. */
type ItemEnd = { kind: 'open' } | { kind: 'broke'; why: string } | { kind: 'done' };

interface Item {
  entries: ReadonlyMap<string, Entry>;
  /** The version of each label its write step wrote. */
  written: ReadonlySet<string>;
  end: ItemEnd;
}

type Unlabelled = { scorer: string; kind: 'unlabelled'; code: string; message: string };

type Outcome = Unlabelled | { scorer: string } & ({ kind: 'labelled'; label: ScoreLabel } | { kind: 'pending' });

/** What a step that failed or was cancelled says of why; undefined for any other step. */
function reasonOf(step: StepState | undefined): string | undefined {
  return step?.status === 'failed' || step?.status === 'cancelled' ? step.failure?.message : undefined;
}

/** What the label step of plan group `index` gave each scorer, by scorer, with why its judge failed when it did. */
function entriesOf(steps: readonly StepState[], index: number): Map<string, Entry> {
  const labelled = steps.find((step) => step.id === ScoreItem.stepOf(index, 'label'));
  const why = reasonOf(steps.find((step) => step.id === ScoreItem.stepOf(index, 'judge')));
  const listed = LabelEntriesSchema.safeParse(labelled?.status === 'succeeded' ? labelled.outputs : undefined).data?.labels ?? [];

  return new Map(listed.map((entry): [string, Entry] => [entry.scorer, { ...entry, why }]));
}

/** How `steps`, the steps of one item, stand. */
function endOf(steps: readonly StepState[]): ItemEnd {
  if (steps.some((step) => OPEN.has(step.status))) return { kind: 'open' };
  const broke = steps.find((step) => step.status === 'failed' || step.status === 'cancelled');

  if (!broke) return { kind: 'done' };
  const reason = reasonOf(broke);

  return { kind: 'broke', why: `step ${broke.id} ${broke.status}${reason === undefined ? '' : `: ${reason}`}` };
}

/** The item of plan group `index` in `run`. */
function itemOf(run: RunState, index: number): Item {
  const steps = run.steps.filter((step) => step.id.startsWith(`score[${index}].`));

  const write = steps.find((step) => step.id === ScoreItem.stepOf(index, 'write'));
  const written = new Set(WrittenSchema.safeParse(write?.status === 'succeeded' ? write.outputs : undefined).data?.labels ?? []);

  return { entries: entriesOf(steps, index), written, end: endOf(steps) };
}

/** What a scorer the run gave no label, and no code, gets from how its item stands. */
function unwritten(scorer: string, end: ItemEnd): Outcome {
  switch (end.kind) {
    case 'open':
      return { scorer, kind: 'pending' };
    case 'broke':
      return { scorer, kind: 'unlabelled', code: 'score_step_failed', message: end.why };
    case 'done':
      return { scorer, kind: 'unlabelled', code: 'score_step_failed', message: 'the run wrote no label for it' };
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}

/** What `scorer` gets from the code its label step gave it. */
function coded(scorer: string, entry: Entry): Outcome {
  const why = entry.why === undefined ? '' : `: ${entry.why}`;

  const known = LabelCodeSchema.safeParse(entry.code);

  return { scorer, kind: 'unlabelled', code: entry.code, message: `${known.success ? UNLABELLED[known.data] : entry.code}${why}` };
}

/** What `scorer` got from `item`, its group's item, whose write step wrote the labels of `stored` it names. */
function outcomeOf(scorer: string, item: Item | undefined, stored: readonly ScoreLabel[]): Outcome {
  if (item === undefined) return { scorer, kind: 'unlabelled', code: 'not_planned', message: NOT_PLANNED };
  const entry = item.entries.get(scorer);

  if (entry && entry.code !== '') return coded(scorer, entry);
  const label = stored.find((one) => one.scorer === scorer && item.written.has(labelVersion(one)));

  return entry && label ? { scorer, kind: 'labelled', label } : unwritten(scorer, item.end);
}

/** What run `run` gave each scorer the person named: a label it wrote, a code, or a judge step still open. */
function outcomesOf(run: RunState, scorers: readonly string[], stored: readonly ScoreLabel[]): Outcome[] {
  const plan = run.steps.find((step) => step.id === 'plan');
  const groups = GroupsSchema.safeParse(plan?.status === 'succeeded' ? plan.outputs : undefined).data?.groups ?? [];
  const items = new Map(groups.flatMap((group, index) => group.scorers.split(',').map((name): [string, Item] => [name, itemOf(run, index)])));

  return scorers.map((scorer) => outcomeOf(scorer, items.get(scorer), stored));
}

/** What the answer of teamai score carries of one label it wrote. */
type LabelAnswer = Pick<ScoreLabel, 'scorer' | 'subject' | 'label' | 'score' | 'passed'> & {
  labelId: string;
  judge: { kind: 'human' } | { kind: 'stage' } | { kind: 'model'; tool: string };
  decidedBy?: string;
  reasoning?: string;
};

/** The labels the run kept, as the answer carries them and as its message names them. */
interface Kept {
  labels: LabelAnswer[];
  text: string;
}

/** What the person reads of one label, and what the answer carries of it. */
function answerOf(config: LocalConfig, label: ScoreLabel): LabelAnswer {
  const verdict = `${label.label} (score ${label.score}, ${label.passed ? 'passed' : 'did not pass'})`;
  const answer: LabelAnswer = { scorer: label.scorer, subject: label.subject, label: label.label, score: label.score, passed: label.passed, labelId: labelId(label), judge: { kind: 'human' } };

  if (label.judge.kind === 'human') {
    log.info(`${label.scorer}: ${verdict}, by hand. No judge ran.`);

    return answer;
  }

  const reasoning = reasoningPath(config, labelVersion(label));
  log.info(`${label.scorer}: ${verdict}. Reasoning: ${reasoning}`);

  if (!label.passed) log.info(shareFailedLabelHint(reasoning, label.source === 'session' ? label.subject.sessionId : undefined));
  answer.judge = label.judge.kind === 'stage' ? { kind: 'stage' } : { kind: 'model', tool: label.judge.tool };
  answer.reasoning = reasoning;

  if (label.source === 'workflow' && label.decidedBy) answer.decidedBy = label.decidedBy;

  return answer;
}

/** The answer while the judge of `pending` waits for a driver: `held` says why the local driver left it open. */
function pendingAnswer(runId: string, pending: readonly string[], held: string, kept: Kept): WorkflowEnvelope {
  return { error: { code: 'judge_pending', message: `Run ${runId} left the judge of ${pending.join(', ')} open for a driver that can run it: ${held} The run waits for one until its timeout, and teamai score --drain lists it.${kept.text}`, labels: kept.labels } };
}

/** The answer of a run with no judge left open: the code of each scorer that got no label, else the labels. */
function settledAnswer(runId: string, unlabelled: readonly Unlabelled[], kept: Kept): WorkflowEnvelope {
  const [first] = unlabelled;

  if (first === undefined) {
    const [only, ...more] = kept.labels;

    return { data: only && more.length === 0 ? { run: runId, label: only } : { run: runId, labels: kept.labels } };
  }

  for (const one of unlabelled) log.warn(`${one.scorer}: no label, ${one.message}`);

  return { error: { code: first.code, message: `Run ${runId}: ${unlabelled.map((one) => `${one.scorer} got no label (${one.code}): ${one.message.replace(/\.$/u, '')}.`).join(' ')}${kept.text}`, labels: kept.labels } };
}

/** The answer for `outcomes` of run `runId`; `held`: why the local driver left a confined step open, when it did. */
function envelopeOf(config: LocalConfig, runId: string, outcomes: readonly Outcome[], held: string | undefined): WorkflowEnvelope {
  const written = outcomes.flatMap((outcome) => (outcome.kind === 'labelled' ? [outcome.label] : []));
  const text = written.length > 0 ? ` Kept the label of ${written.map((label) => `${label.scorer}: ${label.label}`).join(', ')}.` : '';
  const kept: Kept = { labels: written.map((label) => answerOf(config, label)), text };

  // Only a run the local driver left holding a judge step has one open: a run that succeeded has none.
  if (held !== undefined) return pendingAnswer(runId, outcomes.flatMap((outcome) => (outcome.kind === 'pending' ? [outcome.scorer] : [])), held, kept);

  return settledAnswer(runId, outcomes.flatMap((outcome) => (outcome.kind === 'unlabelled' ? [outcome] : [])), kept);
}

/**
 * The answer for the scorers the person named of teamai-score run `runId`, which the local driver answered `driven`.
 * Undefined when the run did not end succeeded and no confined step holds it, so the driver's own answer is printed.
 */
async function of(config: LocalConfig, runId: string, driven: WorkflowEnvelope, scorers: readonly string[]): Promise<WorkflowEnvelope | undefined> {
  const held = 'error' in driven && driven.error.code === 'confined_pending' ? driven.error.message : undefined;
  const succeeded = 'data' in driven && DoneSchema.safeParse(driven.data.done).data?.outcome === 'succeeded';

  if (held === undefined && !succeeded) return undefined;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return undefined;

  return envelopeOf(config, runId, outcomesOf(run, scorers, await LabelStore.local(config)), held);
}

export const ScoreAnswer = { of } as const;
