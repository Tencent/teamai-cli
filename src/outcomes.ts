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
