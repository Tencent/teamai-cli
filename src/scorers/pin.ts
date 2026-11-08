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
  /** The values a generated question's default scorer was filled in with, such as `{ 'doc.id': 'helm-values' }`. */
  variables: z.record(z.string(), z.string()).optional(),
  /**
   * Files the judge reads beside the transcript, by their path in the evidence directory, as the question was planned:
   * an adoption question's recalled document, so the judge reads the text the session was given (#1391).
   */
  evidence: z.record(z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/).refine((file) => !file.includes('..')), z.string()).optional(),
});

export type PinnedScorer = z.infer<typeof PinnedScorerSchema>;

/** The definition `pin` holds for scorer `name`, or undefined when this teamai cannot read it. A generated question's
 * name holds `:`s no file may, so it is read under the token form its name flattens to. */
export function pinnedDefinition(name: string, pin: PinnedScorer): ScorerDefinition | undefined {
  // A generated scorer's name is reserved: it has a character no scorer file name may have.
  const file = pin.generated ? 'scorers/correctness.md' : `scorers/${name.replaceAll(':', '-')}.md`;
  const parsed = parseScorer(file, pin.content);

  return parsed.ok ? { ...parsed.definition, name } : undefined;
}
