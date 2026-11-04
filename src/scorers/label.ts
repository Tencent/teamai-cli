/**
 * A score label: one judge's verdict on one subject under one rubric. Workflow passes (#1085) and sessions (#1178) share
 * this type, this parser, and the key that decides which label of a subject is current.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentObservationSchema, ObservedEffortSchema, ObservedModelSchema, UsedSchema } from '../agent-observation.js';
import { RunModeSchema } from '../launch-context.js';
import { ACCESS_LEVELS, CONFINED_LEVELS, ConfinedUsageSchema, type ConfinedUsage } from '../tool-launch/confined-level.js';
import { canonicalJson } from '../utils/canonical-json.js';
import type { JsonValue } from '../types.js';

export const RunSubjectSchema = z.object({ runId: z.string().min(1), step: z.string().min(1), pass: z.number().int().positive() });

export type RunSubject = z.infer<typeof RunSubjectSchema>;

export const SessionSubjectSchema = z.object({ platform: z.string().min(1), sessionId: z.string().min(1) });

export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

/** The spend of two judge calls together; a cost in another unit than the first is kept as the second reports it. */
export function sumUsage(first: ConfinedUsage | undefined, second: ConfinedUsage | undefined): ConfinedUsage | undefined {
  if (!first || !second) return first ?? second;
  const tokens = (left?: number, right?: number) => (left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0));
  const inputTokens = tokens(first.inputTokens, second.inputTokens);
  const outputTokens = tokens(first.outputTokens, second.outputTokens);
  const cost = first.cost && second.cost?.unit === first.cost.unit ? { amount: first.cost.amount + second.cost.amount, unit: first.cost.unit } : second.cost ?? first.cost;

  const sum: ConfinedUsage = {};

  if (inputTokens !== undefined) sum.inputTokens = inputTokens;

  if (outputTokens !== undefined) sum.outputTokens = outputTokens;

  if (cost) sum.cost = cost;

  return sum;
}

/**
 * A model judge names the tool it ran in, never the driver that ran that tool. A hand label names neither. Its `model`
 * and `effort` have an agent observation's shape: `requested` is what the judge was launched with, `reported` what its
 * tool reports, `alias` the scorer's model when it is an alias.
 */
export const ModelJudgeSchema = z.object({
  kind: z.literal('model'),
  tool: z.string().min(1),
  model: ObservedModelSchema.optional(),
  effort: ObservedEffortSchema.optional(),
  usage: ConfinedUsageSchema.optional(),
  isolation: z.enum(CONFINED_LEVELS),
  access: z.enum(ACCESS_LEVELS),
  batched: z.literal(true).optional(),
});

/** `stage`: a check, CI or protected-path stage decided a workflow label before any judge ran; its `decidedBy` says which. */
const JudgeSchema = z.discriminatedUnion('kind', [ModelJudgeSchema, z.object({ kind: z.literal('human') }), z.object({ kind: z.literal('stage') })]);

const LabelFields = {
  scorer: z.string().min(1),
  rubric: z.object({ sourceHash: z.string().min(1), teamRevision: z.string().optional() }),
  label: z.string().min(1),
  score: z.number(),
  passed: z.boolean(),
  judge: JudgeSchema,
  /** The run mode of the subject, never of the judge: the pass's for a pass, the session's for a session. Absent when unknown. */
  runMode: RunModeSchema.optional(),
  scoredAt: z.string().datetime(),
};

const SessionLabelSchema = z.object({
  ...LabelFields,
  source: z.literal('session'),
  subject: SessionSubjectSchema,
  agent: AgentObservationSchema.optional(),
  /** The team skills the session or its subagents loaded. */
  used: UsedSchema.optional(),
});

export type SessionLabel = z.infer<typeof SessionLabelSchema>;

/**
 * What settled a workflow label (#1247): the scorer's `check`, the delivered pull request's CI, the delivery's
 * protected-path refusal, each before any judge runs, or the judge.
 */
export const DECIDERS = ['check', 'ci', 'protected', 'judge'] as const;

export type Decider = (typeof DECIDERS)[number];

/**
 * Why a scorer got no label from a judge attempt. `check_could_not_run`: the scorer's check of a delivered pass (#1247)
 * could not start, was killed or timed out.
 */
export const JUDGE_FAILURES = ['judge_failed', 'lease_expired', 'evidence_empty', 'judge_answer_invalid', 'judge_tool_unavailable', 'check_could_not_run'] as const;

export type JudgeFailureCode = (typeof JUDGE_FAILURES)[number];

/**
 * Whether a check, CI or protected-path stage decided a label before any judge ran. A label from before #1247 has none: a
 * judge decided it. A label a stage decided records judge kind `stage`, or, written before teamai recorded that, kind
 * `model` naming the judge that would have run: both carry the stage in `decidedBy`.
 */
export function isStageDecider(by: Decider | undefined): boolean {
  return by !== undefined && by !== 'judge';
}

/** Whether a label of judge kind `stage` names the stage that decided it; a session label, which no stage decides, never does. */
function namesItsStage(label: { judge: { kind: string }; decidedBy?: Decider | undefined }): boolean {
  return label.judge.kind !== 'stage' || isStageDecider(label.decidedBy);
}

const STAGE_NAMED = { message: 'A label of judge kind stage names the check, ci or protected stage that decided it in decidedBy.', path: ['decidedBy'] };

/**
 * Unknown keys are dropped, so a label a newer teamai wrote still reads here. Judge kind `stage` needs the stage that
 * decided it; a stage `decidedBy` under a model judge stays valid, as earlier releases wrote it.
 */
export const ScoreLabelSchema = z.discriminatedUnion('source', [
  z.object({
    ...LabelFields,
    source: z.literal('workflow'),
    subject: RunSubjectSchema,
    /** What the judged work ran as: the pass's observation, or the one every prompt pass of a workflow step agrees on. */
    agent: AgentObservationSchema.optional(),
    /** The team skills the judged pass loaded, as its driver reported them. */
    used: UsedSchema.optional(),
    /** Absent on a label an older teamai wrote, which the judge decided. */
    decidedBy: z.enum(DECIDERS).optional(),
    /** `sha256:<hex>` of the evidence the label was decided on, so a rescore of unchanged evidence shows the same hash. */
    evidenceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  }).refine(namesItsStage, STAGE_NAMED),
  SessionLabelSchema.refine(namesItsStage, STAGE_NAMED),
]);

export type ScoreLabel = z.infer<typeof ScoreLabelSchema>;

/**
 * What a session label takes from one read of the session besides the verdict: the agent it ran as when its captures
 * agree on one, the team skills it used, and its redacted first prompt, which heads the label's reasoning file.
 */
export const SessionLabelContextSchema = SessionLabelSchema.pick({ agent: true, used: true, runMode: true }).required({ used: true }).extend({ prompt: z.string() });

export type SessionLabelContext = z.infer<typeof SessionLabelContextSchema>;

/** The label `value` holds, or undefined when it is not one. */
export function parseScoreLabel(value: JsonValue): ScoreLabel | undefined {
  const parsed = ScoreLabelSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/** The labels of a JSON Lines text, skipping lines that are not one, such as a line a crash cut short. */
export function parseScoreLabels(text: string): ScoreLabel[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];

    try {
      const label = parseScoreLabel(JSON.parse(line));

      return label ? [label] : [];
    } catch {
      return [];
    }
  });
}

/** A judge as labels and cohorts tell judges apart: a model judge by its tool and the model it recorded. */
export type JudgeCohort =
  | { kind: 'human' }
  | { kind: 'stage' }
  | { kind: 'model'; tool: string; model?: { id: string; isReported: boolean; alias?: string } };

function judgeCohort(judge: ScoreLabel['judge']): JudgeCohort {
  switch (judge.kind) {
    case 'human':
      return { kind: 'human' };
    case 'stage':
      return { kind: 'stage' };
    case 'model': {
      const id = judge.model?.reported ?? judge.model?.requested;

      return { kind: 'model', tool: judge.tool, model: id ? { id, isReported: judge.model?.reported !== undefined } : undefined };
    }

    default: {
      const unhandled: never = judge;

      return unhandled;
    }
  }
}

/** What a label's judge and key read of it: the scorer, rubric, subject and judge, and the stage that decided it, if one did. */
type KeyedLabel = Pick<ScoreLabel, 'scorer' | 'rubric' | 'subject' | 'judge'> & { decidedBy?: Decider | undefined };

/** The judge `label` counts under: `stage` when a stage decided it, whichever judge kind it recorded. */
export function labelJudge(label: Pick<KeyedLabel, 'judge' | 'decidedBy'>): JudgeCohort {
  return isStageDecider(label.decidedBy) ? { kind: 'stage' } : judgeCohort(label.judge);
}

/**
 * The logical key: a newer label with the same key replaces an older one. The judge is its cohort, so a model rescore
 * never replaces a hand label, and the label of one model judge never replaces another's. An outbox file named by an
 * older key is still read by its content.
 */
function labelKey(label: KeyedLabel): string {
  return canonicalJson({ scorer: label.scorer, sourceHash: label.rubric.sourceHash, subject: label.subject, judge: labelJudge(label) });
}

/** sha256 of the canonical logical key: the name of the label's outbox file. */
export function labelId(label: KeyedLabel): string {
  return createHash('sha256').update(labelKey(label)).digest('hex');
}

/**
 * Identifies this exact verdict, where `labelId` is shared by every label of the same key. Names the reasoning file, so
 * a newer label never overwrites an older one's reasoning.
 */
export function labelVersion(label: ScoreLabel): string {
  return createHash('sha256').update(canonicalJson(label)).digest('hex');
}

/** The newest `scoredAt` per key, in the order each key first appears. */
export function newestLabels(labels: Iterable<ScoreLabel>): ScoreLabel[] {
  const newest = new Map<string, ScoreLabel>();

  for (const label of labels) {
    const key = labelKey(label);
    const kept = newest.get(key);

    if (!kept || label.scoredAt > kept.scoredAt) newest.set(key, label);
  }

  return [...newest.values()];
}
