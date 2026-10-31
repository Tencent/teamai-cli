import { z } from 'zod';
import { parseScorer, type ScorerDefinition } from './definition.js';

/**
 * A scorer as a run pinned it when it started: the file's text, so a later pull that edits the rubric does not change
 * what judges the run's passes. The text is parsed again on use, like the scorer cache does.
 */
export const PinnedScorerSchema = z.object({
  sourceHash: z.string().min(1),
  teamRevision: z.string().optional(),
  /** The file it was read from, such as `scorers/ops/<name>.md`; older runs have none. */
  relativePath: z.string().optional(),
  content: z.string(),
  /** Built by teamai for one run, such as a benchmark task's correctness scorer: no team file has it, and its key names it. */
  generated: z.literal(true).optional(),
});
export type PinnedScorer = z.infer<typeof PinnedScorerSchema>;

/** The definition `pin` holds for scorer `name`, or undefined when this teamai cannot read it. */
export function pinnedDefinition(name: string, pin: PinnedScorer): ScorerDefinition | undefined {
  // A generated name is reserved: it has a character no scorer file name may have.
  const parsed = parseScorer(pin.generated ? 'scorers/correctness.md' : `scorers/${name}.md`, pin.content);
  if (!parsed.ok) return undefined;
  return pin.generated ? { ...parsed.definition, name } : parsed.definition;
}
