/**
 * What a session, a workflow step's pass or a run delivered (#1387): commits, pull requests and learnings. A session's
 * outcomes stay on this machine as dashboard events; a pass carries its own in the run record; the report publishes
 * counts only.
 */
import { z } from 'zod';
import { RunModeSchema } from './launch-context.js';
import { PrUrlSchema } from './workflow/pr-url.js';

export const WorkOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), sha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/) }),
  z.object({ kind: z.literal('pr'), url: PrUrlSchema }),
  z.object({ kind: z.literal('learning'), id: z.string().min(1) }),
]);
export type WorkOutcome = z.infer<typeof WorkOutcomeSchema>;
export type OutcomeKind = WorkOutcome['kind'];

/** The rows of the usage report's `outcomes` under a run mode, in the order they are shown: each kind, then `none`. */
export const OUTCOME_ROWS = ['pr', 'commit', 'learning', 'none'] as const satisfies ReadonlyArray<OutcomeKind | 'none'>;

/** `outcomes` with each outcome once, in the order it first appears. */
export function uniqueOutcomes(outcomes: Iterable<WorkOutcome>): WorkOutcome[] {
  const seen = new Map<string, WorkOutcome>();
  for (const outcome of outcomes) {
    const key = `${outcome.kind}\0${outcomeValue(outcome)}`;
    if (!seen.has(key)) seen.set(key, outcome);
  }
  return [...seen.values()];
}

/** What names `outcome`: a commit's sha, a pull request's URL, a learning's id. */
export function outcomeValue(outcome: WorkOutcome): string {
  switch (outcome.kind) {
    case 'commit': return outcome.sha;
    case 'pr': return outcome.url;
    case 'learning': return outcome.id;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** A learning's id: its path under `learnings/` without `.md`, so a namespaced learning keeps its namespace. */
export function learningIdOf(relPath: string): string {
  return relPath.replace(/\.md$/, '');
}

/**
 * One line of the dashboard event log naming outcomes of a session: a learning `contribute` recorded for it, or what
 * the usage report found once the session was finished, with what it counted the session with (`counted`). `runMode`
 * and `launchedBy` are the session's own, set only by a writer that runs in that session.
 */
export const SessionOutcomeEventSchema = z.object({
  type: z.literal('session_outcome'),
  timestamp: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1).optional(),
  dataHomeKey: z.string().min(1).optional(),
  runMode: RunModeSchema.optional(),
  launchedBy: z.string().min(1).optional(),
  outcomes: z.array(WorkOutcomeSchema),
  counted: z.object({
    tokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
    interventions: z.number().int().nonnegative(),
  }).optional(),
});
export type SessionOutcomeEvent = z.infer<typeof SessionOutcomeEventSchema>;
