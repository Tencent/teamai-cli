/**
 * A score label: one judge's verdict on one subject under one rubric. Workflow passes (#1085) and sessions (#1178) share
 * this type, this parser, and the key that decides which label of a subject is current.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentObservationSchema, ObservedEffortSchema, ObservedModelSchema, UsedSchema } from '../agent-observation.js';
import { canonicalJson } from '../utils/canonical-json.js';

export const RunSubjectSchema = z.object({ runId: z.string().min(1), step: z.string().min(1), pass: z.number().int().positive() });
export type RunSubject = z.infer<typeof RunSubjectSchema>;

const SessionSubjectSchema = z.object({ platform: z.string().min(1), sessionId: z.string().min(1) });

/** What the judge's tool reports it used, as far as it reports it. `cost` is in the tool's own unit. */
export const JudgeUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  cost: z.object({ amount: z.number().finite().nonnegative(), unit: z.string().min(1) }).optional(),
});
export type JudgeUsage = z.infer<typeof JudgeUsageSchema>;

/** The spend of two judge calls together; a cost in another unit than the first is kept as the second reports it. */
export function sumUsage(first: JudgeUsage | undefined, second: JudgeUsage | undefined): JudgeUsage | undefined {
  if (!first || !second) return first ?? second;
  const tokens = (left?: number, right?: number) => (left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0));
  const inputTokens = tokens(first.inputTokens, second.inputTokens);
  const outputTokens = tokens(first.outputTokens, second.outputTokens);
  const cost = first.cost && second.cost?.unit === first.cost.unit ? { amount: first.cost.amount + second.cost.amount, unit: first.cost.unit } : second.cost ?? first.cost;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cost ? { cost } : {}) };
}

export const ISOLATIONS = ['best-effort', 'verified'] as const;
export type Isolation = (typeof ISOLATIONS)[number];
export const ACCESS_LEVELS = ['answer', 'read', 'full'] as const;
export type JudgeAccess = (typeof ACCESS_LEVELS)[number];

/**
 * A model judge names the tool it ran in, never the driver that ran that tool. A hand label names neither. Its `model`
 * and `effort` have an agent observation's shape: `requested` is what the judge was launched with, `reported` what its
 * tool reports, `alias` the scorer's model when it is an alias.
 */
const JudgeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    tool: z.string().min(1),
    model: ObservedModelSchema.optional(),
    effort: ObservedEffortSchema.optional(),
    usage: JudgeUsageSchema.optional(),
    isolation: z.enum(ISOLATIONS),
    access: z.enum(ACCESS_LEVELS),
    batched: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal('human') }),
]);

const LabelFields = {
  scorer: z.string().min(1),
  rubric: z.object({ sourceHash: z.string().min(1), teamRevision: z.string().optional() }),
  label: z.string().min(1),
  score: z.number(),
  passed: z.boolean(),
  judge: JudgeSchema,
  scoredAt: z.string().datetime(),
};

/** Unknown keys are dropped, so a label a newer teamai wrote still reads here. */
export const ScoreLabelSchema = z.discriminatedUnion('source', [
  z.object({
    ...LabelFields,
    source: z.literal('workflow'),
    subject: RunSubjectSchema,
    /** The team skills the judged pass loaded, as its driver reported them. */
    used: UsedSchema.optional(),
  }),
  z.object({
    ...LabelFields,
    source: z.literal('session'),
    subject: SessionSubjectSchema,
    agent: AgentObservationSchema.optional(),
    /** The team skills the session or its subagents loaded. */
    used: UsedSchema.optional(),
  }),
]);
export type ScoreLabel = z.infer<typeof ScoreLabelSchema>;

/** The label `value` holds, or undefined when it is not one. */
export function parseScoreLabel(value: unknown): ScoreLabel | undefined {
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

/** The logical key: a newer label with the same key replaces an older one, so a model rescore never replaces a hand label. */
function labelKey(label: Pick<ScoreLabel, 'scorer' | 'rubric' | 'subject' | 'judge'>): string {
  return canonicalJson({ scorer: label.scorer, sourceHash: label.rubric.sourceHash, subject: label.subject, judge: label.judge.kind });
}

/** sha256 of the canonical logical key: the name of the label's outbox file. */
export function labelId(label: Pick<ScoreLabel, 'scorer' | 'rubric' | 'subject' | 'judge'>): string {
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
