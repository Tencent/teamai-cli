/**
 * What `teamai score` answers once the local driver drove the teamai-score run it started: the labels the run wrote for
 * the scorers the person named, or, when one got none, the code that says why, beside the labels the others got.
 */
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { readRun } from '../workflow/store.js';
import type { RunState, WorkflowEnvelope } from '../workflow/types.js';
import { labelId, labelVersion, type ScoreLabel } from './label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from './label-store.js';

const DoneSchema = z.object({ outcome: z.string() });

const LabelEntriesSchema = z.object({ labels: z.array(z.object({ scorer: z.string(), label: z.string(), code: z.string() })) });

const GroupsSchema = z.object({ groups: z.array(z.object({ scorers: z.string() })) });

const NOT_PLANNED = 'it was not planned: another teamai-score run holds its judge work';

/** Why a scorer of the run got no label, as the member reads it. */
const UNLABELLED = new Map([
  ['check_could_not_run', 'its check could not run, so no judge ran'],
  ['ci_pending', 'the CI of its pull request has not finished; the next teamai score --drain labels it once CI finishes'],
  ['judge_failed', 'its judge failed'],
  ['judge_answer_invalid', 'its judge answered outside the answer schema'],
  ['judge_tool_unavailable', 'no judge tool here runs it'],
  ['not_planned', NOT_PLANNED],
]);

type Outcome = { scorer: string } & ({ kind: 'labelled'; label: ScoreLabel | undefined; value: string } | { kind: 'unlabelled'; code: string; message: string } | { kind: 'pending' });

/** What run `run` gave each scorer the person named: a label, a code, or a judge step still open. */
function outcomesOf(run: RunState, scorers: readonly string[], stored: readonly ScoreLabel[]): Outcome[] {
  const plan = run.steps.find((step) => step.id === 'plan');
  const groups = GroupsSchema.safeParse(plan?.status === 'succeeded' ? plan.outputs : undefined).data?.groups ?? [];
  const entries = new Map<string, { label: string; code: string; why?: string }>();
  const settled = new Map<string, string | undefined>();

  groups.forEach((group, index) => {
    const inItem = run.steps.filter((step) => step.id.startsWith(`score[${index}].`));
    const labelled = inItem.find((step) => step.id === `score[${index}].label`);
    const listed = LabelEntriesSchema.safeParse(labelled?.status === 'succeeded' ? labelled.outputs : undefined);

    const judge = inItem.find((step) => step.id === `score[${index}].judge`);
    const why = judge && 'message' in judge && judge.message ? judge.message : undefined;

    for (const entry of listed.data?.labels ?? []) entries.set(entry.scorer, why === undefined || entry.code !== 'judge_failed' ? entry : { ...entry, why });
    const broke = inItem.find((step) => step.status === 'failed' || step.status === 'cancelled');
    const open = inItem.some((step) => ['pending', 'waiting', 'leased', 'running'].includes(step.status));

    for (const name of group.scorers.split(',')) settled.set(name, open ? undefined : broke ? `step ${broke.id} ${broke.status}${'message' in broke && broke.message ? `: ${broke.message}` : ''}` : '');
  });

  return scorers.map((scorer): Outcome => {
    const entry = entries.get(scorer);

    if (entry && entry.code === '') {
      const label = stored.filter((one) => one.scorer === scorer && one.scoredAt >= run.createdAt).sort((left, right) => (left.scoredAt < right.scoredAt ? 1 : -1))[0];

      return { scorer, kind: 'labelled', label, value: entry.label };
    }

    if (entry) return { scorer, kind: 'unlabelled', code: entry.code, message: `${UNLABELLED.get(entry.code) ?? entry.code}${entry.why === undefined ? '' : `: ${entry.why}`}` };

    if (!settled.has(scorer)) return { scorer, kind: 'unlabelled', code: 'not_planned', message: NOT_PLANNED };
    const broke = settled.get(scorer);

    if (broke === undefined) return { scorer, kind: 'pending' };

    return { scorer, kind: 'unlabelled', code: 'score_step_failed', message: broke === '' ? 'the run wrote no label for it' : broke };
  });
}

/** What the answer of teamai score carries of one label it wrote. */
type LabelAnswer = Pick<ScoreLabel, 'scorer' | 'subject' | 'label' | 'score' | 'passed'> & {
  labelId: string;
  judge: { kind: 'human' } | { kind: 'model'; tool: string };
  decidedBy?: string;
  reasoning?: string;
};

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
  answer.judge = { kind: 'model', tool: label.judge.tool };
  answer.reasoning = reasoning;

  if (label.source === 'workflow' && label.decidedBy) answer.decidedBy = label.decidedBy;

  return answer;
}

/**
 * The answer for the scorers the person named of teamai-score run `runId`, which the local driver answered `driven`:
 * the labels it wrote, or, when a scorer got none, the code that says why, with the labels the others got. Undefined
 * when the run did not end succeeded and no confined step holds it, so the driver's own answer is printed.
 */
async function of(config: LocalConfig, runId: string, driven: WorkflowEnvelope, scorers: readonly string[]): Promise<WorkflowEnvelope | undefined> {
  const held = 'error' in driven && driven.error.code === 'confined_pending' ? driven.error.message : undefined;

  if (held === undefined && ('error' in driven || DoneSchema.safeParse(driven.data.done).data?.outcome !== 'succeeded')) return undefined;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return undefined;
  const outcomes = outcomesOf(run, scorers, await LabelStore.local(config));
  const labels = outcomes.flatMap((outcome) => (outcome.kind === 'labelled' && outcome.label ? [answerOf(config, outcome.label)] : outcome.kind === 'labelled' ? [{ scorer: outcome.scorer, label: outcome.value }] : []));
  const kept = outcomes.flatMap((outcome) => (outcome.kind === 'labelled' ? [`${outcome.scorer}: ${outcome.value}`] : []));
  const keeping = kept.length > 0 ? ` Kept the label of ${kept.join(', ')}.` : '';
  const pending = outcomes.filter((outcome) => outcome.kind === 'pending').map((outcome) => outcome.scorer);

  if (held !== undefined || pending.length > 0) {
    return { error: { code: 'judge_pending', message: `Run ${runId} left the judge of ${pending.join(', ') || 'a scorer'} open for a driver that can run it: ${held ?? 'its judge step is still open'} The run waits for one until its timeout, and teamai score --drain lists it.${keeping}`, labels } };
  }

  const unlabelled = outcomes.flatMap((outcome) => (outcome.kind === 'unlabelled' ? [outcome] : []));
  const [first] = unlabelled;

  if (first) {
    for (const one of unlabelled) log.warn(`${one.scorer}: no label, ${one.message}`);

    return { error: { code: first.code, message: `Run ${runId}: ${unlabelled.map((one) => `${one.scorer} got no label (${one.code}): ${one.message}.`).join(' ')}${keeping}`, labels } };
  }

  const [only, ...more] = labels;

  return { data: only && more.length === 0 ? { run: runId, label: only } : { run: runId, labels } };
}

export const ScoreAnswer = { of } as const;
