/** The names, team assets, limits and check files a benchmark plan records. Zod and the commit schema only. */
import { z } from 'zod';
import { CommitSchema, TeamPathSchema } from '../workflow/clone.js';

/**
 * A task or arm name. It becomes one step-path segment, one expression path field and part of a branch name, so it has
 * no "." and no "[".
 */
export const BENCHMARK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const BenchmarkNameSchema = z.string().regex(BENCHMARK_NAME, 'must be letters, digits, "-" or "_", with no "."');

/**
 * The team assets of an arm's trials, as start resolved the suite's `team`: the revision this checkout pulled, a ref of
 * the team repo at the commit it named then, the pulled revision without some of its paths, sorted, or none.
 */
export const ArmTeamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pulled'), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('ref'), ref: z.string().min(1), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('without'), paths: z.tuple([TeamPathSchema], TeamPathSchema), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export type ArmTeam = z.infer<typeof ArmTeamSchema>;

/**
 * The skills whose directory differs between the team revision an arm's trials get and the run's baseline: added,
 * removed or changed under skills/. `defaults` is the arm that changes no defaults key, whose loads the table sets beside
 * the arm's; absent when the suite has none.
 */
export const SkillChangesSchema = z.object({
  arm: BenchmarkNameSchema,
  defaults: BenchmarkNameSchema.optional(),
  skills: z.array(z.object({ name: z.string().min(1), change: z.enum(['added', 'removed', 'changed']) }).strict()).nonempty(),
}).strict();
export type SkillChanges = z.infer<typeof SkillChangesSchema>;

/**
 * The limits a suite's `trial` sets on every trial's prompt, as the record keeps them; an absent key is no limit. Each
 * prompt carries them under `on_limit: end_turn`, so reaching one ends the agent's turn, and the trial's check or judge
 * still decides it.
 */
export const TrialLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  /** Input plus output tokens, as a workflow budget counts them. */
  tokens: z.number().int().positive().optional(),
  /** Agent turns, as the tool counts them. */
  maxTurns: z.number().int().positive().optional(),
}).strict();
export type TrialLimits = z.infer<typeof TrialLimitsSchema>;

/**
 * Files a check task's `check.add` writes before each run of its check, as `commit` has them: its fix, or the commit
 * start made of the files it names in the suite directory, as `kind` says.
 */
export const AddedSchema = z.object({ kind: z.enum(['fix', 'suite']), commit: CommitSchema, paths: z.array(z.string().min(1)).nonempty() }).strict();
export type Added = z.infer<typeof AddedSchema>;

