/**
 * Batches: the scorers of one pass that take the same model, stages and preferred tool share one judge call, one
 * evidence dir and one answer with a label per scorer.
 */
import { z } from 'zod';
import { canonicalJson } from '../utils/canonical-json.js';
import type { ScorerDefinition, ScorerLabel, Stage } from './definition.js';

/**
 * Whether a step's scorers share one judge call: the step's `scorers.batch`, else its workflow's
 * `defaults.scorers.batch`, else the team's `batch` in `scorers/scoring.yaml`, else they do not.
 */
export function batchesScorers(layers: { step?: boolean; workflow?: boolean; team?: boolean }): boolean {
  return layers.step ?? layers.workflow ?? layers.team ?? false;
}

/** What decides the judge call a scorer of a subject joins. */
export interface JudgeCallFacts {
  name: string;
  /** The model the scorer asks for; absent: the tool's default. */
  model?: string;
  /** The judge tool it prefers. */
  tool?: string;
  /** The one judge tool the run requires for it, as a benchmark plan does. */
  require?: string;
  stages: readonly Stage[];
  /** Whether it is judged in a launch of its own: its check runs for it alone, or its label decides a benchmark trial. */
  isAlone: boolean;
  /** The prefix of the generated question family it belongs to, whose questions share a call whatever `batch` says. */
  family?: string;
}

/**
 * The judge call a scorer joins, as a key two scorers in one call share: its own; under `batch`, that of the scorers
 * asking for its model, preferred tool, required tool and stages; and for a generated question, that of its family's
 * questions sharing its judge, which only `batch` lets team scorers join. The judge tool is chosen when the judge step
 * is leased, from what the driver offers, so a required and a preferred scorer never share a call.
 */
export function judgeCallKey({ name, model, tool, require, stages, isAlone, family }: JudgeCallFacts, batch: boolean): string {
  if (!(batch || family !== undefined) || isAlone) return `${name}\n`;
  const shared = canonicalJson({ model: model ?? null, tool: tool ?? null, require: require ?? null, stages: [...stages] });

  return family !== undefined && !batch ? `${family}\n${shared}` : shared;
}

const LabelAnswerSchema = z.object({ label: z.string().min(1), reasoning: z.string() });
const BatchAnswerSchema = z.record(z.string(), LabelAnswerSchema);

/** A judge's answer: `{ label, reasoning }` for one scorer, or `{ "<scorer>": { label, reasoning }, … }` for a batch. */
export const JudgeAnswerSchema = z.union([LabelAnswerSchema, BatchAnswerSchema]);

export type JudgeAnswer = z.infer<typeof JudgeAnswerSchema>;

export interface Verdict {
  scorer: string;
  label: ScorerLabel;
  passed: boolean;
  reasoning: string;
}

/**
 * The verdict for each of `judged`, in their order, or why `answer` gives none: a label a scorer does not list, a
 * scorer of the batch with no label, or an answer of the wrong shape. Nothing is kept unless every scorer has a label.
 */
export function verdictsOf<T>(
  judged: readonly [T, ...T[]],
  definitionOf: (judged: T) => ScorerDefinition,
  answer: JudgeAnswer,
): { ok: true; verdicts: Array<Verdict & { judged: T }> } | { ok: false; message: string } {
  const rubrics = judged.map(definitionOf);
  const batched = rubrics.length > 1;
  const single = LabelAnswerSchema.safeParse(answer);
  const batch = BatchAnswerSchema.safeParse(answer);

  const expectedAnswer = batched
    ? `{${rubrics.map((definition) => `"${definition.name}":{"label":…,"reasoning":…}`).join(',')}}`
    : '{"label":…,"reasoning":…}';

  const verdicts: Array<Verdict & { judged: T }> = [];

  for (const item of judged) {
    const definition = definitionOf(item);
    const given = batched ? (batch.success ? batch.data[definition.name] : undefined) : single.success ? single.data : undefined;

    if (!given) return { ok: false, message: `The answer has no label for scorer ${definition.name}. Answer ${expectedAnswer}. The lease stays open.` };
    const label = definition.labels.find((candidate) => candidate.value === given.label);

    if (!label) {
      return { ok: false, message: `"${given.label}" is not a label of scorer ${definition.name}. Use one of: ${definition.labels.map((candidate) => candidate.value).join(', ')}. The lease stays open.` };
    }

    verdicts.push({ judged: item, scorer: definition.name, label, passed: label.score >= definition.passingScore, reasoning: given.reasoning });
  }

  return { ok: true, verdicts };
}
