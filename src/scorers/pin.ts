import { z } from 'zod';
import { parseScorer, type ScorerDefinition } from './definition.js';
import { isRoutingScorer } from './skill-routing.js';

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
});
export type PinnedScorer = z.infer<typeof PinnedScorerSchema>;

/** The definition `pin` holds for scorer `name`, or undefined when this teamai cannot read it. A routing question's
 * generated name holds `:`s no file may, so it is read under the token form its name flattens to. */
export function pinnedDefinition(name: string, pin: PinnedScorer): ScorerDefinition | undefined {
  const file = `scorers/${isRoutingScorer(name) ? name.replaceAll(':', '-') : name}.md`;
  const parsed = parseScorer(file, pin.content);
  return parsed.ok ? { ...parsed.definition, name } : undefined;
}
